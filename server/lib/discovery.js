'use strict';

// Lets the iPhone find the server by itself: it broadcasts "SANDROID?" on UDP port 8080
// and the server answers "SANDROID!" + JSON with its name and TCP port.

const dgram = require('dgram');
const os = require('os');
const log = require('./log');
const { PROTOCOL_VERSION } = require('./protocol');

const ASK = 'SANDROID?';
const ANSWER = 'SANDROID!';

function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function startDiscovery(config, getStatus) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => {
    log.warn(`Auto-discovery is off (UDP ${config.port}: ${e.message}). Type the address in the app instead.`);
    try {
      sock.close();
    } catch {}
  });
  sock.on('message', (msg, rinfo) => {
    if (!msg.toString('utf8', 0, ASK.length).startsWith(ASK)) return;
    const status = getStatus ? getStatus() : {};
    const reply = Buffer.from(
      ANSWER +
        JSON.stringify({ name: config.name, port: config.port, version: PROTOCOL_VERSION, phase: status.phase || 'starting' }),
      'utf8',
    );
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.bind(config.port, () => {
    try {
      sock.setBroadcast(true);
    } catch {}
    log.debug(`Discovery listening on UDP ${config.port}`);
  });
  return sock;
}

module.exports = { startDiscovery, localAddresses, ASK, ANSWER };
