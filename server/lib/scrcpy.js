'use strict';

// Talks to scrcpy-server 5.0.1 running inside Android (https://github.com/Genymobile/scrcpy, Apache-2.0).
// It gives us an H.264 screen stream, raw PCM audio, and touch/key injection.
//
// Video socket:  [dummy byte][64-byte device name][u32 codec id] then repeated 12-byte headers:
//   - session header (first bit set): [u32 flags][u32 width][u32 height]
//   - packet header: [u64 pts + flags (bit62 config, bit61 key frame)][u32 size] + payload
// Audio socket:  [u32 codec id] then packet headers + payloads.
// Control socket: we write control messages, it sends clipboard messages back.

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ByteQueue } = require('./bytes');
const log = require('./log');

const VERSION = '5.0.1';
const SERVER_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${VERSION}/scrcpy-server-v${VERSION}`;
const SERVER_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
const DEVICE_PATH = '/data/local/tmp/sandroid-scrcpy-server.jar';

const CODEC_H264 = 0x68323634;
const AUDIO_RAW = 0x00726177;

const MSG = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  EXPAND_NOTIFICATION_PANEL: 5,
  SET_CLIPBOARD: 9,
  ROTATE_DEVICE: 11,
  RESET_VIDEO: 17,
  SCAN_FILE: 22,
};

const INJECT_TEXT_MAX = 300;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitUtf8(text, maxBytes) {
  const parts = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (curBytes + n > maxBytes && cur) {
      parts.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  if (cur) parts.push(cur);
  return parts;
}

class ScrcpySession extends EventEmitter {
  // opts: { adb, serial, serverJar, stream: {maxSize, videoBitRate, maxFps, audio, iFrameInterval} }
  // Tests pass { connectPort } to talk to a fake device directly (no adb).
  constructor(opts) {
    super();
    this.opts = opts;
    this.scid = crypto.randomInt(0, 0x7fffffff);
    this.size = null;
    this.audioEnabled = opts.stream ? opts.stream.audio !== false : true;
    this.stopped = false;
    this.closedEmitted = false;
    this.proc = null;
    this.port = null;
    this.sockets = [];
    this.deviceName = '';
    this.serverOutput = [];
    this.connectTimeoutMs = opts.connectTimeoutMs || 120000;
  }

  serverArgs() {
    const s = this.opts.stream || {};
    const scidHex = this.scid.toString(16).padStart(8, '0');
    return [
      VERSION,
      `scid=${scidHex}`,
      'log_level=info',
      'tunnel_forward=true',
      'video_codec=h264',
      `video_bit_rate=${s.videoBitRate || 6000000}`,
      `max_size=${s.maxSize || 1280}`,
      `max_fps=${s.maxFps || 30}`,
      `video_codec_options=i-frame-interval=${s.iFrameInterval || 2}`,
      `audio=${this.audioEnabled}`,
      'audio_codec=raw',
      'control=true',
      'clipboard_autosync=true',
      'power_on=true',
      // cleanup=true starts a second Java process first, which is slow on an emulator.
      // Sandroid keeps the screen on itself (svc power stayon), so it is not needed.
      'cleanup=false',
    ];
  }

  async start() {
    const { adb, serial } = this.opts;
    if (this.opts.connectPort) {
      this.port = this.opts.connectPort;
    } else {
      await adb.runChecked(['-s', serial, 'push', this.opts.serverJar, DEVICE_PATH], { timeout: 60000 });
      this.port = await freePort();
      const name = `localabstract:scrcpy_${this.scid.toString(16).padStart(8, '0')}`;
      await adb.runChecked(['-s', serial, 'forward', `tcp:${this.port}`, name], { timeout: 20000 });
      this.forwarded = true;
      const args = ['-s', serial, 'shell', `CLASSPATH=${DEVICE_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', ...this.serverArgs()];
      this.proc = adb.spawn(args);
      const onLine = (d) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.serverOutput.push(line.trim());
          if (this.serverOutput.length > 30) this.serverOutput.shift();
          if (/ERROR|Exception|FATAL/.test(line)) log.warn(`[android stream] ${line.trim()}`);
          else log.info(`[android stream] ${line.trim()}`);
        }
      };
      this.proc.stdout.on('data', onLine);
      this.proc.stderr.on('data', onLine);
      this.proc.on('exit', (code) => {
        this.proc = null;
        this.procExit = code;
        if (!this.stopped) this._closed(new Error(`the Android screen streamer stopped (exit ${code})${this.outputTail()}`));
      });
    }

    try {
      await this._connectVideo();
      if (this.audioEnabled) this.audioSocket = await this._connect();
      this.controlSocket = await this._connect();
    } catch (e) {
      this.stop();
      throw e;
    }
    if (this.audioSocket) this._attachAudio(this.audioSocket);
    this._attachControl(this.controlSocket);
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: this.port });
      s.setNoDelay(true);
      s.once('connect', () => {
        s.removeListener('error', reject);
        this.sockets.push(s);
        resolve(s);
      });
      s.once('error', reject);
    });
  }

  // adb accepts the local connection even before the Android side is listening, so we
  // wait for scrcpy's "dummy byte" and retry until it arrives (like the official client).
  outputTail() {
    return this.serverOutput.length ? `\n  ${this.serverOutput.slice(-6).join('\n  ')}` : '';
  }

  async _connectVideo() {
    const started = Date.now();
    let lastNote = started;
    while (Date.now() - started < this.connectTimeoutMs) {
      if (this.stopped) throw new Error('stopped');
      if (!this.opts.connectPort && !this.proc) throw new Error(`the Android screen streamer could not start${this.outputTail()}`);
      if (Date.now() - lastNote > 15000) {
        lastNote = Date.now();
        const secs = Math.round((lastNote - started) / 1000);
        log.info(`Waiting for the Android screen streamer to start (${secs} s; Android is slow right after its first start)…`);
        this.emit('waiting', secs);
      }
      const s = await this._connect().catch(() => null);
      if (s) {
        const first = await new Promise((resolve) => {
          const onData = (d) => done(d);
          const onEnd = () => done(null);
          const timer = setTimeout(() => done(null), 3000);
          function done(v) {
            clearTimeout(timer);
            s.pause();
            s.removeListener('data', onData);
            s.removeListener('end', onEnd);
            s.removeListener('close', onEnd);
            s.removeListener('error', onEnd);
            resolve(v);
          }
          s.on('data', onData);
          s.on('end', onEnd);
          s.on('close', onEnd);
          s.on('error', onEnd);
        });
        if (first) {
          this.videoSocket = s;
          this._attachVideo(s, first);
          return;
        }
        s.destroy();
        this.sockets = this.sockets.filter((x) => x !== s);
      }
      await sleep(250);
    }
    throw new Error(`the Android screen streamer did not answer within ${Math.round(this.connectTimeoutMs / 1000)} s${this.outputTail()}`);
  }

  _watch(sock, what) {
    sock.on('error', (e) => this._closed(new Error(`${what} connection error: ${e.message}`)));
    sock.on('close', () => this._closed(new Error(`${what} connection closed`)));
  }

  _attachVideo(sock, firstChunk) {
    const q = new ByteQueue();
    let state = 'dummy';
    let pkt = null;
    const parse = () => {
      for (;;) {
        if (state === 'dummy') {
          if (q.length < 1) return;
          q.take(1);
          state = 'name';
        } else if (state === 'name') {
          if (q.length < 64) return;
          const b = q.take(64);
          const end = b.indexOf(0);
          this.deviceName = b.subarray(0, end < 0 ? 64 : end).toString('utf8');
          state = 'codec';
        } else if (state === 'codec') {
          if (q.length < 4) return;
          const id = q.take(4).readUInt32BE(0);
          if (id === 0 || id === 1) {
            this._closed(new Error('Android refused to stream the screen'));
            return;
          }
          if (id !== CODEC_H264) {
            this._closed(new Error(`unexpected video codec 0x${id.toString(16)}`));
            return;
          }
          state = 'header';
        } else if (state === 'header') {
          if (q.length < 12) return;
          const h = q.take(12);
          if (h[0] & 0x80) {
            const w = h.readUInt32BE(4);
            const ht = h.readUInt32BE(8);
            this.size = { width: w, height: ht };
            this.emit('size', w, ht);
          } else {
            const hi = h.readUInt32BE(0);
            pkt = { config: !!(hi & 0x40000000), key: !!(hi & 0x20000000), len: h.readUInt32BE(8) };
            state = 'payload';
          }
        } else if (state === 'payload') {
          if (q.length < pkt.len) return;
          const data = q.take(pkt.len);
          state = 'header';
          this.emit('video', data, pkt.config, pkt.key);
        }
      }
    };
    this._watch(sock, 'video');
    sock.on('data', (d) => {
      q.push(d);
      parse();
    });
    q.push(firstChunk);
    parse();
    sock.resume();
  }

  _attachAudio(sock) {
    const q = new ByteQueue();
    let state = 'codec';
    let pkt = null;
    sock.on('data', (d) => {
      q.push(d);
      for (;;) {
        if (state === 'codec') {
          if (q.length < 4) return;
          const id = q.take(4).readUInt32BE(0);
          if (id === AUDIO_RAW) {
            this.emit('audioFormat', { codec: 'pcm_s16le', rate: 48000, channels: 2 });
            state = 'header';
          } else {
            if (id !== 0) log.warn(`Android audio is not available (code ${id.toString(16)})`);
            else log.info('Android audio capture is not available on this device; video only.');
            this.emit('audioFormat', { codec: 'none' });
            state = 'off';
          }
        } else if (state === 'header') {
          if (q.length < 12) return;
          const h = q.take(12);
          pkt = { config: !!(h.readUInt32BE(0) & 0x40000000), len: h.readUInt32BE(8) };
          state = 'payload';
        } else if (state === 'payload') {
          if (q.length < pkt.len) return;
          const data = q.take(pkt.len);
          state = 'header';
          if (!pkt.config) this.emit('audio', data);
        } else {
          q.clear();
          return;
        }
      }
    });
    sock.on('error', () => {});
  }

  _attachControl(sock) {
    const q = new ByteQueue();
    let state = 'type';
    let need = 0;
    this._watch(sock, 'control');
    sock.on('data', (d) => {
      q.push(d);
      for (;;) {
        if (state === 'type') {
          if (q.length < 1) return;
          const t = q.take(1)[0];
          if (t === 0) state = 'clipLen';
          else if (t === 1) {
            state = 'skip';
            need = 8;
          } else if (t === 2) state = 'uhid';
          else {
            log.warn(`unknown message ${t} from Android; ignoring the rest`);
            state = 'dead';
          }
        } else if (state === 'clipLen') {
          if (q.length < 4) return;
          need = q.take(4).readUInt32BE(0);
          state = 'clipText';
        } else if (state === 'clipText') {
          if (q.length < need) return;
          this.emit('clipboard', q.take(need).toString('utf8'));
          state = 'type';
        } else if (state === 'uhid') {
          if (q.length < 4) return;
          const h = q.take(4);
          need = h.readUInt16BE(2);
          state = 'skip';
        } else if (state === 'skip') {
          if (q.length < need) return;
          q.take(need);
          state = 'type';
        } else {
          q.clear();
          return;
        }
      }
    });
  }

  _closed(err) {
    if (this.closedEmitted || this.stopped) return;
    this.closedEmitted = true;
    this.emit('closed', err);
    this.stop();
  }

  _write(buf) {
    if (this.controlSocket && !this.controlSocket.destroyed) this.controlSocket.write(buf);
  }

  // ---------- control messages ----------

  // action: 0 down, 1 up, 2 move, 3 cancel; x/y in video pixels
  touch(action, pointerId, x, y) {
    if (!this.size) return;
    const b = Buffer.alloc(32);
    b[0] = MSG.INJECT_TOUCH_EVENT;
    b[1] = action;
    b.writeBigUInt64BE(BigInt(pointerId), 2);
    b.writeInt32BE(x, 10);
    b.writeInt32BE(y, 14);
    b.writeUInt16BE(this.size.width, 18);
    b.writeUInt16BE(this.size.height, 20);
    b.writeUInt16BE(action === 1 ? 0 : 0xffff, 22);
    b.writeInt32BE(0, 24); // action button
    b.writeInt32BE(0, 28); // buttons
    this._write(b);
  }

  // x/y normalized 0..65535 over the video frame
  touchNormalized(action, pointerId, nx, ny) {
    if (!this.size) return;
    const x = Math.round((nx / 65535) * (this.size.width - 1));
    const y = Math.round((ny / 65535) * (this.size.height - 1));
    this.touch(action, pointerId, x, y);
  }

  key(action, keycode, metaState = 0) {
    const b = Buffer.alloc(14);
    b[0] = MSG.INJECT_KEYCODE;
    b[1] = action;
    b.writeInt32BE(keycode, 2);
    b.writeInt32BE(0, 6); // repeat
    b.writeInt32BE(metaState, 10);
    this._write(b);
  }

  pressKey(keycode, metaState = 0) {
    this.key(0, keycode, metaState);
    this.key(1, keycode, metaState);
  }

  // ASCII is typed as key presses; anything else (å, ä, ö, emoji…) goes in through the clipboard.
  text(str) {
    if (!str) return;
    if (/^[\x20-\x7e]*$/.test(str)) {
      for (const part of splitUtf8(str, INJECT_TEXT_MAX)) {
        const t = Buffer.from(part, 'utf8');
        const b = Buffer.alloc(5);
        b[0] = MSG.INJECT_TEXT;
        b.writeUInt32BE(t.length, 1);
        this._write(Buffer.concat([b, t]));
      }
    } else {
      this.setClipboard(str, true);
    }
  }

  setClipboard(str, paste) {
    const t = Buffer.from(str, 'utf8');
    const b = Buffer.alloc(14);
    b[0] = MSG.SET_CLIPBOARD;
    b.writeBigUInt64BE(0n, 1); // sequence 0 = no ack
    b[9] = paste ? 1 : 0;
    b.writeUInt32BE(t.length, 10);
    this._write(Buffer.concat([b, t]));
  }

  simple(type) {
    this._write(Buffer.from([type]));
  }

  expandNotifications() {
    this.simple(MSG.EXPAND_NOTIFICATION_PANEL);
  }

  rotate() {
    this.simple(MSG.ROTATE_DEVICE);
  }

  resetVideo() {
    this.simple(MSG.RESET_VIDEO);
  }

  scanFile(devicePath) {
    const t = Buffer.from(devicePath, 'utf8');
    const b = Buffer.alloc(5);
    b[0] = MSG.SCAN_FILE;
    b.writeUInt32BE(t.length, 1);
    this._write(Buffer.concat([b, t]));
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sockets) s.destroy();
    this.sockets = [];
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
    if (this.forwarded && this.opts.adb) {
      this.opts.adb.run(['-s', this.opts.serial, 'forward', '--remove', `tcp:${this.port}`], { timeout: 10000 }).catch(() => {});
    }
  }
}

module.exports = { ScrcpySession, VERSION, SERVER_URL, SERVER_SHA256, DEVICE_PATH, CODEC_H264, AUDIO_RAW, splitUtf8 };
