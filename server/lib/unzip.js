'use strict';

// Small dependency-free .zip reader (stored + deflate, zip64 sizes, unix modes, symlinks).
// Used for the Android command-line tools, the Windows JDK, and .apks/.xapk bundles.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function readAt(fd, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, buf, off, len - off, pos + off);
    if (n === 0) throw new Error('unexpected end of zip file');
    off += n;
  }
  return buf;
}

function findEocd(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) return { buf: tail.subarray(i), pos: size - tailLen + i };
  }
  throw new Error('not a zip file (no end of central directory)');
}

function openZip(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  try {
    const { buf: eocd, pos: eocdPos } = findEocd(fd, size);
    let count = eocd.readUInt16LE(10);
    let cdSize = eocd.readUInt32LE(12);
    let cdOffset = eocd.readUInt32LE(16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = readAt(fd, eocdPos - 20, 20);
      if (loc.readUInt32LE(0) !== SIG_EOCD64_LOC) throw new Error('bad zip64 locator');
      const e64Pos = Number(loc.readBigUInt64LE(8));
      const e64 = readAt(fd, e64Pos, 56);
      if (e64.readUInt32LE(0) !== SIG_EOCD64) throw new Error('bad zip64 end record');
      count = Number(e64.readBigUInt64LE(32));
      cdSize = Number(e64.readBigUInt64LE(40));
      cdOffset = Number(e64.readBigUInt64LE(48));
    }
    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== SIG_CEN) throw new Error('bad central directory entry');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let size2 = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const extAttr = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const name = flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      // zip64 extended information
      let e = 0;
      while (e + 4 <= extra.length) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size2 === 0xffffffff) {
            size2 = Number(extra.readBigUInt64LE(q));
            q += 8;
          }
          if (compSize === 0xffffffff) {
            compSize = Number(extra.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(extra.readBigUInt64LE(q));
            q += 8;
          }
        }
        e += 4 + len;
      }
      const unixMode = madeBy >> 8 === 3 ? (extAttr >>> 16) & 0xffff : 0;
      entries.push({
        name,
        method,
        compSize,
        size: size2,
        localOffset,
        encrypted: !!(flags & 1),
        isDir: name.endsWith('/'),
        isSymlink: (unixMode & 0o170000) === 0o120000,
        mode: unixMode & 0o777,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }

    function readEntry(entry) {
      if (entry.encrypted) throw new Error(`encrypted zip entry: ${entry.name}`);
      const loc = readAt(fd, entry.localOffset, 30);
      if (loc.readUInt32LE(0) !== SIG_LOC) throw new Error(`bad local header: ${entry.name}`);
      const dataPos = entry.localOffset + 30 + loc.readUInt16LE(26) + loc.readUInt16LE(28);
      const raw = entry.compSize ? readAt(fd, dataPos, entry.compSize) : Buffer.alloc(0);
      if (entry.method === 0) return raw;
      if (entry.method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`unsupported zip compression method ${entry.method} (${entry.name})`);
    }

    function safeTarget(destDir, name) {
      const normalized = name.replace(/\\/g, '/');
      if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) {
        throw new Error(`unsafe path in zip: ${name}`);
      }
      return path.join(destDir, normalized);
    }

    function extractEntry(entry, target) {
      if (entry.isDir) {
        fs.mkdirSync(target, { recursive: true });
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = readEntry(entry);
      if (entry.isSymlink && process.platform !== 'win32') {
        try {
          fs.unlinkSync(target);
        } catch {}
        fs.symlinkSync(data.toString('utf8'), target);
        return;
      }
      fs.writeFileSync(target, data);
      if (entry.mode && process.platform !== 'win32') fs.chmodSync(target, entry.mode);
    }

    return {
      entries,
      readEntry,
      extractEntry,
      extractAll(destDir, filter) {
        for (const entry of entries) {
          if (filter && !filter(entry)) continue;
          extractEntry(entry, safeTarget(destDir, entry.name));
        }
      },
      close() {
        fs.closeSync(fd);
      },
    };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

function extractZip(file, destDir, filter) {
  const zip = openZip(file);
  try {
    zip.extractAll(destDir, filter);
  } finally {
    zip.close();
  }
}

module.exports = { openZip, extractZip };
