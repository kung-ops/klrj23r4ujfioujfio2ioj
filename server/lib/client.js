'use strict';

// One TCP connection from the iPhone app.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./log');
const { C2S, S2C, NAV, PROTOCOL_VERSION, FrameParser, writeMessage, parseJson } = require('./protocol');
const { safeName } = require('./files');

const KEY = { HOME: 3, BACK: 4, VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, APP_SWITCH: 187 };
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

// Wrong-PIN protection, shared by all connections.
const failures = new Map();

function pinMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function waitDrain(socket, limit) {
  return new Promise((resolve) => {
    if (socket.destroyed || socket.writableLength <= limit) return resolve();
    const done = () => {
      socket.removeListener('drain', done);
      socket.removeListener('close', done);
      resolve();
    };
    socket.on('drain', done);
    socket.on('close', done);
  });
}

class ClientConnection {
  constructor(socket, { hub, config, files }) {
    this.socket = socket;
    this.hub = hub;
    this.config = config;
    this.files = files;
    this.ip = (socket.remoteAddress || '?').replace(/^::ffff:/, '');
    this.label = this.ip;
    this.authed = false;
    this.closed = false;
    this.needKey = false;
    this.lastKeyRequest = 0;
    this.upload = null;
    this.downloading = false;

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.setTimeout(45000, () => {
      log.info(`${this.label}: no data for 45 s, disconnecting`);
      socket.destroy();
    });
    this.parser = new FrameParser((t, p) => this.onFrame(t, p));
    socket.on('data', (d) => {
      try {
        this.parser.push(d);
      } catch (e) {
        log.warn(`${this.label}: ${e.message}`);
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.onClose());
    this.helloTimer = setTimeout(() => {
      if (!this.authed) socket.destroy();
    }, 15000);
  }

  send(type, payload) {
    if (!this.closed) writeMessage(this.socket, type, payload);
  }

  sendStatus(state) {
    this.send(S2C.STATUS, state);
  }

  sendNotice(message) {
    this.send(S2C.NOTICE, { message });
  }

  sendVideoSize(w, h) {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(w, 0);
    b.writeUInt16BE(h, 2);
    this.send(S2C.VIDEO_SIZE, b);
  }

  requestKeyFrame() {
    const now = Date.now();
    if (now - this.lastKeyRequest < 1000) return;
    this.lastKeyRequest = now;
    if (this.hub.session) this.hub.session.resetVideo();
  }

  sendVideo(data, config, key) {
    if (this.closed) return;
    const s = this.socket;
    if (!config) {
      if (this.needKey && !key) return; // waiting for a picture we can decode from
      if (s.writableLength > 2 * 1024 * 1024) {
        // Wi-Fi can't keep up: skip frames until the next key frame
        this.needKey = true;
        this.requestKeyFrame();
        return;
      }
      if (key) this.needKey = false;
    }
    const h = Buffer.allocUnsafe(6);
    h[0] = S2C.VIDEO_PACKET;
    h.writeUInt32BE(data.length + 1, 1);
    h[5] = (config ? 1 : 0) | (key ? 2 : 0);
    s.cork();
    s.write(h);
    s.write(data);
    s.uncork();
  }

  sendAudioFormat(f) {
    this.send(S2C.AUDIO_FORMAT, f);
  }

  sendAudio(data) {
    if (this.closed || this.socket.writableLength > 512 * 1024) return;
    this.send(S2C.AUDIO_PACKET, data);
  }

  sendClipboard(text) {
    this.send(S2C.CLIPBOARD, text);
  }

  kick(message) {
    this.send(S2C.ERROR, { code: 'replaced', message });
    this.socket.end();
    this.closed = true;
  }

  onClose() {
    this.closed = true;
    clearTimeout(this.helloTimer);
    if (this.upload) {
      this.upload.stream.destroy();
      fs.rm(this.upload.path, { force: true }, () => {});
      this.upload = null;
    }
    if (this.authed) {
      log.info(`${this.label} disconnected`);
      this.hub.detachClient(this);
    }
  }

  // ---------- incoming ----------

  onFrame(type, p) {
    if (!this.authed) {
      if (type !== C2S.HELLO) {
        this.socket.destroy();
        return;
      }
      this.onHello(p);
      return;
    }
    const session = this.hub.session;
    switch (type) {
      case C2S.PING:
        this.send(S2C.PONG, p);
        break;
      case C2S.TOUCH:
        if (session && p.length >= 6) session.touchNormalized(p[0], p[1], p.readUInt16BE(2), p.readUInt16BE(4));
        break;
      case C2S.KEY:
        if (session && p.length >= 9) {
          const action = p[0];
          const code = p.readUInt32BE(1);
          const meta = p.readUInt32BE(5);
          if (action === 2) session.pressKey(code, meta);
          else session.key(action, code, meta);
        }
        break;
      case C2S.TEXT:
        if (session) session.text(p.toString('utf8'));
        break;
      case C2S.CLIPBOARD:
        if (session) session.setClipboard(p.toString('utf8'), true);
        break;
      case C2S.NAV:
        this.onNav(p[0]);
        break;
      case C2S.UPLOAD_BEGIN:
        this.onUploadBegin(parseJson(p) || {});
        break;
      case C2S.UPLOAD_CHUNK:
        this.onUploadChunk(p);
        break;
      case C2S.UPLOAD_END:
        this.onUploadEnd();
        break;
      case C2S.LIST_FILES:
        this.onList(parseJson(p) || {});
        break;
      case C2S.DOWNLOAD:
        this.onDownload(parseJson(p) || {});
        break;
      case C2S.CAMERA_FRAME:
        if (this.hub.camera) this.hub.camera.pushFrame(p);
        break;
      case C2S.CAMERA_STOP:
        if (this.hub.camera) this.hub.camera.phoneStopped();
        break;
      default:
        log.debug(`${this.label}: unknown message 0x${type.toString(16)}`);
    }
  }

  onHello(p) {
    const hello = parseJson(p) || {};
    const now = Date.now();
    const f = failures.get(this.ip) || { count: 0, until: 0 };
    if (f.until > now) {
      this.send(S2C.ERROR, { code: 'locked', message: 'Too many wrong PINs. Wait one minute and try again.' });
      this.socket.end();
      return;
    }
    if (!pinMatches(hello.pin, this.config.pin)) {
      f.count++;
      if (f.count >= 5) {
        f.until = now + 60000;
        f.count = 0;
      }
      failures.set(this.ip, f);
      log.warn(`${this.ip}: wrong PIN`);
      this.send(S2C.ERROR, { code: 'bad_pin', message: 'Wrong PIN. The PIN is shown in the server window.' });
      this.socket.end();
      return;
    }
    failures.delete(this.ip);
    clearTimeout(this.helloTimer);
    this.authed = true;
    this.label = `${hello.device || 'iPhone'} (${this.ip})`;
    log.info(`${this.label} connected${hello.ios ? `, iOS ${hello.ios}` : ''}`);
    this.send(S2C.WELCOME, {
      name: this.config.name,
      version: PROTOCOL_VERSION,
      camera: this.hub.camera ? this.hub.camera.status() : { available: false, reason: 'Android is still starting.' },
    });
    this.hub.attachClient(this);
  }

  onNav(code) {
    const s = this.hub.session;
    if (code === NAV.RESTART_ANDROID) {
      this.sendNotice('Restarting Android…');
      this.hub.restartAndroid().catch((e) => log.error(`Restart failed: ${e.message}`));
      return;
    }
    if (!s) return;
    switch (code) {
      case NAV.BACK:
        s.pressKey(KEY.BACK);
        break;
      case NAV.HOME:
        s.pressKey(KEY.HOME);
        break;
      case NAV.RECENTS:
        s.pressKey(KEY.APP_SWITCH);
        break;
      case NAV.POWER:
        s.pressKey(KEY.POWER);
        break;
      case NAV.VOLUME_UP:
        s.pressKey(KEY.VOLUME_UP);
        break;
      case NAV.VOLUME_DOWN:
        s.pressKey(KEY.VOLUME_DOWN);
        break;
      case NAV.NOTIFICATIONS:
        s.expandNotifications();
        break;
      case NAV.ROTATE:
        s.rotate();
        break;
      case NAV.RESET_VIDEO:
        this.needKey = true;
        s.resetVideo();
        break;
      default:
        break;
    }
  }

  // ---------- files ----------

  onUploadBegin(info) {
    if (this.upload) {
      this.upload.stream.destroy();
      fs.rm(this.upload.path, { force: true }, () => {});
    }
    const name = safeName(info.name);
    const size = Number(info.size) || 0;
    if (size > MAX_UPLOAD) {
      this.send(S2C.UPLOAD_DONE, { name, ok: false, message: 'That file is too big (max 4 GB).' });
      this.upload = null;
      return;
    }
    const file = this.files.newUploadPath(name);
    const stream = fs.createWriteStream(file);
    stream.on('error', (e) => log.warn(`upload ${name}: ${e.message}`));
    this.upload = { name, size, path: file, stream, received: 0 };
    log.info(`${this.label}: receiving ${name} (${(size / 1048576).toFixed(1)} MB)`);
  }

  onUploadChunk(p) {
    const u = this.upload;
    if (!u) return;
    u.received += p.length;
    if (!u.stream.write(p)) {
      this.socket.pause();
      u.stream.once('drain', () => this.socket.resume());
    }
  }

  onUploadEnd() {
    const u = this.upload;
    if (!u) return;
    this.upload = null;
    u.stream.end(async () => {
      const device = this.hub.device;
      let result;
      if (!device) result = { ok: false, message: 'Android is not running yet.' };
      else {
        try {
          result = await this.files.receive(device, u.path, u.name, this.hub.session);
        } catch (e) {
          result = { ok: false, message: e.message };
        }
      }
      if (!device) fs.rm(u.path, { force: true }, () => {});
      log.info(`${this.label}: ${result.message}`);
      this.send(S2C.UPLOAD_DONE, { name: u.name, ...result });
    });
  }

  async onList(req) {
    const device = this.hub.device;
    if (!device) {
      this.send(S2C.FILE_LIST, { path: req.path || '/sdcard/', error: 'Android is not running yet.' });
      return;
    }
    try {
      this.send(S2C.FILE_LIST, await this.files.list(device, req.path));
    } catch (e) {
      this.send(S2C.FILE_LIST, { path: req.path, error: e.message });
    }
  }

  async onDownload(req) {
    const device = this.hub.device;
    const remote = String(req.path || '');
    const name = safeName(path.posix.basename(remote));
    if (!device || !remote.startsWith('/')) {
      this.send(S2C.DOWNLOAD_END, { ok: false, name, message: device ? 'Bad path.' : 'Android is not running yet.' });
      return;
    }
    if (this.downloading) {
      this.send(S2C.DOWNLOAD_END, { ok: false, name, message: 'Another download is still running.' });
      return;
    }
    this.downloading = true;
    let local = null;
    try {
      local = await this.files.pull(device, remote);
      const size = fs.statSync(local).size;
      this.send(S2C.DOWNLOAD_BEGIN, { name, size });
      const rs = fs.createReadStream(local, { highWaterMark: 256 * 1024 });
      for await (const chunk of rs) {
        if (this.closed) {
          rs.destroy();
          break;
        }
        this.send(S2C.DOWNLOAD_CHUNK, chunk);
        await waitDrain(this.socket, 1024 * 1024);
      }
      this.send(S2C.DOWNLOAD_END, { ok: true, name });
    } catch (e) {
      this.send(S2C.DOWNLOAD_END, { ok: false, name, message: e.message });
    } finally {
      this.downloading = false;
      if (local) fs.rm(local, { force: true }, () => {});
    }
  }
}

module.exports = { ClientConnection, failures };
