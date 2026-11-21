'use strict';

// Downloads and installs everything Android needs, the first time the server starts:
//   Java 17 (only if none is installed) -> Android command-line tools -> platform-tools,
//   emulator, Google Play system image -> the "sandroid" virtual device -> scrcpy-server.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const log = require('./log');
const { run, runChecked, IS_WIN } = require('./proc');
const { download, fetchText } = require('./download');
const { extractZip } = require('./unzip');
const scrcpy = require('./scrcpy');

const REPO_XML = 'https://dl.google.com/android/repository/repository2-3.xml';
const REPO_BASE = 'https://dl.google.com/android/repository/';
const FALLBACK_CMDLINE_BUILDS = ['13114758', '11076708'];

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function mb(n) {
  return `${(n / 1048576).toFixed(0)} MB`;
}

class Setup extends EventEmitter {
  constructor(config, flags = {}) {
    super();
    this.config = config;
    this.flags = flags;
    this.dataDir = config.dataDir;
    this.downloads = path.join(this.dataDir, 'downloads');
    this.sdkRoot = path.resolve(config.android.sdkRoot || path.join(this.dataDir, 'android-sdk'));
    this.exe = IS_WIN ? '.exe' : '';
    this.bat = IS_WIN ? '.bat' : '';
    this.javaHome = null;
    this._lastPct = -1;
  }

  status(message, progress = null) {
    this.emit('status', message, progress);
    if (progress === null) {
      log.info(message);
      this._lastPct = -1;
    } else {
      const pct = Math.floor(progress * 100);
      if (pct >= this._lastPct + 10 || pct === 100) {
        this._lastPct = pct;
        log.info(`${message} ${pct}%`);
      }
    }
  }

  get abi() {
    const a = this.config.android.abi;
    if (a && a !== 'auto') return a;
    return process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  }

  get systemImage() {
    const { api, tag } = this.config.android;
    return `system-images;android-${api};${tag};${this.abi}`;
  }

  get paths() {
    const cl = path.join(this.sdkRoot, 'cmdline-tools', 'latest', 'bin');
    const { api, tag } = this.config.android;
    return {
      sdkmanager: path.join(cl, 'sdkmanager' + this.bat),
      avdmanager: path.join(cl, 'avdmanager' + this.bat),
      adb: path.join(this.sdkRoot, 'platform-tools', 'adb' + this.exe),
      emulator: path.join(this.sdkRoot, 'emulator', 'emulator' + this.exe),
      image: path.join(this.sdkRoot, 'system-images', `android-${api}`, tag, this.abi),
      scrcpyServer: path.join(this.dataDir, `scrcpy-server-v${scrcpy.VERSION}`),
    };
  }

  env() {
    const env = { ...process.env, ANDROID_HOME: this.sdkRoot, ANDROID_SDK_ROOT: this.sdkRoot };
    if (this.javaHome) {
      env.JAVA_HOME = this.javaHome;
      env.PATH = path.join(this.javaHome, 'bin') + path.delimiter + (process.env.PATH || '');
    }
    return env;
  }

