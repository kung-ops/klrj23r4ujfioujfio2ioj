'use strict';

const { run, runChecked, spawnProcess } = require('./proc');

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

class Adb {
  constructor(adbPath, env) {
    this.path = adbPath;
    this.env = env || process.env;
  }

  run(args, opts = {}) {
    return run(this.path, args, { env: this.env, ...opts });
  }

  runChecked(args, opts = {}) {
    return runChecked(this.path, args, { env: this.env, ...opts });
  }

  spawn(args) {
    return spawnProcess(this.path, args, { env: this.env });
  }

  async shell(serial, command, opts = {}) {
    const r = await this.run(['-s', serial, 'shell', command], { timeout: 60000, ...opts });
    return { ...r, stdout: r.stdout.replace(/\r\n/g, '\n') };
  }

  async devices() {
    const r = await this.run(['devices'], { timeout: 15000 });
    const out = [];
    for (const line of r.stdout.split(/\r?\n/).slice(1)) {
      const m = /^(\S+)\s+(\S+)/.exec(line.trim());
      if (m) out.push({ serial: m[1], state: m[2] });
    }
    return out;
  }

  startServer() {
    return this.run(['start-server'], { timeout: 30000 });
  }

  async isBooted(serial) {
    const r = await this.run(['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { timeout: 10000 });
    return r.code === 0 && r.stdout.trim() === '1';
  }

  // Resolves when the device reports boot completed. shouldAbort() can stop waiting early.
  async waitForBoot(serial, { timeoutMs = 15 * 60 * 1000, shouldAbort, onTick } = {}) {
    const start = Date.now();
    for (;;) {
      if (shouldAbort) {
        const why = shouldAbort();
        if (why) throw new Error(why);
      }
      if (await this.isBooted(serial).catch(() => false)) return;
      if (Date.now() - start > timeoutMs) throw new Error(`Android did not finish booting within ${Math.round(timeoutMs / 60000)} minutes`);
      if (onTick) onTick(Date.now() - start);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

module.exports = { Adb, shellQuote };
