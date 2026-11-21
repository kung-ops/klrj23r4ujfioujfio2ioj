'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ByteQueue } = require('../lib/bytes');
const { FrameParser, encode } = require('../lib/protocol');
const { extractZip, openZip } = require('../lib/unzip');
const { splitUtf8 } = require('../lib/scrcpy');
const { Setup } = require('../lib/setup');
const { safeName } = require('../lib/files');

test('ByteQueue takes across chunk boundaries', () => {
  const q = new ByteQueue();
  q.push(Buffer.from([1, 2]));
  q.push(Buffer.from([3]));
  q.push(Buffer.from([4, 5, 6]));
  assert.deepEqual([...q.take(1)], [1]);
  assert.deepEqual([...q.take(4)], [2, 3, 4, 5]);
  assert.equal(q.length, 1);
  assert.throws(() => q.take(2));
});

test('FrameParser handles random splits', () => {
  const msgs = [];
  for (let i = 0; i < 200; i++) msgs.push([i % 256, Buffer.alloc(Math.floor(Math.random() * 3000), i % 256)]);
  const wire = Buffer.concat(msgs.map(([t, p]) => encode(t, p)));
  const got = [];
  const parser = new FrameParser((t, p) => got.push([t, p]));
  let off = 0;
  while (off < wire.length) {
    const n = 1 + Math.floor(Math.random() * 1000);
    parser.push(wire.subarray(off, off + n));
    off += n;
  }
  assert.equal(got.length, msgs.length);
  for (let i = 0; i < msgs.length; i++) {
    assert.equal(got[i][0], msgs[i][0]);
    assert.deepEqual(got[i][1], msgs[i][1]);
  }
});

test('FrameParser rejects huge frames', () => {
  const parser = new FrameParser(() => {}, 1024);
  const h = Buffer.alloc(5);
  h[0] = 1;
  h.writeUInt32BE(5000, 1);
  assert.throws(() => parser.push(h));
});

test('unzip extracts stored + deflated entries and keeps exec bits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdz-'));
  const zipFile = path.join(dir, 't.zip');
  const py = `
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('cmdline-tools/', '')
i = zipfile.ZipInfo('cmdline-tools/bin/sdkmanager'); i.external_attr = (0o100755 << 16); i.create_system = 3; i.compress_type = zipfile.ZIP_DEFLATED
z.writestr(i, '#!/bin/sh\\necho hi\\n' * 500)
z.writestr(zipfile.ZipInfo('cmdline-tools/lib/a.txt'), 'stored data')
z.writestr('cmdline-tools/lib/b.bin', bytes(range(256)) * 100, compress_type=zipfile.ZIP_DEFLATED)
z.close()
`;
  execFileSync('python3', ['-I', '-c', py, zipFile]);
  const out = path.join(dir, 'out');
  extractZip(zipFile, out);
  const sm = path.join(out, 'cmdline-tools/bin/sdkmanager');
  assert.equal(fs.readFileSync(sm, 'utf8'), '#!/bin/sh\necho hi\n'.repeat(500));
  if (process.platform !== 'win32') assert.equal(fs.statSync(sm).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(out, 'cmdline-tools/lib/a.txt'), 'utf8'), 'stored data');
  const b = fs.readFileSync(path.join(out, 'cmdline-tools/lib/b.bin'));
  assert.equal(b.length, 25600);
  assert.equal(b[255], 255);
  const z = openZip(zipFile);
  assert.equal(z.entries.length, 4);
  z.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unzip refuses path traversal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdz-'));
  const zipFile = path.join(dir, 'evil.zip');
  execFileSync('python3', ['-I', '-c', "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../evil.txt','x'); z.close()", zipFile]);
  assert.throws(() => extractZip(zipFile, path.join(dir, 'out')), /unsafe path/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('splitUtf8 never splits a character', () => {
  const parts = splitUtf8('åäö'.repeat(200), 300);
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= 300);
  assert.equal(parts.join(''), 'åäö'.repeat(200));
});

test('AVD config patch sets the iPhone-friendly screen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdavd-'));
  const file = path.join(dir, 'config.ini');
  fs.writeFileSync(file, 'hw.lcd.width=1080\nhw.lcd.height=1920\nhw.keyboard=yes\nimage.sysdir.1=system-images/x/\n');
  const cfg = require('../lib/config').DEFAULTS;
  const s = new Setup({ ...cfg, dataDir: dir }, {});
  s.patchAvdConfig(file);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^hw\.lcd\.width=720$/m);
  assert.match(text, /^hw\.lcd\.height=1280$/m);
  assert.match(text, /^hw\.keyboard=no$/m);
  assert.match(text, /^PlayStore\.enabled=true$/m);
  assert.match(text, /^image\.sysdir\.1=system-images\/x\/$/m);
  assert.equal((text.match(/hw\.lcd\.width/g) || []).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('system image name follows the CPU', () => {
  const cfg = require('../lib/config').DEFAULTS;
  const s = new Setup({ ...cfg, dataDir: os.tmpdir() }, {});
  const expected = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  assert.equal(s.systemImage, `system-images;android-34;google_apis_playstore;${expected}`);
});

test('safeName strips paths and bad characters', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('a:b?.apk'), 'a_b_.apk');
  assert.equal(safeName(''), 'file');
});