  checkHost() {
    const { platform, arch } = process;
    if (platform === 'linux' && arch !== 'x64') {
      throw new Error(
        `Google's Android emulator does not run on Linux ${arch}. Use a 64-bit Intel/AMD PC or a Mac, ` +
          'or connect a real Android phone with USB debugging and start the server with --serial=<adb serial>.',
      );
    }
    if (platform === 'win32' && arch !== 'x64') log.warn(`Windows on ${arch} is not officially supported by the Android emulator.`);
    if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unsupported operating system: ${platform}`);
  }

  async run() {
    this.checkHost();
    await this.ensureJava();
    await this.ensureCmdlineTools();
    await this.ensureLicenses();
    await this.ensurePackages();
    await this.ensureAvd();
    await this.ensureScrcpyServer();
    const p = this.paths;
    return {
      sdkRoot: this.sdkRoot,
      env: this.env(),
      adbPath: p.adb,
      emulatorPath: p.emulator,
      avdName: this.config.android.avdName,
      avdDir: this.findAvdDir(),
      serverJar: p.scrcpyServer,
    };
  }

  // Only adb + scrcpy-server are needed when streaming an existing device (--serial).
  async runForExistingDevice() {
    this.checkHostLight();
    await this.ensureJava();
    await this.ensureCmdlineTools();
    await this.ensureLicenses();
    await this.installPackages(['platform-tools'].filter(() => !exists(this.paths.adb)));
    await this.ensureScrcpyServer();
    return { sdkRoot: this.sdkRoot, env: this.env(), adbPath: this.paths.adb, serverJar: this.paths.scrcpyServer };
  }

  checkHostLight() {
    if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw new Error(`Unsupported operating system: ${process.platform}`);
  }

  // ---------- Java ----------

  async javaVersion(javaBin) {
    try {
      const r = await run(javaBin, ['-XshowSettings:properties', '-version'], { timeout: 20000 });
      if (r.code !== 0) return null;
      const text = r.stderr + r.stdout;
      const v = /version "(\d+)(?:\.(\d+))?/.exec(text);
      const home = /java\.home = (.+)/.exec(text);
      if (!v) return null;
      let major = Number(v[1]);
      if (major === 1 && v[2]) major = Number(v[2]);
      return { major, home: home ? home[1].trim() : null };
    } catch {
      return null;
    }
  }

  async ensureJava() {
    this.status('Checking Java…');
    const candidates = [this.config.javaHome, process.env.JAVA_HOME, this.findBundledJdk()].filter(Boolean);
    for (const home of candidates) {
      const v = await this.javaVersion(path.join(home, 'bin', 'java' + this.exe));
      if (v && v.major >= 17) {
        this.javaHome = home;
        return;
      }
    }
    const sys = await this.javaVersion('java');
    if (sys && sys.major >= 17 && sys.home) {
      this.javaHome = sys.home;
      return;
    }
    await this.installJdk();
  }

  findBundledJdk() {
    const root = path.join(this.dataDir, 'jdk');
    if (!exists(root)) return null;
    const java = 'java' + this.exe;
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      if (exists(path.join(dir, 'bin', java))) return dir;
      if (depth >= 3) continue;
      let names = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {}
      for (const d of names) if (d.isDirectory()) stack.push([path.join(dir, d.name), depth + 1]);
    }
    return null;
  }

  async installJdk() {
    const osName = { linux: 'linux', darwin: 'mac', win32: 'windows' }[process.platform];
    const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
    if (!arch) throw new Error(`No Java download for ${process.arch}; install Java 17 or newer yourself.`);
    const url = `https://api.adoptium.net/v3/binary/latest/17/ga/${osName}/${arch}/jdk/hotspot/normal/eclipse`;
    const file = path.join(this.downloads, IS_WIN ? 'jdk17.zip' : 'jdk17.tar.gz');
    this.status('Downloading Java 17…', 0);
    await download(url, file, { onProgress: (d, t) => this.status(`Downloading Java 17 (${mb(d)})…`, t ? d / t : null) });
    const dest = path.join(this.dataDir, 'jdk');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    this.status('Unpacking Java…');
    if (IS_WIN) extractZip(file, dest);
    else await runChecked('tar', ['-xzf', file, '-C', dest]);
    const home = this.findBundledJdk();
    if (!home) throw new Error('Java was downloaded but could not be found after unpacking.');
    this.javaHome = home;
    fs.rmSync(file, { force: true });
  }

  // ---------- Android command-line tools ----------

  async cmdlineToolsUrl() {
    const hostOs = { linux: 'linux', darwin: 'macosx', win32: 'windows' }[process.platform];
    try {
      const xml = await fetchText(REPO_XML);
      const blocks = [...xml.matchAll(/<remotePackage path="cmdline-tools;latest">([\s\S]*?)<\/remotePackage>/g)].map((m) => m[1]);
      const block = blocks.find((b) => /channel-0/.test(b)) || blocks[0];
      if (block) {
        for (const a of block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
          const url = /<url>([^<]+)<\/url>/.exec(a[1]);
          const host = /<host-os>([^<]+)<\/host-os>/.exec(a[1]);
          const sha1 = /<checksum type="sha1">([0-9a-f]+)<\/checksum>/.exec(a[1]);
          if (url && host && host[1] === hostOs) return [{ url: REPO_BASE + url[1], sha1: sha1 ? sha1[1] : null }];
        }
      }
    } catch (e) {
      log.warn(`Could not read the Android repository list (${e.message}); using a known version.`);
    }
    const name = { linux: 'linux', darwin: 'mac', win32: 'win' }[process.platform];
    return FALLBACK_CMDLINE_BUILDS.map((b) => ({ url: `${REPO_BASE}commandlinetools-${name}-${b}_latest.zip`, sha1: null }));
  }

