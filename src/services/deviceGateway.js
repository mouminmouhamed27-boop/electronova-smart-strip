const { WebSocketServer } = require('ws');
const config = require('../config');

/**
 * ESP32 WebSocket Device Gateway (/ws/device on HTTPS/WSS Port 443)
 * Eliminates Wi-Fi router / ISP port blocks on 1883 / 8883 / 8084.
 */
class DeviceGateway {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.sockets = new Map(); // deviceId -> ws
    this.heartbeatTimer = null;
    this.onTelemetry = null;
    this.onConnectDevice = null;
    this.onDisconnectDevice = null;
    this.onDeviceEvent = null;
  }

  init({ onTelemetry, onConnectDevice, onDisconnectDevice, onDeviceEvent }) {
    this.onTelemetry = onTelemetry;
    this.onConnectDevice = onConnectDevice;
    this.onDisconnectDevice = onDisconnectDevice;
    this.onDeviceEvent = onDeviceEvent;

    this.wss.on('connection', (ws, req) => this._handleConnection(ws, req));

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      for (const [devId, client] of this.sockets.entries()) {
        if (client.isAlive === false) {
          console.warn(`⏱️ [DeviceGW] Heartbeat timeout for ESP32 (${devId}); terminating socket.`);
          client.terminate();
          this.sockets.delete(devId);
          continue;
        }
        client.isAlive = false;
        try {
          client.ping();
        } catch (_) {}
      }
    }, 20000);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  handleUpgrade(req, socket, head) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const deviceId = (url.searchParams.get('deviceId') || req.headers['x-device-id'] || config.mqtt.deviceId || 'EN_SIM1').trim();
      const token = (url.searchParams.get('token') || req.headers['x-device-token'] || '').trim();

      if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      if (config.deviceGateway.authToken && token !== config.deviceGateway.authToken) {
        console.warn(`🔒 [DeviceGW] Rejected unauthorized ESP32 connection for ${deviceId}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      req.deviceId = deviceId;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    } catch (_) {
      socket.destroy();
    }
  }

  _handleConnection(ws, req) {
    const deviceId = req.deviceId || config.mqtt.deviceId || 'EN_SIM1';
    ws.deviceId = deviceId;
    ws.isAlive = true;

    const existing = this.sockets.get(deviceId);
    if (existing && existing !== ws) {
      try {
        existing.close(1000, 'Superseded by new ESP32 session');
      } catch (_) {}
    }

    this.sockets.set(deviceId, ws);
    console.log(`🔌 [DeviceGW] ESP32 (${deviceId}) connected via /ws/device (Port 443 ready).`);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      ws.isAlive = true;
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          return;
        }

        if (msg.type === 'event') {
          this.onDeviceEvent?.(deviceId, msg);
          if (msg.telemetry && typeof msg.telemetry === 'object') {
            this.onTelemetry?.(deviceId, msg.telemetry, 'ws');
          }
          return;
        }

        const payload = msg.type === 'telemetry' && msg.data ? msg.data : msg;
        this.onTelemetry?.(deviceId, payload, 'ws');
      } catch (err) {
        console.warn(`⚠️ [DeviceGW] Invalid JSON from ESP32 (${deviceId}):`, err.message);
      }
    });

    ws.on('close', () => {
      if (this.sockets.get(deviceId) === ws) {
        this.sockets.delete(deviceId);
        console.warn(`🔴 [DeviceGW] ESP32 (${deviceId}) disconnected.`);
        this.onDisconnectDevice?.(deviceId);
      }
    });

    ws.on('error', (err) => {
      console.warn(`⚠️ [DeviceGW] Socket error for ${deviceId}:`, err.message);
    });

    this.onConnectDevice?.(deviceId, ws);
  }

  isConnected(deviceId) {
    const ws = this.sockets.get(deviceId);
    return Boolean(ws && ws.readyState === 1);
  }

  sendCommand(deviceId, cmdObj) {
    const ws = this.sockets.get(deviceId);
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(cmdObj));
      console.log(`📤 [DeviceGW -> ${deviceId}]`, JSON.stringify(cmdObj));
      return true;
    } catch (err) {
      console.error(`❌ [DeviceGW] Failed sending command to ${deviceId}:`, err.message);
      return false;
    }
  }

  stop() {
    clearInterval(this.heartbeatTimer);
    for (const ws of this.sockets.values()) {
      try { ws.close(); } catch (_) {}
    }
    this.sockets.clear();
  }
}

module.exports = new DeviceGateway();
