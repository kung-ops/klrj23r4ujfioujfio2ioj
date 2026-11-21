'use strict';

// Connects the one active iPhone to the Android screen stream.

const { EventEmitter } = require('events');
const { ScrcpySession } = require('./scrcpy');
const log = require('./log');

class Hub extends EventEmitter {
  constructor({ config, sessionFactory }) {
    super();
    this.config = config;
    this.sessionFactory =
      sessionFactory ||
      ((device) => new ScrcpySession({ adb: device.adb, serial: device.serial, serverJar: device.serverJar, stream: config.stream }));
    this.state = { phase: 'starting', message: 'Starting…', progress: null };
    this.client = null;
    this.device = null;
    this.session = null;
    this.retries = 0;
    this.retryTimer = null;
    this.camera = null;
    this.controller = null; // { restartAndroid() }
  }

  setStatus(phase, message, progress = null) {
    this.state = { phase, message, progress };
    if (this.client) this.client.sendStatus(this.state);
    this.emit('status', this.state);
  }

  setDevice(device) {
    this.device = device;
    this.retries = 0;
    if (this.client) this.startStream();
  }

  clearDevice() {
    this.device = null;
    this.stopStream();
  }

  attachClient(client) {
    if (this.client && this.client !== client) {
      log.info(`${this.client.label} replaced by ${client.label}`);
      this.client.kick('Another device connected to this server.');
    }
    this.client = client;
    this.retries = 0;
    client.sendStatus(this.state);
    if (this.device) this.startStream();
  }

  detachClient(client) {
    if (this.client !== client) return;
    this.client = null;
    this.stopStream();
    if (this.camera) this.camera.phoneStopped();
  }

  startStream() {
    this.stopStream();
    const client = this.client;
    if (!this.device || !client) return;
    const s = this.sessionFactory(this.device);
    this.session = s;
    let gotVideo = false;
    s.on('size', (w, h) => client.sendVideoSize(w, h));
    s.on('video', (data, config, key) => {
      if (!gotVideo) {
        gotVideo = true;
        this.retries = 0;
      }
      client.sendVideo(data, config, key);
    });
    s.on('audioFormat', (f) => client.sendAudioFormat(f));
    s.on('audio', (d) => client.sendAudio(d));
    s.on('clipboard', (t) => client.sendClipboard(t));
    s.on('closed', (err) => {
      if (this.session !== s) return;
      this.session = null;
      log.warn(`Screen stream stopped: ${err.message}`);
      this.scheduleRetry();
    });
    s.start()
      .then(() => {
        if (this.session === s) log.info(`Streaming Android to ${client.label}`);
      })
      .catch((err) => {
        if (this.session !== s) return;
        this.session = null;
        log.warn(`Could not start the screen stream: ${err.message}`);
        this.scheduleRetry();
      });
  }

  scheduleRetry() {
    if (!this.client || !this.device) return;
    this.retries++;
    if (this.retries > 6) {
      this.client.sendNotice('The Android screen keeps stopping. Try "Restart Android" in the menu.');
      return;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.startStream(), Math.min(1000 * this.retries, 5000));
  }

  stopStream() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.session) {
      const s = this.session;
      this.session = null;
      s.stop();
    }
  }

  async restartAndroid() {
    if (!this.controller) return;
    this.clearDevice();
    await this.controller.restartAndroid();
  }
}

module.exports = { Hub };