  async ensureCmdlineTools() {
    if (exists(this.paths.sdkmanager)) return;
    const file = path.join(this.downloads, 'cmdline-tools.zip');
    let lastErr;
    for (const { url, sha1 } of await this.cmdlineToolsUrl()) {
      try {
        this.status('Downloading Android SDK tools…', 0);
        await download(url, file, { sha1, onProgress: (d, t) => this.status(`Downloading Android SDK tools (${mb(d)})…`, t ? d / t : null) });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    this.status('Unpacking Android SDK tools…');
    const tmp = path.join(this.sdkRoot, 'cmdline-tools', '_unpack');
    fs.rmSync(tmp, { recursive: true, force: true });
    extractZip(file, tmp);
    const inner = exists(path.join(tmp, 'cmdline-tools')) ? path.join(tmp, 'cmdline-tools') : tmp;
    const latest = path.join(this.sdkRoot, 'cmdline-tools', 'latest');
    fs.rmSync(latest, { recursive: true, force: true });
    fs.renameSync(inner, latest);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!IS_WIN) {
      for (const f of fs.readdirSync(path.join(latest, 'bin'))) fs.chmodSync(path.join(latest, 'bin', f), 0o755);
    }
    fs.rmSync(file, { force: true });
  }

  sdkArgs(args) {
    return [`--sdk_root=${this.sdkRoot}`, ...args];
  }

  // ---------- licenses ----------

  async ensureLicenses() {
    const accepted = exists(path.join(this.sdkRoot, 'licenses', 'android-sdk-license'));
    if (this.flags.acceptLicenses) {
      this.status('Accepting Android SDK licenses (--accept-licenses)…');
      await run(this.paths.sdkmanager, this.sdkArgs(['--licenses']), { env: this.env(), input: 'y\n'.repeat(100), timeout: 5 * 60000 });
      return;
    }
    if (accepted) return;
    if (process.stdin.isTTY) {
      this.status('Waiting for you to accept the Android SDK licenses in the server window…');
      console.log('\n=== Android SDK licenses ===\nRead each license and type "y" to accept. Android cannot be installed without them.\n');
      await run(this.paths.sdkmanager, this.sdkArgs(['--licenses']), { env: this.env(), inherit: true });
      if (!exists(path.join(this.sdkRoot, 'licenses', 'android-sdk-license'))) throw new Error('The Android SDK license was not accepted.');
      return;
    }
    throw new Error('The Android SDK licenses must be accepted: start the server once in a terminal, or add --accept-licenses.');
  }

  // ---------- SDK packages ----------

  async installPackages(packages) {
    if (!packages.length) return;
    const label = packages.map((p) => p.split(';')[0]).join(', ');
    this.status(`Installing ${label}… (first time only, about 2 GB)`, 0);
    let buf = '';
    const r = await run(this.paths.sdkmanager, this.sdkArgs(['--install', ...packages]), {
      env: this.env(),
      input: this.flags.acceptLicenses ? 'y\n'.repeat(20) : '',
      onOutput: (s) => {
        buf += s;
        const parts = buf.split(/[\r\n]/);
        buf = parts.pop();
        for (const line of parts) {
          const m = /(\d+)%\s*(.*)$/.exec(line);
          if (m) this.status(`Installing Android: ${m[2].trim() || label}`, Number(m[1]) / 100);
          else if (/warning|error/i.test(line)) log.warn(`sdkmanager: ${line.trim()}`);
        }
      },
    });
    if (r.code !== 0) {
      const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-6).join('\n');
      throw new Error(`Installing ${label} failed:\n${tail}`);
    }
  }

