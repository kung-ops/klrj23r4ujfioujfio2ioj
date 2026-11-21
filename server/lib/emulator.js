'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const log = require('./log');
const { run, spawnProcess, IS_WIN } = require('./proc');

const GB = 1024 * 1024 * 1024;

function kvmHelp() {
  return (
    'Android needs hardware virtualization (KVM), and /dev/kvm is missing or not accessible.\n' +
    '  1. Turn on virtualization (Intel VT-x / AMD-V) in the BIOS.\n' +
    "  2. sudo apt install qemu-kvm   (or your distro's package)\n" +
    '  3. sudo usermod -aG kvm $USER   then log out and back in.\n' +
    'Most cloud VPS servers do not support this.'
  );
}

// Plain-language meaning of the Windows crash codes the emulator is known to exit with.
function explainExit(code) {
  const hex = typeof code === 'number' && code > 0xffff ? '0x' + (code >>> 0).toString(16).toUpperCase() : null;
  switch (hex) {
    case '0xC0000006':
      return 'Windows could not read data it needed (in-page error). Usually the disk is full or slow (USB drive), Windows ran out of memory + page file, or antivirus blocked the file.';
    case '0xC0000005':
      return 'The emulator crashed (access violation). This is often the graphics driver.';
    case '0xC0000135':
    case '0xC0000139':
      return 'A Windows system file is missing. Install the "Microsoft Visual C++ Redistributable (x64)" from Microsoft, then try again.';
    case '0xC0000409':
      return 'The emulator stopped itself because of an internal error. This is often the graphics driver.';
    case '0xC0000017':
    case '0xC000012D':
      return 'Windows ran out of memory (RAM + page file).';
    default:
      return null;
  }
}

function freeBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function sizeToBytes(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGT]?)/i.exec(String(text || ''));
  if (!m) return 6 * GB;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: GB, T: 1024 * GB }[m[2].toUpperCase()];
  return Number(m[1]) * mult;
}

const fmtGB = (b) => `${(b / GB).toFixed(1)} GB`;

// Start-up modes, tried in order until Android boots.
//   normal: the emulator picks the graphics (fastest when it works)
//   angle:  Windows only - graphics card through DirectX instead of OpenGL drivers, no quick-boot file
//   safe:   software graphics (slow but works almost everywhere), no quick-boot file, 2 GB RAM
// The stream is made lighter in safe mode, because the CPU also draws the screen there.
const PROFILES = {
  normal: { name: 'normal', safe: false, gpu: null, noSnapshot: false },
  angle: { name: 'angle', safe: false, gpu: 'angle_indirect', noSnapshot: true },
  safe: { name: 'safe', safe: true, gpu: 'swiftshader_indirect', noSnapshot: true, stream: { maxSize: 960, maxFps: 24, videoBitRate: 3000000 } },
};

function profileOrder(start) {
  const all = IS_WIN ? ['normal', 'angle', 'safe'] : ['normal', 'safe'];
  const i = Math.max(0, all.indexOf(start));
  return all.slice(i).map((n) => PROFILES[n]);
}

class Emulator extends EventEmitter {
  constructor({ config, env, adb, camera }) {
    super();
    this.config = config;
    this.env = env;
    this.adb = adb;
    this.camera = camera;
    this.proc = null;
    this.serial = null;
    this.exitInfo = null;
    this.exitCode = null;
    this.output = [];
    this.stopping = false;
    this.booted = false;
    this.logFile = path.join(config.dataDir || os.tmpdir(), 'emulator.log');
  }

  status(msg) {
    this.emit('status', msg);
    log.info(msg);
  }

  async checkAcceleration() {
    if (process.platform === 'linux') {
      try {
        fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        throw new Error(kvmHelp());
      }
    }
    const r = await run(this.env.emulatorPath, ['-accel-check'], { env: this.env.env, timeout: 60000 }).catch(() => null);
    if (r) {
      const text = (r.stdout + r.stderr).trim();
      log.info(`Emulator acceleration: ${text.split(/\r?\n/).slice(-2).join(' ')}`);
      if (r.code !== 0 && IS_WIN) {
        log.warn(
          'Hardware acceleration looks unavailable. On Windows turn on "Windows Hypervisor Platform" in ' +
            '"Turn Windows features on or off", then restart the PC.',
        );
      }
    }
  }

