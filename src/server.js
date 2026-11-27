const http = require('http');
const { WebSocketServer } = require('ws');
const app = require('./app');
const config = require('./config');
const mqttService = require('./services/mqttService');
const deviceGateway = require('./services/deviceGateway');
const smartnestBridge = require('./services/smartnestBridgeService');
const storage = require('./services/storageService');
const cronService = require('./services/cronService');
const keepAliveService = require('./services/keepAliveService');

const server = http.createServer(app);

// WebSocket Server for zero-latency live telemetry push to Mobile App & Browser
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  console.log('🔗 [WebSocket] Client connected to /ws/telemetry stream.');

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'ping') {
        ws.isAlive = true;
        ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
    } catch (_) {}
  });

  ws.on('error', (err) => {
    console.warn('⚠️ [WebSocket] Client socket error:', err.message);
  });

  // Send current state immediately on connect
  try {
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        ...storage.getDeviceState(),
        connectionMode: mqttService.getConnectionMode(),
        assistants: smartnestBridge.getStatus()
      }
    }));
  } catch (_) {}

  ws.on('close', () => {
    console.log('🔌 [WebSocket] Telemetry client disconnected.');
  });
});

// Route WebSocket upgrades cleanly between Dashboard/App (/ws/telemetry) & ESP32 (/ws/device)
server.on('upgrade', (req, socket, head) => {
  try {
    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
    if (pathname === '/ws/telemetry') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
    if (pathname === '/ws/device') {
      deviceGateway.handleUpgrade(req, socket, head);
      return;
    }
  } catch (_) {}
  socket.destroy();
});

// Keepalive heartbeat prevents reverse-proxy (Railway) idle WebSocket drops
const wsHeartbeat = setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) {
      return client.terminate();
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch (_) {}
  });
}, 25000);

wss.on('close', () => clearInterval(wsHeartbeat));

// Broadcast live telemetry updates to all Web + Mobile WebSocket clients
mqttService.on('telemetry', (deviceState) => {
  const payload = JSON.stringify({
    type: 'telemetry_update',
    data: {
      ...deviceState,
      connectionMode: mqttService.getConnectionMode(),
      assistants: smartnestBridge.getStatus()
    }
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch (_) {}
    }
  });
});

mqttService.on('error', (err) => {
  console.error('⚠️ [Server] Non-fatal MQTT error (server stays online):', err.message);
});

// Wire ESP32 Device Gateway (/ws/device over Port 443)
deviceGateway.init({
  onConnectDevice: (deviceId, ws) => {
    if (deviceId === mqttService.deviceId) {
      storage.setDeviceOnline('ws');
      storage.logEvent({ source: 'esp32_ws', action: 'online', details: `ESP32 (${deviceId}) connected on /ws/device (Port 443)` });
      smartnestBridge.syncFullState({ force: true });
      mqttService.emit('telemetry', storage.getDeviceState());
    }
    // Push server-synced schedules & thresholds immediately on boot/reconnect
    const dev = storage.getDeviceState();
    try {
      ws.send(JSON.stringify({
        type: 'config',
        tariffEgp: dev.tariffEgp,
        schedules: dev.schedules
      }));
      ws.send(JSON.stringify({ type: 'sync' }));
    } catch (_) {}
  },
  onDisconnectDevice: (deviceId) => {
    if (deviceId === mqttService.deviceId && !mqttService.isConnected) {
      storage.setDeviceOffline();
      storage.logEvent({ source: 'esp32_ws', action: 'offline', details: `ESP32 (${deviceId}) WebSocket disconnected` });
      smartnestBridge.syncFullState({ force: true });
      mqttService.emit('telemetry', storage.getDeviceState());
    }
  },
  onTelemetry: (deviceId, payload, mode) => {
    if (deviceId !== mqttService.deviceId) return;
    mqttService.handleDeviceTelemetry(payload, { retained: false, connectionMode: mode || 'ws' });
  },
  onDeviceEvent: (deviceId, msg) => {
    storage.logEvent({
      source: 'esp32_ws',
      action: msg.action || 'device_event',
      details: msg.details || msg
    });
  }
});

// Start Server, MQTT, Smartnest Cloud Bridge, Cron Scheduler & Keep-Alive
server.listen(config.port, () => {
  console.log(`
======================================================
⚡ ElectroNova IoT Smart Power Strip Backend Server
======================================================
📡 HTTP API:        http://localhost:${config.port}/api
📖 Swagger UI Docs: http://localhost:${config.port}/api-docs
🌐 App/Web WS:      ws://localhost:${config.port}/ws/telemetry
🔌 ESP32 Device WS: ws://localhost:${config.port}/ws/device
⚙️ Environment:     ${config.nodeEnv} (${config.timezone})
🎓 Team:            Al-Azhar University Engineering
======================================================
  `);

  mqttService.connect();
  smartnestBridge.start({ deviceRouter: mqttService, storage });
  cronService.start();
  keepAliveService.start();
});

function gracefulShutdown(signal) {
  console.log(`🛑 [Server] Received ${signal}, shutting down cleanly...`);
  clearInterval(wsHeartbeat);
  keepAliveService.stop();
  cronService.stop();
  smartnestBridge.stop();
  deviceGateway.stop();
  mqttService.disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
