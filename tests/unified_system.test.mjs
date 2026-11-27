import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';

// Prevent real external EMQX/Smartnest/KeepAlive network traffic during isolated integration test
process.env.KEEPALIVE_ENABLED = 'false';
process.env.SMARTNEST_ENABLED = 'false';
process.env.NODE_ENV = 'test';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const STORE_PATH = path.resolve(process.cwd(), 'data/store.json');
const initialStoreExists = fs.existsSync(STORE_PATH);
const initialStoreContent = initialStoreExists ? fs.readFileSync(STORE_PATH, 'utf8') : null;

const config = require('../src/config');
const app = require('../src/app');
const mqttService = require('../src/services/mqttService');
const deviceGateway = require('../src/services/deviceGateway');
const smartnestBridge = require('../src/services/smartnestBridgeService');
const storage = require('../src/services/storageService');

function jsonReq(baseUrl, path, method = 'GET', body = null, token = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

function waitForMsg(ws, predicate, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    function onMsg(raw) {
      try {
        const msg = JSON.parse(raw.toString());
        if (predicate(msg)) {
          clearTimeout(t);
          ws.off('message', onMsg);
          resolve(msg);
        }
      } catch (_) {}
    }
    ws.on('message', onMsg);
  });
}

test('Unified System E2E: /ws/device (Port 443 gateway) + 4x ACS712 + Safety + Smartnest Bridge', async (t) => {
  // Isolate auth token requirement for test
  config.deviceGateway.authToken = 'test_secret_dev_tok';
  config.smartnest.deviceIds = ['sn_out_1', 'sn_out_2', 'sn_out_3', 'sn_out_4'];

  const adminToken = jwt.sign({ id: 'admin_1', email: 'admin@electronova.local', role: 'owner' }, config.jwtSecret);

  const server = http.createServer(app);
  const telemetryWss = new WebSocketServer({ noServer: true });

  telemetryWss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', data: storage.getDeviceState() }));
  });

  const broadcastTelemetry = (devState) => {
    const payload = JSON.stringify({
      type: 'telemetry_update',
      data: { ...devState, connectionMode: mqttService.getConnectionMode() }
    });
    for (const c of telemetryWss.clients) {
      if (c.readyState === 1) c.send(payload);
    }
  };
  mqttService.on('telemetry', broadcastTelemetry);

  deviceGateway.init({
    onConnectDevice: (deviceId, ws) => {
      storage.setDeviceOnline('ws');
      ws.send(JSON.stringify({ type: 'config', tariffEgp: 1.25, schedules: storage.getDeviceState().schedules }));
      ws.send(JSON.stringify({ type: 'sync' }));
    },
    onDisconnectDevice: () => {
      storage.setDeviceOffline();
      mqttService.emit('telemetry', storage.getDeviceState());
    },
    onTelemetry: (_deviceId, payload, mode) => {
      mqttService.handleDeviceTelemetry(payload, { retained: false, connectionMode: mode || 'ws' });
    },
    onDeviceEvent: () => {}
  });

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/ws/device') return deviceGateway.handleUpgrade(req, socket, head);
    if (path === '/ws/telemetry') {
      return telemetryWss.handleUpgrade(req, socket, head, (ws) => telemetryWss.emit('connection', ws, req));
    }
    socket.destroy();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  t.after(async () => {
    mqttService.off('telemetry', broadcastTelemetry);
    deviceGateway.stop();
    telemetryWss.close();
    storage.setDeviceOffline();
    if (initialStoreExists && initialStoreContent !== null) {
      fs.writeFileSync(STORE_PATH, initialStoreContent, 'utf8');
    } else if (!initialStoreExists && fs.existsSync(STORE_PATH)) {
      fs.unlinkSync(STORE_PATH);
    }
    await new Promise((resolve) => server.close(resolve));
  });

  // 1. Strict offline block (HTTP 503 when no ESP32 connected)
  storage.setDeviceOffline();
  const offlineRes = await jsonReq(baseUrl, '/api/outlets/1', 'POST', { state: true }, adminToken);
  assert.equal(offlineRes.status, 503);

  // 2. Reject wrong device token on /ws/device
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const badWs = new WebSocket(`${wsBase}/ws/device?deviceId=EN_SIM1&token=wrong`);
      badWs.on('error', reject);
      badWs.on('open', () => resolve('opened'));
    })
  );

  // 3. Connect App/Web telemetry stream + Authorized ESP32 on /ws/device
  const appWs = new WebSocket(`${wsBase}/ws/telemetry`);
  await waitForMsg(appWs, (m) => m.type === 'init');

  const espWs = new WebSocket(`${wsBase}/ws/device?deviceId=EN_SIM1&token=test_secret_dev_tok`);
  const initCfgPromise = waitForMsg(espWs, (m) => m.type === 'config');
  const initSyncPromise = waitForMsg(espWs, (m) => m.type === 'sync');
  await new Promise((resolve) => espWs.on('open', resolve));
  const initCfg = await initCfgPromise;
  await initSyncPromise;
  assert.equal(initCfg.type, 'config');

  // 4. Send 4-channel ACS712 telemetry + diagnostics from ESP32 -> verify Backend & App WS receive it
  const livePushPromise = waitForMsg(appWs, (m) => m.type === 'telemetry_update' && m.data?.isOnline === true && m.data?.diagnostics?.ip === '192.168.1.77');
  espWs.send(JSON.stringify({
    type: 'telemetry',
    src: 'hb',
    temp: 33.2,
    volts: 221,
    amps: 4.8,
    watts: 1061,
    outlets: [true, false, true, false],
    outletAmps: [1.8, 0.0, 3.0, 0.0],
    ip: '192.168.1.77',
    rssi: -52,
    firmwareVersion: '3.0.0-unified',
    bootSelfTest: true,
    alert: 'OK'
  }));
  const livePush = await livePushPromise;
  assert.equal(livePush.data.connectionMode, 'ws');
  assert.equal(livePush.data.outlets[0].currentAmps, 1.8);
  assert.equal(livePush.data.outlets[2].currentAmps, 3.0);

  // 5. Control command from Website API -> Delivered straight to ESP32 /ws/device
  const espCmdPromise = waitForMsg(espWs, (m) => m.type === 'outlet' && m.id === 2 && m.state === true);
  const ctrlRes = await jsonReq(baseUrl, '/api/outlets/2', 'POST', { state: true }, adminToken);
  assert.equal(ctrlRes.status, 200);
  await espCmdPromise;

  // 6. Smart Voice Command API (Egyptian Arabic) -> Dispatched to ESP32 WS
  const voiceCmdPromise = waitForMsg(espWs, (m) => m.type === 'outlet' && m.id === 3 && m.state === false);
  const voiceRes = await jsonReq(baseUrl, '/api/voice/command', 'POST', { transcript: 'اقفل 3', language: 'ar' }, adminToken);
  assert.equal(voiceRes.status, 200);
  await voiceCmdPromise;

  // 7. Outlet metadata sync (App + Website share custom names & protected flag)
  const metaRes = await jsonReq(baseUrl, '/api/outlets/2', 'PATCH', { name: 'شاشة المكتب', isProtected: true }, adminToken);
  assert.equal(metaRes.status, 200);
  assert.equal(metaRes.body.outlet.name, 'شاشة المكتب');
  assert.equal(metaRes.body.outlet.isProtected, true);

  // 8. Per-outlet > 10A relay safety cutoff on single ACS712 sensor
  const relayCutPromise = waitForMsg(espWs, (m) => m.type === 'outlet' && m.id === 2 && m.state === false);
  espWs.send(JSON.stringify({
    type: 'telemetry',
    temp: 35.0,
    amps: 11.4,
    outlets: [true, true, false, false],
    outletAmps: [0.4, 11.0, 0.0, 0.0],
    alert: 'OK'
  }));
  await relayCutPromise;

  // 9. Sensor fault cutoff -> blocks API turn ON & blocks Smartnest Bridge directive!
  espWs.send(JSON.stringify({
    type: 'telemetry',
    temp: 35.0,
    amps: 0,
    outlets: [false, false, false, false],
    sensorFault: true,
    tempSensorFault: true,
    alert: 'SENSOR_FAULT'
  }));
  await waitForMsg(appWs, (m) => m.type === 'telemetry_update' && m.data?.safety?.isSensorFault === true);

  const blockedOn = await jsonReq(baseUrl, '/api/outlets/1', 'POST', { state: true }, adminToken);
  assert.equal(blockedOn.status, 403);

  // Simulate Smartnest (Alexa / Google) directive while Sensor Fault is active -> must reject & log!
  smartnestBridge.deviceRouter = mqttService;
  smartnestBridge.storage = storage;
  smartnestBridge._handleDirective('sn_out_1/directive/powerState', 'ON');
  assert.equal(storage.getDeviceState().outlets[0].state, false);

  // Clear fault and verify unlock dispatches to ESP32
  espWs.send(JSON.stringify({
    type: 'telemetry',
    temp: 31.0,
    amps: 0,
    outlets: [false, false, false, false],
    sensorFault: false,
    tempSensorFault: false,
    currentSensorFault: false,
    overcurrentLatched: true,
    alert: 'OVERCURRENT_LATCHED'
  }));
  await waitForMsg(appWs, (m) => m.type === 'telemetry_update' && m.data?.safety?.isOvercurrentLatched === true);

  const unlockEspPromise = waitForMsg(espWs, (m) => m.type === 'unlock');
  const unlockRes = await jsonReq(baseUrl, '/api/safety/unlock', 'POST', {}, adminToken);
  assert.equal(unlockRes.status, 200);
  await unlockEspPromise;

  // 10. ESP32 disconnect immediately returns backend to offline (503 blocking)
  espWs.close();
  await waitForMsg(appWs, (m) => m.type === 'telemetry_update' && m.data?.isOnline === false);
  const afterCloseRes = await jsonReq(baseUrl, '/api/outlets/1', 'POST', { state: true }, adminToken);
  assert.equal(afterCloseRes.status, 503);

  appWs.close();
});
