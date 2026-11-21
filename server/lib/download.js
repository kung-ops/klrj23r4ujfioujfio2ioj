'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');

// Downloads url -> dest (atomically via dest.part). Follows redirects.
// opts.sha256 / opts.sha1: expected hex digest. opts.onProgress(done, total).
async function download(url, dest, opts = {}) {
  const retries = opts.retries ?? 3;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const tmp = dest + '.part';
    try {
      // Ask for the raw file. If a server compresses it anyway, fetch unpacks it and the
      // Content-Length no longer matches the bytes we get, so only compare sizes when it didn't.
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'sandroid-server/1.0', 'Accept-Encoding': 'identity' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const encoding = (res.headers.get('content-encoding') || 'identity').toLowerCase();
      const compressed = encoding !== 'identity';
      const total = Number(res.headers.get('content-length')) || 0; // for the progress display
      const out = fs.createWriteStream(tmp);
      const sha256 = crypto.createHash('sha256');
      const sha1 = crypto.createHash('sha1');
      let done = 0;
      let lastReport = 0;
      try {
        for await (const chunk of res.body) {
          done += chunk.length;
          sha256.update(chunk);
          sha1.update(chunk);
          if (!out.write(chunk)) await once(out, 'drain');
          const now = Date.now();
          if (opts.onProgress && now - lastReport > 500) {
            lastReport = now;
            opts.onProgress(Math.min(done, total || done), total);
          }
        }
      } finally {
        await new Promise((resolve) => out.end(resolve));
      }
      if (!compressed && total && done !== total) throw new Error(`download incomplete (${done}/${total} bytes)`);
      if (opts.sha256 && sha256.digest('hex') !== opts.sha256.toLowerCase()) throw new Error(`checksum mismatch for ${url}`);
      if (opts.sha1 && sha1.digest('hex') !== opts.sha1.toLowerCase()) throw new Error(`checksum mismatch for ${url}`);
      fs.renameSync(tmp, dest);
      if (opts.onProgress) opts.onProgress(done, total || done);
      return dest;
    } catch (e) {
      lastErr = e;
      try {
        fs.unlinkSync(tmp);
      } catch {}
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw friendly(lastErr, url);
}

function friendly(e, url) {
  const cause = e && e.cause && (e.cause.code || e.cause.message);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (cause) return new Error(`Could not download from ${host}: ${cause}. Check this computer's internet connection.`);
  return new Error(`Download from ${host} failed: ${e.message}`);
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'sandroid-server/1.0' } }).catch((e) => {
    throw friendly(e, url);
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

module.exports = { download, fetchText };
