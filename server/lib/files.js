'use strict';

// Moves files between the iPhone and Android, and installs apps.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { shellQuote } = require('./adb');
const { openZip } = require('./unzip');

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 200) : 'file';
}

function tmpPath(dataDir, name) {
  const dir = path.join(dataDir, 'transfer');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${crypto.randomBytes(6).toString('hex')}-${safeName(name)}`);
}

function lastLine(text) {
  return (text || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
}

class Files {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
  }

  newUploadPath(name) {
    return tmpPath(this.dataDir, name);
  }

  // Handles a file the iPhone sent. Returns { ok, message }.
  async receive(device, localFile, name, session) {
    const { adb, serial } = device;
    const lower = name.toLowerCase();
    try {
      if (lower.endsWith('.apk')) {
        const r = await adb.run(['-s', serial, 'install', '-r', localFile], { timeout: 10 * 60000 });
        const out = (r.stdout + r.stderr).trim();
        if (r.code === 0 && /Success/.test(out)) return { ok: true, message: `Installed ${name}` };
        return { ok: false, message: `Could not install ${name}: ${lastLine(out) || 'unknown error'}` };
      }
      if (lower.endsWith('.apks') || lower.endsWith('.xapk') || lower.endsWith('.apkm')) {
        return await this.installBundle(device, localFile, name);
      }
      const remote = `/sdcard/Download/${name}`;
      const r = await adb.run(['-s', serial, 'push', localFile, remote], { timeout: 30 * 60000 });
      if (r.code !== 0) return { ok: false, message: `Could not copy ${name}: ${lastLine(r.stderr || r.stdout)}` };
      if (session) session.scanFile(remote);
      else await adb.shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shellQuote('file://' + remote)}`).catch(() => {});
      return { ok: true, message: `Saved to Download/${name}` };
    } finally {
      fs.rm(localFile, { force: true }, () => {});
    }
  }

  // Split-APK bundles (.apks / .xapk / .apkm): install every APK inside, copy OBB data.
  async installBundle(device, file, name) {
    const { adb, serial } = device;
    const dir = path.join(path.dirname(file), `bundle-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      let zip;
      try {
        zip = openZip(file);
      } catch {
        return { ok: false, message: `${name} is not a readable bundle (.apkm files from APKMirror are encrypted and not supported).` };
      }
      const apks = [];
      const obbs = [];
      try {
        for (const e of zip.entries) {
          if (e.isDir) continue;
          const lower = e.name.toLowerCase();
          if (lower.endsWith('.apk') && !lower.includes('/')) {
            const out = path.join(dir, safeName(e.name));
            zip.extractEntry(e, out);
            apks.push(out);
          } else if (lower.endsWith('.obb')) {
            const out = path.join(dir, safeName(e.name));
            zip.extractEntry(e, out);
            const m = /android\/obb\/([^/]+)\//i.exec(e.name);
            obbs.push({ local: out, pkg: m ? m[1] : null, name: safeName(e.name) });
          }
        }
      } finally {
        zip.close();
      }
      if (!apks.length) return { ok: false, message: `No APK found inside ${name}.` };
      const r = await adb.run(['-s', serial, 'install-multiple', '-r', ...apks], { timeout: 15 * 60000 });
      const out = (r.stdout + r.stderr).trim();
      if (r.code !== 0 || !/Success/.test(out)) return { ok: false, message: `Could not install ${name}: ${lastLine(out)}` };
      for (const o of obbs) {
        if (!o.pkg) continue;
        const remoteDir = `/sdcard/Android/obb/${o.pkg}`;
        await adb.shell(serial, `mkdir -p ${shellQuote(remoteDir)}`).catch(() => {});
        await adb.run(['-s', serial, 'push', o.local, `${remoteDir}/${o.name}`], { timeout: 30 * 60000 });
      }
      return { ok: true, message: `Installed ${name}${obbs.length ? ' (with game data)' : ''}` };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  async list(device, dir) {
    const { adb, serial } = device;
    let p = String(dir || '/sdcard/');
    if (!p.startsWith('/')) p = '/sdcard/' + p;
    if (!p.endsWith('/')) p += '/';
    const r = await adb.shell(serial, `ls -1pa ${shellQuote(p)}`, { timeout: 30000 });
    if (r.code !== 0) return { path: p, error: lastLine(r.stderr || r.stdout) || 'cannot open folder' };
    const entries = r.stdout
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l && l !== './' && l !== '../' && !l.startsWith('.'))
      .map((l) => (l.endsWith('/') ? { name: l.slice(0, -1), dir: true } : { name: l, dir: false }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { path: p, entries };
  }

  // Copies an Android file to the server; returns the local path (caller deletes it).
  async pull(device, remote) {
    const { adb, serial } = device;
    const local = tmpPath(this.dataDir, path.posix.basename(remote));
    const r = await adb.run(['-s', serial, 'pull', remote, local], { timeout: 30 * 60000 });
    if (r.code !== 0 || !fs.existsSync(local)) throw new Error(lastLine(r.stderr || r.stdout) || 'could not read the file');
    return local;
  }

  cleanup() {
    fs.rm(path.join(this.dataDir, 'transfer'), { recursive: true, force: true }, () => {});
  }
}

module.exports = { Files, safeName };
