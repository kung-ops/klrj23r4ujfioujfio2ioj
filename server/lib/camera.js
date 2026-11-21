'use strict';

// Sends the iPhone camera into Android as its back camera.
// Linux only: a v4l2loopback virtual webcam fed by ffmpeg, which the emulator opens as "webcamN".
//   sudo apt install v4l2loopback-dkms ffmpeg
//   sudo modprobe v4l2loopback video_nr=42 card_label=SandroidCam exclusive_caps=1

const fs = require('fs');
const path = require('path');
const log = require('./log');
const { run, spawnProcess } = require('./proc');

class Camera {
  constructor(config, env) {
    this.cfg = config.camera;
    this.dataDir = config.dataDir;
    this.env = env;
    this.available = false;
    this.reason = 'not started';
    this.webcamName = null;
    this.ffmpeg = null;
    this.placeholder = null;
    this.lastPhoneFrame = 0;
    this.timer = null;
  }

  status() {
    return { available: this.available, reason: this.available ? null : this.reason };
  }

  async init() {
    if (this.cfg.enabled === 'off') {
      this.reason = 'The camera is turned off in the server config.';
      return;
    }
    if (process.platform !== 'linux') {
      this.reason = 'Camera passthrough needs the server to run on Linux (v4l2loopback).';
      return;
    }
    const dev = this.cfg.device;
    const ffmpegOk = await run('ffmpeg', ['-hide_banner', '-version'], { timeout: 10000 }).then((r) => r.code === 0).catch(() => false);
    if (!ffmpegOk) {
      this.reason = 'ffmpeg is not installed on the server (sudo apt install ffmpeg).';
      log.warn(`Camera: ${this.reason}`);
      return;
    }
    if (!fs.existsSync(dev)) {
      const nr = (/(\d+)$/.exec(dev) || [, '42'])[1];
      if (process.getuid && process.getuid() === 0) {
        await run('modprobe', ['v4l2loopback', `video_nr=${nr}`, 'card_label=SandroidCam', 'exclusive_caps=1'], { timeout: 20000 }).catch(() => {});
      }
      if (!fs.existsSync(dev)) {
        this.reason =
          `No virtual camera at ${dev}. Run: sudo apt install v4l2loopback-dkms && ` +
          `sudo modprobe v4l2loopback video_nr=${nr} card_label=SandroidCam exclusive_caps=1`;
        log.warn(`Camera: ${this.reason}`);
        return;
      }
    }
    this.placeholder = await this.makePlaceholder();
    if (!this.placeholder) {
      this.reason = 'Could not create the camera placeholder image with ffmpeg.';
      return;
    }
    this.startFfmpeg();
    // Feed the placeholder so the device exists as a webcam before the emulator starts.
    this.timer = setInterval(() => {
      if (Date.now() - this.lastPhoneFrame > 1000) this.write(this.placeholder);
    }, 200);
    await new Promise((r) => setTimeout(r, 1500));
    this.webcamName = await this.findWebcam(dev);
    if (!this.webcamName) {
      this.reason = `The emulator does not see ${dev} as a webcam.`;
      log.warn(`Camera: ${this.reason}`);
      this.stop();
      return;
    }
    this.available = true;
    log.info(`Camera: iPhone camera will appear in Android as the back camera (${this.webcamName} -> ${dev}).`);
  }

  async makePlaceholder() {
    const file = path.join(this.dataDir, 'camera-placeholder.jpg');
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const { width, height } = this.cfg;
    const r = await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x202020:s=${width}x${height}`, '-frames:v', '1', file],
      { timeout: 30000 },
    ).catch(() => null);
    return r && r.code === 0 && fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  startFfmpeg() {
    const { width, height, fps, device } = this.cfg;
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-vf', vf, '-r', String(fps), '-f', 'v4l2', device];
    this.ffmpeg = spawnProcess('ffmpeg', args);
    this.ffmpeg.stdin.on('error', () => {});
    this.ffmpeg.stderr.on('data', (d) => log.debug(`[camera ffmpeg] ${d.toString().trim()}`));
    this.ffmpeg.on('exit', (code) => {
      this.ffmpeg = null;
      if (this.timer) {
        log.warn(`Camera feeder stopped (exit ${code}); restarting.`);
        setTimeout(() => this.timer && this.startFfmpeg(), 1000);
      }
    });
  }

  async findWebcam(dev) {
    const r = await run(this.env.emulatorPath, ['-webcam-list'], { env: this.env.env, timeout: 60000 }).catch(() => null);
    if (!r) return null;
    const text = r.stdout + r.stderr;
    for (const m of text.matchAll(/Camera '(webcam\d+)' is connected to device '([^']+)'/g)) {
      if (m[2] === dev) return m[1];
    }
    return null;
  }

  write(jpeg) {
    const ff = this.ffmpeg;
    if (!ff || !ff.stdin.writable) return;
    if (ff.stdin.writableLength > 4 * 1024 * 1024) return; // ffmpeg is behind; drop the frame
    ff.stdin.write(jpeg);
  }

  pushFrame(jpeg) {
    if (!this.available) return;
    // Only accept real JPEG data.
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return;
    this.lastPhoneFrame = Date.now();
    this.write(jpeg);
  }

  phoneStopped() {
    this.lastPhoneFrame = 0;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ffmpeg) {
      try {
        this.ffmpeg.stdin.end();
        this.ffmpeg.kill();
      } catch {}
      this.ffmpeg = null;
    }
  }
}

module.exports = { Camera };
