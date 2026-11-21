#!/usr/bin/env node
'use strict';

// Sandroid server: runs Android (with Google Play) on this computer and streams it to the
// Sandroid iPhone app over TCP port 8080. The iPhone finds it automatically on the same Wi-Fi.

const net = require('net');
const log = require('./lib/log');
const configLib = require('./lib/config');
const { Setup } = require('./lib/setup');
const { Adb } = require('./lib/adb');
const { Emulator } = require('./lib/emulator');
const { Camera } = require('./lib/camera');
const { Files } = require('./lib/files');
const { Hub } = require('./lib/hub');
const { ClientConnection } = require('./lib/client');
const { startDiscovery, localAddresses } = require('./lib/discovery');

const HELP = `
Sandroid server — Android on your computer, on your iPhone.

  node server.js [options]

Options:
  --accept-licenses   accept the Android SDK licenses without asking
  --serial=SERIAL     stream an existing Android device/emulator (from "adb devices")
  --show-window       also show the Android window on this computer
  --gpu=MODE          emulator GPU: auto, host, swiftshader_indirect
  --safe-mode         start Android with software graphics and no quick boot
  --no-camera         don't set up the iPhone camera passthrough
  --no-audio          don't stream sound
  --new-pin           make a new PIN
  --pin=123456        use this PIN
  --name=NAME         name shown in the iPhone app
  --data=DIR          where Android and settings are stored (default: ./data)
  --debug             more logging
`;

function banner(config) {
  const ips = localAddresses();
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  Sandroid server                             │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log(`  Name:  ${config.name}`);
  console.log(`  PIN:   ${config.pin}`);
  console.log(`  Port:  ${config.port} (TCP for the app, UDP for auto-discovery)`);
  if (ips.length) for (const ip of ips) console.log(`  Address: ${ip.address}:${config.port}   (${ip.name})`);
  else console.log('  Address: no network found');
  console.log('  Open Sandroid on the iPhone (same Wi-Fi) and tap this computer.');
  console.log('');
}

async function main() {
  const flags = configLib.parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(HELP);
    return;
  }
  if (flags.debug) log.setLevel('debug');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error('Sandroid needs Node.js 18 or newer (https://nodejs.org).');
    process.exit(1);
  }

  const config = configLib.load(flags);
  const files = new Files({ dataDir: config.dataDir });
  files.cleanup();
  const hub = new Hub({ config });

  const server = net.createServer((socket) => new ClientConnection(socket, { hub, config, files }));
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') log.error(`Port ${config.port} is already in use. Close the other program or use --port=.`);
    else log.error(`Server error: ${e.message}`);
    process.exit(1);
  });
  await new Promise((resolve) => server.listen(config.port, '0.0.0.0', resolve));
  const discovery = startDiscovery(config, () => hub.state);
  banner(config);

  let emulator = null;
  let camera = null;
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info('Stopping… (press Ctrl+C again to force)');
    hub.stopStream();
    server.close();
    try {
      discovery.close();
    } catch {}
    if (camera) camera.stop();
    if (emulator && config.android.stopOnExit) await emulator.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    hub.setStatus('installing', 'Checking the Android installation…');
    const setup = new Setup(config, flags);
    setup.on('status', (msg, progress) => hub.setStatus('installing', msg, progress));

    if (config.device) {
      const env = await setup.runForExistingDevice();
      const adb = new Adb(env.adbPath, env.env);
      await adb.startServer();
      hub.setStatus('booting', `Waiting for Android device ${config.device}…`);
      await adb.waitForBoot(config.device);
      hub.camera = { status: () => ({ available: false, reason: 'Camera passthrough only works with the built-in emulator.' }), pushFrame() {}, phoneStopped() {} };
      hub.setDevice({ adb, serial: config.device, serverJar: env.serverJar });
      hub.setStatus('ready', 'Android is ready');
      return;
    }

    const env = await setup.run();
    const adb = new Adb(env.adbPath, env.env);
    camera = new Camera(config, env);
    await camera.init();
    hub.camera = camera;
    emulator = new Emulator({ config, env, adb, camera });
    emulator.on('status', (msg) => hub.setStatus('booting', msg));

    const boot = async () => {
      hub.setStatus('booting', 'Starting Android…');
      const preferSafe = !!(config.android.safeMode || flags.safeMode);
      const { serial, profile } = await emulator.startWithFallback({ preferSafe });
      if (profile.safe && !config.android.safeMode) {
        config.android.safeMode = true;
        configLib.update(config, (c) => {
          c.android = { ...(c.android || {}), safeMode: true };
        });
        log.info('Android works in safe mode on this computer; it will start that way from now on.');
      }
      hub.setDevice({ adb, serial, serverJar: env.serverJar });
      hub.setStatus('ready', 'Android is ready');
    };

    let crashes = 0;
    emulator.on('exit', (info) => {
      if (shuttingDown) return;
      hub.clearDevice();
      crashes++;
      log.error(`Android stopped:\n${info}`);
      if (crashes > 3) {
        hub.setStatus('error', `Android keeps stopping. Check the server window.\n${info}`);
        return;
      }
      hub.setStatus('booting', 'Android stopped; starting it again…');
      setTimeout(() => boot().catch((e) => hub.setStatus('error', e.message)), 3000);
    });

    hub.controller = {
      async restartAndroid() {
        hub.setStatus('booting', 'Restarting Android…');
        crashes = 0;
        await emulator.stop();
        await boot();
      },
    };

    await boot();
  } catch (e) {
    log.error(e.message);
    hub.setStatus('error', e.message);
  }
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
