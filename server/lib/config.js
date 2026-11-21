'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  port: 8080,
  name: os.hostname(),
  pin: null,
  javaHome: null,
  android: {
    sdkRoot: null, // default: <data>/android-sdk
    api: 34, // Android 14
    tag: 'google_apis_playstore', // the image that includes Google Play
    abi: 'auto', // x86_64 on Intel/AMD, arm64-v8a on Apple Silicon
    avdName: 'sandroid',
    device: 'pixel',
    // 720x1280 has the same 16:9 shape as the iPhone 6 screen, so it fills it exactly.
    width: 720,
    height: 1280,
    density: 320,
    ramMB: 3072,
    dataPartition: '8G',
    gpu: 'auto', // auto | host | swiftshader_indirect | angle_indirect
    showWindow: false, // also open the emulator window on the computer
    stopOnExit: true,
    extraArgs: [],
  },
  stream: {
    maxSize: 1280,
    videoBitRate: 6000000,
    maxFps: 30,
    audio: true,
    iFrameInterval: 2,
  },
  camera: {
    enabled: 'auto', // auto | off   (needs Linux + v4l2loopback + ffmpeg)
    device: '/dev/video42',
    width: 640,
    height: 480,
    fps: 15,
  },
  device: null, // adb serial of an existing Android device/emulator to use instead of starting one
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function newPin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    flags[key] = m[2] === undefined ? true : m[2];
  }
  return flags;
}

function load(flags = {}) {
  const dataDir = path.resolve(flags.data || process.env.SANDROID_DATA || path.join(__dirname, '..', 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'config.json');
  let saved = {};
  if (fs.existsSync(file)) {
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`Could not read ${file}: ${e.message}`);
    }
  }
  const config = merge(DEFAULTS, saved);
  let changed = !fs.existsSync(file);
  if (!config.pin || flags.newPin) {
    config.pin = newPin();
    changed = true;
  }
  if (flags.pin && /^\d{4,12}$/.test(String(flags.pin))) {
    config.pin = String(flags.pin);
    changed = true;
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');

  // Command-line overrides (not saved).
  if (flags.port) config.port = Number(flags.port);
  if (flags.serial) config.device = String(flags.serial);
  if (flags.gpu) config.android.gpu = String(flags.gpu);
  if (flags.showWindow) config.android.showWindow = true;
  if (flags.noCamera) config.camera.enabled = 'off';
  if (flags.noAudio) config.stream.audio = false;
  if (flags.name) config.name = String(flags.name);

  config.dataDir = dataDir;
  config.configFile = file;
  return config;
}

module.exports = { load, parseArgs, DEFAULTS };
