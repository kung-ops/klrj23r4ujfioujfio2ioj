'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { download } = require('../lib/download');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const body = crypto.randomBytes(300000);
const sha1 = crypto.createHash('sha1').update(body).digest('hex');

test('download accepts a server that gzips the file anyway (dl.google.com case)', async () => {
  const gz = zlib.gzipSync(body);
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    res.end(gz);
  });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'f.zip');
  await download(`http://127.0.0.1:${srv.address().port}/f.zip`, dest, { sha1, retries: 1 });
  assert.deepEqual(fs.readFileSync(dest), body);
  srv.close();
});

test('download asks for the raw file', async () => {
  let asked = null;
  const srv = await serve((req, res) => {
    asked = req.headers['accept-encoding'];
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'f.zip');
  await download(`http://127.0.0.1:${srv.address().port}/f.zip`, dest, { sha1, retries: 1 });
  assert.equal(asked, 'identity');
  assert.deepEqual(fs.readFileSync(dest), body);
  srv.close();
});

test('download still rejects a cut-off file', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'Content-Length': body.length });
    res.write(body.subarray(0, 1000));
    res.destroy();
  });
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'f.zip');
  await assert.rejects(download(`http://127.0.0.1:${srv.address().port}/f.zip`, dest, { retries: 1 }));
  assert.equal(fs.existsSync(dest), false);
  srv.close();
});

test('download rejects a wrong checksum', async () => {
  const srv = await serve((req, res) => res.end(body));
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dl-')), 'f.zip');
  await assert.rejects(download(`http://127.0.0.1:${srv.address().port}/f.zip`, dest, { sha1: '0'.repeat(40), retries: 1 }));
  srv.close();
});
