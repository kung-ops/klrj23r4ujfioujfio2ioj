'use strict';

// End-to-end: fake Android (speaks the scrcpy 5.0.1 protocol) <-> real server code <-> fake iPhone.

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { Hub } = require('../lib/hub');
const { ScrcpySession, CODEC_H264, AUDIO_RAW } = require('../lib/scrcpy');
const { ClientConnection } = require('../lib/client');
const { Files } = require('../lib/files');
const { C2S, S2C, NAV, FrameParser, encode } = require('../lib/protocol');
const os = require('os');

const SPS_PPS = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80]);
const IDR = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(3000, 7)]);

function pktHeader(hi, len) {
  const h = Buffer.alloc(12);
  h.writeUInt32BE(hi >>> 0, 0);
  h.writeUInt32BE(len, 8);
  return h;
}

function fakeAndroid() {
  const control = [];
  let controlSock = null;
  let n = 0;
  const srv = net.createServer((s) => {
    n++;
    if (n === 1) {
      const name = Buffer.alloc(64);
      name.write('FakeDroid');
      const codec = Buffer.alloc(4);
      codec.writeUInt32BE(CODEC_H264);
      const session = Buffer.alloc(12);
      session.writeUInt32BE(0x80000000, 0);
      session.writeUInt32BE(720, 4);
      session.writeUInt32BE(1280, 8);
      const all = Buffer.concat([Buffer.from([0]), name, codec, session, pktHeader(0x40000000, SPS_PPS.length), SPS_PPS, pktHeader(0x20000000, IDR.length), IDR]);
      // send in awkward pieces to exercise the parser
      let off = 0;
      const step = () => {
        if (off >= all.length) return;
        const len = Math.min(1 + Math.floor(Math.random() * 700), all.length - off);
        s.write(all.subarray(off, off + len));
        off += len;
        setImmediate(step);
      };
      step();
    } else if (n === 2) {
      const codec = Buffer.alloc(4);
      codec.writeUInt32BE(AUDIO_RAW);
      s.write(Buffer.concat([codec, pktHeader(0, 4096), Buffer.alloc(4096, 1)]));
    } else if (n === 3) {
      controlSock = s;
      s.on('data', (d) => control.push(d));
    }
    s.on('error', () => {});
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve({
        port: srv.address().port,
        controlBytes: () => Buffer.concat(control),
        sendClipboard(text) {
          const t = Buffer.from(text);
          const h = Buffer.alloc(5);
          h[0] = 0;
          h.writeUInt32BE(t.length, 1);
          controlSock.write(Buffer.concat([h, t]));
        },
        close: () => srv.close(),
      }),
    ),
  );
}

function fakeIphone(port, pin) {
  const frames = [];
  const waiters = [];
  const sock = net.connect(port, '127.0.0.1');
  const parser = new FrameParser((type, payload) => {
    frames.push({ type, payload });
    for (const w of waiters.splice(0)) w();
  });
  sock.on('data', (d) => parser.push(d));
  sock.on('error', () => {});
  sock.write(encode(C2S.HELLO, { pin, client: 'test', version: 1, device: 'iPhone7,2' }));
  return {
    sock,
    frames,
    send: (t, p) => sock.write(encode(t, p)),
    async waitFor(pred, ms = 5000) {
      const end = Date.now() + ms;
      for (;;) {
        const f = frames.find(pred);
        if (f) return f;
        if (Date.now() > end) throw new Error('timeout waiting for message; got ' + frames.map((x) => x.type.toString(16)).join(','));
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 100);
        });
      }
    },
  };
}

