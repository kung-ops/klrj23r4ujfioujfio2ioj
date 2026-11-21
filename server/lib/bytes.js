'use strict';

// A FIFO of Buffers that lets parsers take exactly N bytes without
// re-concatenating everything on every 'data' event.
class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(buf) {
    if (buf && buf.length) {
      this.chunks.push(buf);
      this.length += buf.length;
    }
  }

  take(n) {
    if (n > this.length) throw new RangeError(`need ${n} bytes, have ${this.length}`);
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    if (first.length === n) {
      this.chunks.shift();
      this.length -= n;
      return first;
    }
    if (first.length > n) {
      this.chunks[0] = first.subarray(n);
      this.length -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const need = n - off;
      if (c.length <= need) {
        c.copy(out, off);
        off += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, off, 0, need);
        this.chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this.length -= n;
    return out;
  }

  clear() {
    this.chunks = [];
    this.length = 0;
  }
}

module.exports = { ByteQueue };
