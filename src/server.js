const http = require('http');
const { WebSocketServer } = require('ws');
const app = require('./app');
const config = require('./config');
const mqttService = require('./services/mqttService');
const storage = require('./services/storageService');
const cronService = require('./services/cronService');

const server = http.createServer(app);

// WebSocket Server for zero-latency live telemetry push to Flutter/Browser
const wss = new WebSocketServer({ server, path: '/ws/telemetry' });

wss.on('connection', (ws) => {
  console.log('🔗 [WebSocket] Client connected to live telemetry stream.');

  // Send current state immediately on connect
  ws.send(JSON.stringify({
    type: 'init',
    data: storage.getDeviceState()
  }));

  ws.on('close', () => {
    console.log('🔌 [WebSocket] Client disconnected.');
  });
});

// Broadcast live telemetry updates received from MQTT to all connected WebSockets
mqttService.on('telemetry', (deviceState) => {
  const payload = JSON.stringify({
    type: 'telemetry_update',
    data: deviceState
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // 1 = OPEN
      client.send(payload);
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
⚙️ Environment:     ${config.nodeEnv}
🎓 Team:            Al-Azhar University Engineering
======================================================
  `);

  // Connect to MQTT Broker
  mqttService.connect();

  // Start Cron Scheduler
  cronService.start();
});
