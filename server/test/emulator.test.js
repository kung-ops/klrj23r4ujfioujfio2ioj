'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Emulator, explainExit, sizeToBytes } = require('../lib/emulator');
const { Adb } = require('../lib/adb');
const { DEFAULTS } = require('../lib/config');

const skip = process.platform === 'win32' ? 'uses shell scripts' : false;

test('explains the Windows crash code from the log (3221225478)', () => {
  assert.match(explainExit(3221225478), /in-page error/);
  assert.match(explainExit(3221225477), /graphics driver/);
  assert.equal(explainExit(1), null);
  assert.equal(sizeToBytes('8G'), 8 * 1024 ** 3);
});

test('crash in normal mode -> retries in safe mode and boots', { skip, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdemu-'));
  const fake = path.join(dir, 'emulator');
  fs.writeFileSync(
    fake,
    `#!/bin/bash
if [ "$1" = "-accel-check" ]; then echo "accel: WHPX is installed and usable."; exit 0; fi
if [[ " $* " == *" swiftshader_indirect "* ]]; then echo "INFO | booting in software mode"; sleep 60; exit 0; fi
echo "INFO | androidboot.qemu.skin=720x1280"; echo "ERROR | graphics driver went away"; exit 5
`,
  );
  fs.chmodSync(fake, 0o755);
  const config = { ...DEFAULTS, android: { ...DEFAULTS.android, gpu: 'host', ramMB: 64, dataPartition: '1M' }, dataDir: dir };
  let emulator = null;
  let lastSpawn = 0;
  const adb = Object.assign(Object.create(Adb.prototype), {
    startServer: async () => {},
    devices: async () => [],
    shell: async () => ({ code: 0, stdout: '' }),
    run: async (args) => {
      if (args.includes('kill') && emulator.proc) emulator.proc.kill();
      return { code: 0, stdout: '', stderr: '' };
    },
    isBooted: async () => !!emulator.proc && Date.now() - lastSpawn > 1000,
  });
  emulator = new Emulator({ config, env: { emulatorPath: fake, env: process.env, avdName: 'sandroid', avdDir: dir }, adb, camera: null });
  const realCheck = emulator.checkAcceleration.bind(emulator);
  emulator.checkAcceleration = async () => (fs.existsSync('/dev/kvm') ? realCheck() : undefined); // this sandbox has no KVM
  const build = emulator.buildArgs.bind(emulator);
  const seen = [];
  emulator.buildArgs = (port, profile) => {
    lastSpawn = Date.now();
    const args = build(port, profile);
    seen.push(args.join(' '));
    return args;
  };
  const { serial, profile } = await emulator.startWithFallback();
  assert.equal(serial, 'emulator-5554');
  assert.equal(profile.name, 'safe');
  assert.equal(seen.length, 2);
  assert.match(seen[0], /-gpu host/);
  assert.doesNotMatch(seen[0], /-no-snapshot/);
  assert.match(seen[1], /-gpu swiftshader_indirect .*-no-snapshot -memory 64/);
  const logText = fs.readFileSync(path.join(dir, 'emulator.log'), 'utf8');
  assert.match(logText, /graphics driver went away/);
  assert.match(logText, /the emulator stopped \(exit 5\)/);
  await emulator.stop();
});

test('not enough disk space gives a clear message', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdemu-'));
  const config = { ...DEFAULTS, android: { ...DEFAULTS.android, dataPartition: '100000G' }, dataDir: dir };
  const e = new Emulator({ config, env: { avdDir: dir, avdName: 'x' }, adb: null, camera: null });
  assert.throws(() => e.checkResources({ safe: true }), /Not enough free disk space/);
});