  // Android needs room for its data disk (+ a RAM snapshot when quick boot is on).
  checkResources(profile) {
    const a = this.config.android;
    const avdDir = this.env.avdDir || (this.env.env && this.env.env.ANDROID_AVD_HOME) || this.config.dataDir;
    const free = freeBytes(avdDir);
    const firstBoot = !fs.existsSync(path.join(avdDir, 'userdata-qemu.img'));
    const need = (firstBoot ? sizeToBytes(a.dataPartition) : 0) + (profile.safe ? 0 : a.ramMB * 1024 * 1024) + 1.5 * GB;
    const total = os.totalmem();
    const freeRam = os.freemem();
    log.info(
      `Computer: ${fmtGB(total)} RAM (${fmtGB(freeRam)} free), ${free === null ? '?' : fmtGB(free)} free disk at ${avdDir}`,
    );
    if (free !== null && free < need) {
      throw new Error(
        `Not enough free disk space for Android: ${fmtGB(free)} free on the drive with ${avdDir}, about ${fmtGB(need)} needed. ` +
          'Free up space on that drive, or move the Sandroid folder to a drive with more space.',
      );
    }
  }

  async findRunning() {
    const name = this.env.avdName;
    for (const d of await this.adb.devices().catch(() => [])) {
      if (!d.serial.startsWith('emulator-') || d.state !== 'device') continue;
      const r = await this.adb.run(['-s', d.serial, 'emu', 'avd', 'name'], { timeout: 10000 }).catch(() => null);
      if (r && r.stdout.split(/\r?\n/)[0].trim() === name) return d.serial;
    }
    return null;
  }

  async freeConsolePort() {
    const used = new Set((await this.adb.devices().catch(() => [])).map((d) => d.serial));
    for (let p = 5554; p <= 5584; p += 2) if (!used.has(`emulator-${p}`)) return p;
    throw new Error('No free emulator port between 5554 and 5584.');
  }

  gpuMode(profile) {
    if (profile && profile.gpu) return profile.gpu;
    const g = this.config.android.gpu;
    if (g && g !== 'auto') return g;
    // A server without a screen has no OpenGL; use the software renderer there.
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'swiftshader_indirect';
    return 'auto';
  }

  buildArgs(port, profile) {
    const a = this.config.android;
    const args = ['-avd', this.env.avdName, '-port', String(port), '-no-boot-anim', '-gpu', this.gpuMode(profile), '-netdelay', 'none', '-netspeed', 'full'];
    if (profile.noSnapshot) args.push('-no-snapshot', '-memory', String(Math.min(a.ramMB, 2048)));
    if (!a.showWindow) args.push('-no-window');
    const webcam = this.camera && this.camera.webcamName;
    args.push('-camera-back', webcam || 'emulated', '-camera-front', 'emulated');
    args.push(...(a.extraArgs || []));
    return args;
  }

  crashMessage() {
    const why = explainExit(this.exitCode);
    const important = this.output.filter((l) => /ERROR|FATAL|PANIC|WARNING|fail|crash/i.test(l) && !/^INFO\b/.test(l)).slice(-8);
    const lines = important.length ? important : this.output.slice(-6);
    return [`${this.exitInfo}.`, why, lines.length ? lines.join('\n') : null, `Full emulator log: ${this.logFile}`].filter(Boolean).join('\n');
  }

