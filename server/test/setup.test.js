'use strict';

// Simulates Google's SDK tools with small shell scripts, to test the installer logic.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Setup } = require('../lib/setup');
const { DEFAULTS } = require('../lib/config');

const skip = process.platform === 'win32' ? 'uses shell scripts' : false;

function tempSetup(flags = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdsetup-'));
  const s = new Setup({ ...DEFAULTS, android: { ...DEFAULTS.android, abi: 'x86_64' }, dataDir }, flags);
  const bin = path.join(s.sdkRoot, 'cmdline-tools', 'latest', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  return { s, dataDir, bin };
}

function script(file, body) {
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

// What the new Android CLI would leave behind after "android sdk install".
const FAKE_INSTALL = `
echo "$@" >> "$(dirname "$0")/android-args.txt"
SDK=""
for a in "$@"; do case "$a" in --sdk=*) SDK="\${a#--sdk=}";; esac; done
mkdir -p "$SDK/platform-tools" "$SDK/emulator" "$SDK/system-images/android-34/google_apis_playstore/x86_64"
touch "$SDK/platform-tools/adb" "$SDK/emulator/emulator" "$SDK/system-images/android-34/google_apis_playstore/x86_64/source.properties"
echo "[=====     ] 50% Downloading x86_64-34.zip"
exit 0`;

test('new Android tools: no license step, installs with "android sdk install"', { skip }, async () => {
  const { s, bin } = tempSetup();
  script(path.join(bin, 'sdkmanager'), `echo "WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead."
echo "Warning: The --licenses option is no longer needed."
exit 0`);
  script(path.join(bin, 'android'), FAKE_INSTALL);
  await s.ensureLicenses();
  assert.ok(s.licensesAccepted());
  await s.ensurePackages();
  const args = fs.readFileSync(path.join(bin, 'android-args.txt'), 'utf8').trim();
  assert.equal(args, `--sdk=${s.sdkRoot} sdk install platform-tools emulator system-images/android-34/google_apis_playstore/x86_64`);
});

test('only the new CLI present: licenses skipped, still installs', { skip }, async () => {
  const { s, bin } = tempSetup();
  script(path.join(bin, 'android'), FAKE_INSTALL);
  assert.equal(s.findAndroidCli(), path.join(bin, 'android'));
  await s.ensureCmdlineTools(); // must not try to download again
  await s.ensureLicenses();
  await s.ensurePackages();
});

test('old tools: --accept-licenses answers the prompts', { skip }, async () => {
  const { s, bin } = tempSetup({ acceptLicenses: true });
  script(path.join(bin, 'sdkmanager'), `
ROOT=""; for a in "$@"; do case "$a" in --sdk_root=*) ROOT="\${a#--sdk_root=}";; esac; done
if [[ " $* " == *" --licenses "* ]]; then
  echo "Review license android-sdk-license:"; printf "Accept? (y/N): "
  read -r ans || ans=""
  if [ "$ans" = "y" ]; then mkdir -p "$ROOT/licenses"; echo hash > "$ROOT/licenses/android-sdk-license"; echo "All SDK package licenses accepted"; fi
  exit 0
fi`);
  await s.ensureLicenses();
  assert.ok(fs.existsSync(path.join(s.sdkRoot, 'licenses', 'android-sdk-license')));
});

test('old tools without a terminal or --accept-licenses: clear error', { skip }, async () => {
  const { s, bin } = tempSetup();
  script(path.join(bin, 'sdkmanager'), `printf "Accept? (y/N): "; read -r ans; exit 0`);
  const tty = process.stdin.isTTY;
  process.stdin.isTTY = false;
  try {
    await assert.rejects(s.ensureLicenses(), /--accept-licenses/);
  } finally {
    process.stdin.isTTY = tty;
  }
});

test('AVD is created directly when avdmanager is missing', { skip }, async () => {
  const { s, dataDir } = tempSetup();
  const old = process.env.ANDROID_AVD_HOME;
  process.env.ANDROID_AVD_HOME = path.join(dataDir, 'avd');
  try {
    assert.equal(s.findAvdDir(), null);
    await s.ensureAvd();
    const dir = s.findAvdDir();
    assert.ok(dir);
    const ini = fs.readFileSync(path.join(dataDir, 'avd', 'sandroid.ini'), 'utf8');
    assert.match(ini, /^target=android-34$/m);
    const cfg = fs.readFileSync(path.join(dir, 'config.ini'), 'utf8');
    assert.match(cfg, /^image\.sysdir\.1=system-images\/android-34\/google_apis_playstore\/x86_64\/$/m);
    assert.match(cfg, /^abi\.type=x86_64$/m);
    assert.match(cfg, /^PlayStore\.enabled=true$/m);
    assert.match(cfg, /^hw\.lcd\.width=720$/m);
  } finally {
    if (old === undefined) delete process.env.ANDROID_AVD_HOME;
    else process.env.ANDROID_AVD_HOME = old;
  }
});