  async ensurePackages() {
    const p = this.paths;
    const need = [];
    if (!exists(p.adb)) need.push('platform-tools');
    if (!exists(p.emulator)) need.push('emulator');
    if (!exists(path.join(p.image, 'source.properties'))) need.push(this.systemImage);
    await this.installPackages(need);
    if (!exists(path.join(p.image, 'system.img')) && !exists(path.join(p.image, 'source.properties'))) {
      throw new Error(`The Android system image (${this.systemImage}) is not installed. If a license was declined, run again with --accept-licenses.`);
    }
  }

  // ---------- virtual device ----------

  avdHomes() {
    const homes = [];
    if (process.env.ANDROID_AVD_HOME) homes.push(process.env.ANDROID_AVD_HOME);
    if (process.env.ANDROID_USER_HOME) homes.push(path.join(process.env.ANDROID_USER_HOME, 'avd'));
    if (process.env.ANDROID_SDK_HOME) homes.push(path.join(process.env.ANDROID_SDK_HOME, '.android', 'avd'));
    if (process.env.ANDROID_EMULATOR_HOME) homes.push(path.join(process.env.ANDROID_EMULATOR_HOME, 'avd'));
    homes.push(path.join(os.homedir(), '.android', 'avd'));
    return homes;
  }

  findAvdDir() {
    const name = this.config.android.avdName;
    for (const home of this.avdHomes()) {
      const ini = path.join(home, `${name}.ini`);
      if (exists(ini)) {
        const m = /^path=(.*)$/m.exec(fs.readFileSync(ini, 'utf8'));
        const dir = m ? m[1].trim() : path.join(home, `${name}.avd`);
        if (exists(path.join(dir, 'config.ini'))) return dir;
      }
      const dir = path.join(home, `${name}.avd`);
      if (exists(path.join(dir, 'config.ini'))) return dir;
    }
    return null;
  }

  async ensureAvd() {
    const a = this.config.android;
    let dir = this.findAvdDir();
    if (!dir) {
      this.status('Creating the Android phone…');
      await runChecked(
        this.paths.avdmanager,
        ['create', 'avd', '-n', a.avdName, '-k', this.systemImage, '-d', a.device, '--force'],
        { env: this.env(), input: 'no\n', timeout: 5 * 60000 },
      );
      dir = this.findAvdDir();
      if (!dir) throw new Error('The Android virtual device was created but its folder could not be found.');
    }
    this.patchAvdConfig(path.join(dir, 'config.ini'));
  }

  patchAvdConfig(file) {
    const a = this.config.android;
    const want = {
      'hw.lcd.width': String(a.width),
      'hw.lcd.height': String(a.height),
      'hw.lcd.density': String(a.density),
      'hw.ramSize': String(a.ramMB),
      'disk.dataPartition.size': String(a.dataPartition),
      'hw.keyboard': 'no', // keep the Android on-screen keyboard working inside the stream
      'hw.gpu.enabled': 'yes',
      'hw.audioInput': 'yes',
      'hw.audioOutput': 'yes',
      'hw.camera.front': 'emulated',
      'PlayStore.enabled': a.tag.includes('playstore') ? 'true' : 'false',
      showDeviceFrame: 'no',
    };
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const seen = new Set();
    const out = lines.map((line) => {
      const m = /^([^=#\s][^=]*?)\s*=\s*(.*)$/.exec(line);
      if (m && Object.prototype.hasOwnProperty.call(want, m[1])) {
        seen.add(m[1]);
        return `${m[1]}=${want[m[1]]}`;
      }
      return line;
    });
    for (const [k, v] of Object.entries(want)) if (!seen.has(k)) out.push(`${k}=${v}`);
    const text = out.filter((l, i) => l !== '' || i < out.length - 1).join('\n') + '\n';
    fs.writeFileSync(file, text);
  }

  // ---------- scrcpy-server ----------

  async ensureScrcpyServer() {
    const file = this.paths.scrcpyServer;
    if (exists(file)) return;
    this.status('Downloading the screen streamer (scrcpy-server)…');
    await download(scrcpy.SERVER_URL, file, { sha256: scrcpy.SERVER_SHA256 });
  }
}

module.exports = { Setup };