async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('stream, touch, keys, text, clipboard, auth', async () => {
  const android = await fakeAndroid();
  const config = { pin: '424242', name: 'TestBox', port: 0, stream: { audio: true }, dataDir: os.tmpdir() };
  const hub = new Hub({ config, sessionFactory: () => new ScrcpySession({ connectPort: android.port, stream: { audio: true } }) });
  const files = new Files({ dataDir: os.tmpdir() });
  const server = net.createServer((s) => new ClientConnection(s, { hub, config, files }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  hub.setStatus('ready', 'Android is ready');
  hub.setDevice({ adb: null, serial: 'fake' });

  // wrong PIN is rejected
  const bad = fakeIphone(port, '000000');
  const err = await bad.waitFor((f) => f.type === S2C.ERROR);
  assert.equal(JSON.parse(err.payload).code, 'bad_pin');
  bad.sock.destroy();

  const phone = fakeIphone(port, '424242');
  const welcome = await phone.waitFor((f) => f.type === S2C.WELCOME);
  assert.equal(JSON.parse(welcome.payload).name, 'TestBox');
  const status = await phone.waitFor((f) => f.type === S2C.STATUS);
  assert.equal(JSON.parse(status.payload).phase, 'ready');

  const size = await phone.waitFor((f) => f.type === S2C.VIDEO_SIZE);
  assert.equal(size.payload.readUInt16BE(0), 720);
  assert.equal(size.payload.readUInt16BE(2), 1280);

  const cfg = await phone.waitFor((f) => f.type === S2C.VIDEO_PACKET && f.payload[0] === 1);
  assert.deepEqual(cfg.payload.subarray(1), SPS_PPS);
  const key = await phone.waitFor((f) => f.type === S2C.VIDEO_PACKET && f.payload[0] === 2);
  assert.deepEqual(key.payload.subarray(1), IDR);

  const af = await phone.waitFor((f) => f.type === S2C.AUDIO_FORMAT);
  assert.equal(JSON.parse(af.payload).codec, 'pcm_s16le');
  const ap = await phone.waitFor((f) => f.type === S2C.AUDIO_PACKET);
  assert.equal(ap.payload.length, 4096);

  // wait until the control socket is attached
  await until(() => hub.session && hub.session.controlSocket);

  // touch down in the middle-bottom
  const t = Buffer.alloc(6);
  t[0] = 0;
  t[1] = 0;
  t.writeUInt16BE(32767, 2);
  t.writeUInt16BE(65535, 4);
  phone.send(C2S.TOUCH, t);
  await until(() => android.controlBytes().length >= 32);
  let c = android.controlBytes();
  assert.equal(c[0], 2); // INJECT_TOUCH_EVENT
  assert.equal(c[1], 0); // down
  assert.equal(c.readBigUInt64BE(2), 0n);
  assert.equal(c.readInt32BE(10), 359);
  assert.equal(c.readInt32BE(14), 1279);
  assert.equal(c.readUInt16BE(18), 720);
  assert.equal(c.readUInt16BE(20), 1280);
  assert.equal(c.readUInt16BE(22), 0xffff);

  // ASCII text -> INJECT_TEXT
  phone.send(C2S.TEXT, 'hi');
  await until(() => android.controlBytes().length >= 32 + 7);
  c = android.controlBytes().subarray(32);
  assert.deepEqual([...c.subarray(0, 7)], [1, 0, 0, 0, 2, 0x68, 0x69]);

  // Swedish text -> clipboard paste
  phone.send(C2S.TEXT, 'hå');
  await until(() => android.controlBytes().length >= 39 + 17);
  c = android.controlBytes().subarray(39);
  assert.equal(c[0], 9);
  assert.equal(c[9], 1); // paste
  assert.equal(c.readUInt32BE(10), 3);
  assert.equal(c.subarray(14, 17).toString(), 'hå');

  // Back button -> key down + up (keycode 4)
  phone.send(C2S.NAV, Buffer.from([NAV.BACK]));
  await until(() => android.controlBytes().length >= 56 + 28);
  c = android.controlBytes().subarray(56);
  assert.equal(c[0], 0);
  assert.equal(c[1], 0);
  assert.equal(c.readInt32BE(2), 4);
  assert.equal(c[14], 0);
  assert.equal(c[15], 1);

  // Android clipboard -> iPhone
  android.sendClipboard('copied!');
  const clip = await phone.waitFor((f) => f.type === S2C.CLIPBOARD);
  assert.equal(clip.payload.toString(), 'copied!');

  // ping
  phone.send(C2S.PING, 'x');
  await phone.waitFor((f) => f.type === S2C.PONG);

  // disconnect stops the stream
  phone.sock.destroy();
  await until(() => hub.client === null && hub.session === null);

  server.close();
  android.close();
});
