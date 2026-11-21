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
    // The virtual phone lives next to everything else (same drive as the Sandroid folder).
    this.avdHome = path.resolve(config.android.avdHome || path.join(this.dataDir, 'avd'));
  }

  // Android's RAM: the configured size, but at most a quarter of this computer's memory (min 2 GB).
  effectiveRamMB() {
    const totalMB = Math.floor(os.totalmem() / 1048576);
    const quarter = Math.floor(totalMB / 4 / 512) * 512;
    return Math.min(this.config.android.ramMB, Math.max(2048, quarter));
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
    const env = { ...process.env, ANDROID_HOME: this.sdkRoot, ANDROID_SDK_ROOT: this.sdkRoot, ANDROID_AVD_HOME: this.avdHome };
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
    this.config.android.ramMB = this.effectiveRamMB();
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

  // Newer command-line tools (late 2026) ship Google's new "android" CLI; sdkmanager is only a
  // deprecated wrapper there. Returns the path of the new CLI, or null with older tools.
  findAndroidCli() {
    const root = path.join(this.sdkRoot, 'cmdline-tools', 'latest');
    const names = IS_WIN ? ['android.exe', 'android.bat', 'android.cmd'] : ['android'];
    const dirs = [path.join(root, 'bin'), root];
    for (const dir of dirs) for (const n of names) if (exists(path.join(dir, n)) && fs.statSync(path.join(dir, n)).isFile()) return path.join(dir, n);
    // search a little deeper (layout may change)
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {}
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile() && names.includes(e.name)) return full;
        if (e.isDirectory() && depth < 3 && e.name !== 'lib') stack.push([full, depth + 1]);
      }
    }
    return null;
  }

  async ensureCmdlineTools() {
    if (exists(this.paths.sdkmanager) || this.findAndroidCli()) return;
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

  licenseMarker() {
    return path.join(this.dataDir, 'android-licenses.ok');
  }

  licensesAccepted() {
    return exists(path.join(this.sdkRoot, 'licenses', 'android-sdk-license')) || exists(this.licenseMarker());
  }

  async ensureLicenses() {
    if (this.licensesAccepted()) return;
    if (!exists(this.paths.sdkmanager)) {
      // Only the new Android CLI is there; it has no separate license step.
      fs.writeFileSync(this.licenseMarker(), 'new android CLI\n');
      return;
    }
    const noLongerNeeded = (r) => /no longer needed|not needed anymore/i.test(`${r.stdout}\n${r.stderr}`);
    // First ask without typing anything: the new tools answer that licenses are no longer needed.
    const probe = await run(this.paths.sdkmanager, this.sdkArgs(['--licenses']), { env: this.env(), input: '', timeout: 5 * 60000 });
    if (noLongerNeeded(probe)) {
      log.info('These Android SDK tools no longer need a separate license step.');
      fs.writeFileSync(this.licenseMarker(), 'licenses step not needed\n');
      return;
    }
    if (this.licensesAccepted()) return;
    if (this.flags.acceptLicenses) {
      this.status('Accepting Android SDK licenses (--accept-licenses)…');
      await run(this.paths.sdkmanager, this.sdkArgs(['--licenses']), { env: this.env(), input: 'y\n'.repeat(100), timeout: 5 * 60000 });
    } else if (process.stdin.isTTY) {
      this.status('Waiting for you to accept the Android SDK licenses in the server window…');
      console.log('\n=== Android SDK licenses ===\nRead each license and type "y" + Enter to accept. Android cannot be installed without them.\n');
      await run(this.paths.sdkmanager, this.sdkArgs(['--licenses']), { env: this.env(), interactive: true });
    } else {
      throw new Error('The Android SDK licenses must be accepted: start the server once in a terminal, or add --accept-licenses.');
    }
    if (!this.licensesAccepted()) {
      throw new Error('The Android SDK license was not accepted. Start the server again and type "y" + Enter for each license, or start it with: node server.js --accept-licenses');
    }
  }

  // ---------- SDK packages ----------

  async installPackages(packages) {
    if (!packages.length) return;
    const label = packages.map((p) => p.split(';')[0]).join(', ');
    this.status(`Installing ${label}… (first time only, about 2 GB)`, 0);
    const cli = this.findAndroidCli();
    const attempts = [];
    if (cli) attempts.push({ tool: 'android', cmd: cli, args: [`--sdk=${this.sdkRoot}`, 'sdk', 'install', ...packages.map((p) => p.replace(/;/g, '/'))] });
    if (exists(this.paths.sdkmanager)) attempts.push({ tool: 'sdkmanager', cmd: this.paths.sdkmanager, args: this.sdkArgs(['--install', ...packages]) });
    if (!attempts.length) throw new Error('The Android SDK tools are missing. Delete the data/android-sdk folder and start the server again.');
    let lastError = null;
    for (const a of attempts) {
      log.info(`Using ${a.tool}: ${a.args.join(' ')}`);
      const r = await this.runInstaller(a.cmd, a.args, label);
      if (r.code === 0) return;
      const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-6).join('\n');
      lastError = new Error(`Installing ${label} failed:\n${tail}`);
      log.warn(`${a.tool} could not install the packages (exit ${r.code}).`);
    }
    throw lastError;
  }

  runInstaller(cmd, args, label) {
    let buf = '';
    const opts = {
      env: this.env(),
      onOutput: (s) => {
        buf += s;
        const parts = buf.split(/[\r\n]/);
        buf = parts.pop();
        for (const line of parts) {
          const m = /(\d+)%\s*(.*)$/.exec(line);
          if (m) this.status(`Installing Android: ${m[2].trim() || label}`, Number(m[1]) / 100);
          else if (!process.stdin.isTTY && /warning|error/i.test(line)) log.warn(`installer: ${line.trim()}`);
        }
      },
    };
    // Show the installer in this window so any question it asks can be answered.
    if (this.flags.acceptLicenses) opts.input = 'y\n'.repeat(50);
    else if (process.stdin.isTTY) opts.interactive = true;
    else opts.input = '';
    return run(cmd, args, opts);
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
    return [this.avdHome];
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
      if (exists(this.paths.avdmanager)) {
        const r = await run(this.paths.avdmanager, ['create', 'avd', '-n', a.avdName, '-k', this.systemImage, '-d', a.device, '--force'], {
          env: this.env(),
          input: 'no\n',
          timeout: 5 * 60000,
        }).catch((e) => ({ code: -1, stdout: '', stderr: e.message }));
        if (r.code !== 0) log.warn(`avdmanager did not work (${(r.stderr || r.stdout).trim().split(/\r?\n/).pop()}); creating the phone directly.`);
        dir = this.findAvdDir();
      }
      if (!dir) dir = this.writeAvd();
    }
    this.patchAvdConfig(path.join(dir, 'config.ini'));
  }

  // Creates the virtual phone the same way avdmanager does: <avd home>/<name>.ini + <name>.avd/config.ini
  writeAvd() {
    const a = this.config.android;
    const home = this.avdHomes()[0];
    const dir = path.join(home, `${a.avdName}.avd`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(home, `${a.avdName}.ini`),
      `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd${path.sep}${a.avdName}.avd\ntarget=android-${a.api}\n`,
    );
    const arm = this.abi.startsWith('arm64');
    const sysdir = ['system-images', `android-${a.api}`, a.tag, this.abi].join(path.sep) + path.sep;
    const lines = [
      `AvdId=${a.avdName}`,
      'avd.ini.displayname=Sandroid',
      'avd.ini.encoding=UTF-8',
      `abi.type=${this.abi}`,
      `hw.cpu.arch=${arm ? 'arm64' : 'x86_64'}`,
      'hw.cpu.ncore=4',
      `image.sysdir.1=${sysdir}`,
      `tag.id=${a.tag}`,
      `tag.display=${a.tag.includes('playstore') ? 'Google Play' : 'Google APIs'}`,
      'hw.accelerometer=yes',
      'hw.audioInput=yes',
      'hw.battery=yes',
      'hw.dPad=no',
      'hw.mainKeys=no',
      'hw.sdCard=no',
      'hw.sensors.orientation=yes',
      'hw.trackBall=no',
      'fastboot.forceColdBoot=no',
      'runtime.network.latency=none',
      'runtime.network.speed=full',
    ];
    fs.writeFileSync(path.join(dir, 'config.ini'), lines.join('\n') + '\n');
    log.info(`Created the Android phone in ${dir}`);
    return dir;
  }

  patchAvdConfig(file) {
    const a = this.config.android;
    const want = {
      'hw.lcd.width': String(a.width),
      'hw.lcd.height': String(a.height),
      'hw.lcd.density': String(a.density),
      'hw.ramSize': String(a.ramMB),
      'hw.cpu.ncore': String(Math.max(2, Math.min(6, Math.floor(os.cpus().length / 2)))),
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
