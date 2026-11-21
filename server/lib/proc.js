'use strict';

const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';

function quoteWin(a) {
  a = String(a);
  if (/^[\w\-.:\\/=@+,]+$/.test(a)) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}

// Spawns a process. Windows .bat/.cmd files (sdkmanager, avdmanager) must go through the shell.
function spawnProcess(cmd, args = [], opts = {}) {
  const spawnOpts = {
    env: opts.env || process.env,
    cwd: opts.cwd,
    stdio: opts.stdio || ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !!opts.detached,
  };
  if (IS_WIN && /\.(bat|cmd)$/i.test(cmd)) {
    const line = [quoteWin(cmd), ...args.map(quoteWin)].join(' ');
    return spawn(line, { ...spawnOpts, shell: true });
  }
  return spawn(cmd, args, spawnOpts);
}

// Runs a process to completion. Never rejects on a non-zero exit code: check result.code.
//   opts.input: string written to stdin (then stdin is closed)
//   opts.inherit: show the process directly in this terminal (interactive)
//   opts.onOutput(text): called with every chunk of stdout/stderr
//   opts.timeout: ms before the process is killed
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(cmd, args, { ...opts, stdio: opts.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    const cap = (s, add) => (s.length > 4 * 1024 * 1024 ? s.slice(-2 * 1024 * 1024) + add : s + add);
    let timer = null;
    if (opts.timeout) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, opts.timeout);
    }
    if (!opts.inherit) {
      child.stdout.on('data', (d) => {
        const s = d.toString();
        stdout = cap(stdout, s);
        if (opts.onOutput) opts.onOutput(s);
      });
      child.stderr.on('data', (d) => {
        const s = d.toString();
        stderr = cap(stderr, s);
        if (opts.onOutput) opts.onOutput(s);
      });
      child.stdin.on('error', () => {});
      if (opts.input !== undefined) child.stdin.end(opts.input);
      else child.stdin.end();
    }
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, signal, stdout, stderr });
    });
  });
}

async function runChecked(cmd, args = [], opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const tail = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-8).join('\n');
    const name = require('path').basename(cmd);
    throw new Error(`${name} ${args.slice(0, 3).join(' ')} failed (exit ${r.code})${tail ? ':\n' + tail : ''}`);
  }
  return r;
}

module.exports = { run, runChecked, spawnProcess, IS_WIN };