  async start(profile = PROFILES.normal) {
    this.booted = false;
    await this.adb.startServer();
    const running = await this.findRunning();
    if (running) {
      this.serial = running;
      this.status(`Using the Android that is already running (${running}).`);
      await this.afterBoot();
      this.booted = true;
      return running;
    }
    await this.checkAcceleration();
    this.checkResources(profile);
    const port = await this.freeConsolePort();
    this.serial = `emulator-${port}`;
    const args = this.buildArgs(port, profile);
    this.status(
      profile.safe
        ? 'Starting Android in safe mode (software graphics)… this takes a few minutes'
        : profile.name === 'angle'
          ? 'Starting Android with DirectX graphics… this takes a few minutes'
          : 'Starting Android… (the first start can take a few minutes)',
    );
    log.info(`emulator ${args.join(' ')}`);
    this.exitInfo = null;
    this.exitCode = null;
    this.output = [];
    this.stopping = false;

    let logStream = null;
    try {
      logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
      logStream.on('error', () => {});
      logStream.write(`\n===== ${new Date().toISOString()} emulator ${args.join(' ')}\n`);
    } catch {}

    this.proc = spawnProcess(this.env.emulatorPath, args, { env: this.env.env });
    const onOut = (d) => {
      if (logStream) logStream.write(d);
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.output.push(line);
        if (this.output.length > 200) this.output.shift();
        if (/ERROR|FATAL|PANIC/.test(line)) log.warn(`[emulator] ${line.trim()}`);
        else log.debug(`[emulator] ${line.trim()}`);
      }
    };
    this.proc.stdout.on('data', onOut);
    this.proc.stderr.on('data', onOut);
    this.proc.on('error', (e) => {
      this.exitInfo = `could not start the emulator: ${e.message}`;
    });
    this.proc.on('exit', (code, signal) => {
      this.exitCode = code;
      const hex = typeof code === 'number' && code > 0xffff ? ` = 0x${(code >>> 0).toString(16).toUpperCase()}` : '';
      this.exitInfo = `the emulator stopped (exit ${code === null ? signal : code}${hex})`;
      this.proc = null;
      if (logStream) logStream.end(`\n===== ${this.exitInfo}\n`);
      // Crashes while starting are reported by start(); this is for crashes after Android was up.
      if (!this.stopping && this.booted) this.emit('exit', this.crashMessage());
    });

    await this.adb.waitForBoot(this.serial, {
      shouldAbort: () => (this.exitInfo ? this.crashMessage() : null),
      onTick: (ms) => {
        if (ms > 0 && ms % 20000 < 2000) this.emit('status', `Booting Android… ${Math.round(ms / 1000)} s`);
      },
    });
    await this.afterBoot();
    this.booted = true;
    this.status('Android is ready.');
    return this.serial;
  }

  // Tries the remembered mode (or normal) first, then the safer ones. Returns { serial, profile }.
  async startWithFallback({ startMode = 'normal' } = {}) {
    const order = profileOrder(startMode);
    let lastError = null;
    for (let i = 0; i < order.length; i++) {
      try {
        const serial = await this.start(order[i]);
        return { serial, profile: order[i] };
      } catch (e) {
        lastError = e;
        if (/Not enough free disk space|hardware virtualization/.test(e.message)) throw e; // retrying won't help
        log.error(`Android did not start (${order[i].name} mode):\n${e.message}`);
        await this.stop().catch(() => {});
        if (i < order.length - 1) this.status(`Android crashed while starting. Trying again (${order[i + 1].name} mode)…`);
      }
    }
    throw lastError;
  }

  // Small tweaks that make Android nicer to use from a phone. Failures are harmless.
  async afterBoot() {
    const cmds = [
      'settings put system screen_off_timeout 2147483647',
      'svc power stayon true',
      'wm dismiss-keyguard',
      'cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton',
      'mkdir -p /sdcard/Download',
      // shorter animations = less drawing = feels faster over the stream
      'settings put global window_animation_scale 0.5',
      'settings put global transition_animation_scale 0.5',
      'settings put global animator_duration_scale 0.5',
    ];
    for (const c of cmds) await this.adb.shell(this.serial, c, { timeout: 20000 }).catch(() => {});
  }

  async stop() {
    this.stopping = true;
    if (!this.serial) return;
    if (this.proc || this.booted) await this.adb.run(['-s', this.serial, 'emu', 'kill'], { timeout: 15000 }).catch(() => {});
    const proc = this.proc;
    if (proc) {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
          resolve();
        }, 20000);
        proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    this.proc = null;
    this.booted = false;
  }
}

module.exports = { Emulator, PROFILES, profileOrder, explainExit, sizeToBytes };
