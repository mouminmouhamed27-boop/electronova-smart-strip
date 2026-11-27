const http = require('http');
const { WebSocketServer } = require('ws');
const app = require('./app');
const config = require('./config');
const mqttService = require('./services/mqttService');
const storage = require('./services/storageService');
const cronService = require('./services/cronService');
const keepAliveService = require('./services/keepAliveService');

const server = http.createServer(app);

// WebSocket Server for zero-latency live telemetry push to Flutter/Browser
const wss = new WebSocketServer({ server, path: '/ws/telemetry' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  console.log('🔗 [WebSocket] Client connected to live telemetry stream.');

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
      data: storage.getDeviceState()
    }));
  } catch (_) {}

  ws.on('close', () => {
    console.log('🔌 [WebSocket] Client disconnected.');
  });
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

// Broadcast live telemetry updates received from MQTT to all connected WebSockets
mqttService.on('telemetry', (deviceState) => {
  const payload = JSON.stringify({
    type: 'telemetry_update',
    data: deviceState
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // 1 = OPEN
      try {
        client.send(payload);
      } catch (_) {}
    }
  });
});

mqttService.on('error', (err) => {
  console.error('⚠️ [Server] Non-fatal MQTT error (server stays online):', err.message);
});

// Start Server, MQTT Connection & Cron Automation Engine
server.listen(config.port, () => {
  console.log(`
======================================================
⚡ ElectroNova IoT Smart Power Strip Backend Server
======================================================
📡 HTTP API:        http://localhost:${config.port}/api
📖 Swagger UI Docs: http://localhost:${config.port}/api-docs
🌐 WebSocket Stream: ws://localhost:${config.port}/ws/telemetry
⚙️ Environment:     ${config.nodeEnv} (${config.timezone})
🎓 Team:            Al-Azhar University Engineering
======================================================
  `);

  // Connect to MQTT Broker
  mqttService.connect();

  // Start Cron Scheduler
  cronService.start();

  // Start HTTP Self Keep-Alive Monitor
  keepAliveService.start();
});

function gracefulShutdown(signal) {
  console.log(`🛑 [Server] Received ${signal}, shutting down cleanly...`);
  clearInterval(wsHeartbeat);
  keepAliveService.stop();
  cronService.stop();
  mqttService.disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
