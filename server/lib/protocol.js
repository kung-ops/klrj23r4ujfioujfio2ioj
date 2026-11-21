'use strict';

// Sandroid wire protocol (TCP, default port 8080). Not HTTP.
// Every message is: [u8 type][u32 big-endian payload length][payload].
// JSON payloads are UTF-8.

const { ByteQueue } = require('./bytes');

const PROTOCOL_VERSION = 1;

// iPhone -> server
const C2S = {
  HELLO: 0x01, // JSON {pin, client, version, device}
  PING: 0x02, // any bytes, echoed back in PONG
  TOUCH: 0x10, // [u8 action 0=down 1=up 2=move 3=cancel][u8 pointer][u16 x][u16 y]  (x,y normalized 0..65535)
  KEY: 0x11, // [u8 action 0=down 1=up 2=press][u32 android keycode][u32 metastate]
  TEXT: 0x12, // UTF-8 text to type
  NAV: 0x13, // [u8 NAV.*]
  CLIPBOARD: 0x15, // UTF-8: set Android clipboard and paste it
  UPLOAD_BEGIN: 0x20, // JSON {name, size}
  UPLOAD_CHUNK: 0x21, // raw bytes
  UPLOAD_END: 0x22, // empty
  LIST_FILES: 0x23, // JSON {path}
  DOWNLOAD: 0x24, // JSON {path}
  CAMERA_FRAME: 0x30, // one JPEG image
  CAMERA_STOP: 0x31, // empty
};

// server -> iPhone
const S2C = {
  ERROR: 0x80, // JSON {code, message}
  WELCOME: 0x81, // JSON {name, version, camera:{available, reason}}
  STATUS: 0x82, // JSON {phase, message, progress}
  PONG: 0x83,
  NOTICE: 0x84, // JSON {message}
  VIDEO_SIZE: 0x90, // [u16 width][u16 height]
  VIDEO_PACKET: 0x91, // [u8 flags: 1=config(SPS/PPS) 2=keyframe][H.264 Annex-B]
  AUDIO_FORMAT: 0x92, // JSON {codec:"pcm_s16le", rate, channels} or {codec:"none"}
  AUDIO_PACKET: 0x93, // raw PCM
  CLIPBOARD: 0x94, // UTF-8 text copied inside Android
  FILE_LIST: 0xa0, // JSON {path, entries:[{name, dir}]} or {path, error}
  DOWNLOAD_BEGIN: 0xa1, // JSON {name, size}
  DOWNLOAD_CHUNK: 0xa2,
  DOWNLOAD_END: 0xa3, // JSON {ok, message}
  UPLOAD_DONE: 0xa4, // JSON {name, ok, message}
};

const NAV = {
  BACK: 1,
  HOME: 2,
  RECENTS: 3,
  POWER: 4,
  VOLUME_UP: 5,
  VOLUME_DOWN: 6,
  NOTIFICATIONS: 7,
  ROTATE: 8,
  RESET_VIDEO: 9,
  RESTART_ANDROID: 10,
};

const MAX_FRAME = 8 * 1024 * 1024;

function toPayload(p) {
  if (p === undefined || p === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(p)) return p;
  if (p instanceof Uint8Array) return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
  if (typeof p === 'string') return Buffer.from(p, 'utf8');
  return Buffer.from(JSON.stringify(p), 'utf8');
}

function header(type, length) {
  const h = Buffer.allocUnsafe(5);
  h[0] = type;
  h.writeUInt32BE(length, 1);
  return h;
}

function encode(type, payload) {
  const p = toPayload(payload);
  return Buffer.concat([header(type, p.length), p]);
}

// Writes one message; returns false if the socket buffer is full.
function writeMessage(socket, type, payload) {
  if (socket.destroyed) return false;
  const p = toPayload(payload);
  if (p.length < 16 * 1024) return socket.write(Buffer.concat([header(type, p.length), p]));
  socket.cork();
  socket.write(header(type, p.length));
  const ok = socket.write(p);
  socket.uncork();
  return ok;
}

class FrameParser {
  constructor(onFrame, maxFrame = MAX_FRAME) {
    this.q = new ByteQueue();
    this.onFrame = onFrame;
    this.maxFrame = maxFrame;
    this.type = 0;
    this.need = -1;
  }

  push(chunk) {
    this.q.push(chunk);
    for (;;) {
      if (this.need < 0) {
        if (this.q.length < 5) return;
        const h = this.q.take(5);
        this.type = h[0];
        this.need = h.readUInt32BE(1);
        if (this.need > this.maxFrame) throw new Error(`message too large (${this.need} bytes)`);
      }
      if (this.q.length < this.need) return;
      const payload = this.q.take(this.need);
      const type = this.type;
      this.need = -1;
      this.onFrame(type, payload);
    }
  }
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { PROTOCOL_VERSION, C2S, S2C, NAV, MAX_FRAME, encode, writeMessage, FrameParser, parseJson, toPayload };
