'use strict';

const fs = require('fs');
const { EventEmitter } = require('events');
const log = require('./log');
const { run, spawnProcess, IS_WIN } = require('./proc');

function kvmHelp() {
  return (
    'Android needs hardware virtualization (KVM), and /dev/kvm is missing or not accessible.\n' +
    '  1. Turn on virtualization (Intel VT-x / AMD-V) in the BIOS.\n' +
    '  2. sudo apt install qemu-kvm   (or your distro\'s package)\n' +
    '  3. sudo usermod -aG kvm $USER   then log out and back in.\n' +
    'Most cloud VPS servers do not support this.'
  );
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
    this.output = [];
    this.stopping = false;
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

  gpuMode() {
    const g = this.config.android.gpu;
    if (g && g !== 'auto') return g;
    // A server without a screen has no OpenGL; use the software renderer there.
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return 'swiftshader_indirect';
    return 'auto';
  }

  async start() {
    await this.adb.startServer();
    const running = await this.findRunning();
    if (running) {
      this.serial = running;
      this.status(`Using the Android that is already running (${running}).`);
      await this.afterBoot();
      return running;
    }
    await this.checkAcceleration();
    const port = await this.freeConsolePort();
    this.serial = `emulator-${port}`;
    const a = this.config.android;
    const args = ['-avd', this.env.avdName, '-port', String(port), '-no-boot-anim', '-gpu', this.gpuMode(), '-netdelay', 'none', '-netspeed', 'full'];
    if (!a.showWindow) args.push('-no-window');
    const webcam = this.camera && this.camera.webcamName;
    args.push('-camera-back', webcam || 'emulated', '-camera-front', 'emulated');
    args.push(...(a.extraArgs || []));
    this.status('Starting Android… (the first start can take a few minutes)');
    log.info(`emulator ${args.join(' ')}`);
    this.exitInfo = null;
    this.output = [];
    this.stopping = false;
    this.proc = spawnProcess(this.env.emulatorPath, args, { env: this.env.env });
    const onOut = (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.output.push(line);
        if (this.output.length > 60) this.output.shift();
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
      this.exitInfo = `the emulator stopped (exit ${code === null ? signal : code})`;
      this.proc = null;
      if (!this.stopping) this.emit('exit', this.exitInfo, this.output.slice(-15).join('\n'));
    });

    await this.adb.waitForBoot(this.serial, {
      shouldAbort: () => (this.exitInfo ? `${this.exitInfo}\n${this.output.slice(-12).join('\n')}` : null),
      onTick: (ms) => {
        if (ms > 0 && ms % 20000 < 2000) this.emit('status', `Booting Android… ${Math.round(ms / 1000)} s`);
      },
    });
    await this.afterBoot();
    this.status('Android is ready.');
    return this.serial;
  }

  // Small tweaks that make Android nicer to use from a phone. Failures are harmless.
  async afterBoot() {
    const cmds = [
      'settings put system screen_off_timeout 2147483647',
      'svc power stayon true',
      'wm dismiss-keyguard',
      'cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton',
      'mkdir -p /sdcard/Download',
    ];
    for (const c of cmds) await this.adb.shell(this.serial, c, { timeout: 20000 }).catch(() => {});
  }

  async stop() {
    this.stopping = true;
    if (!this.serial) return;
    await this.adb.run(['-s', this.serial, 'emu', 'kill'], { timeout: 15000 }).catch(() => {});
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
  }
}

module.exports = { Emulator };
