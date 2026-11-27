const mqtt = require('mqtt');
const config = require('../config');

/**
 * Server-Side Smartnest Cloud Bridge (Google Assistant + Amazon Alexa + Legacy App Sync)
 * Keeps ALL Smartnest secrets safely on the Backend (zero credentials inside ESP32 firmware).
 * Enforces the Backend's real-ESP32 online check & safety engine before touching any hardware.
 */
class SmartnestBridgeService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.deviceRouter = null;
    this.storage = null;
    this.publishQueue = [];
    this.flushTimer = null;
    this.lastSentAt = 0;
    this.lastReportedStates = new Map();
    this.lastOnlinePublished = null;
    this.lastTelemetrySyncAt = 0;
  }

  start({ deviceRouter, storage }) {
    this.deviceRouter = deviceRouter;
    this.storage = storage;

    if (!config.smartnest.enabled) {
      console.log('ℹ️ [Smartnest Bridge] Disabled (set SMARTNEST_USERNAME, SMARTNEST_API_KEY, SMARTNEST_DEVICE_IDS to enable Alexa & Google Home).');
      return;
    }

    const { host, port, username, apiKey, deviceIds } = config.smartnest;
    const brokerUrl = `mqtt://${host}:${port}`;
    const willTopic = `${deviceIds[0]}/report/online`;

    console.log(`🗣️ [Smartnest Bridge] Connecting to ${brokerUrl} for ${deviceIds.length} channel(s)...`);

    this.client = mqtt.connect(brokerUrl, {
      clientId: deviceIds[0], // Smartnest requires one of your registered device IDs as Client ID
      username,
      password: apiKey,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 10000,
      connectTimeout: 8000,
      will: {
        topic: willTopic,
        payload: 'false',
        qos: 0,
        retain: true
      }
    });

    this.client.on('connect', () => {
      this.isConnected = true;
      console.log('✅ [Smartnest Bridge] Connected to Smartnest Cloud (Alexa & Google Assistant ready).');

      deviceIds.forEach((id) => {
        this.client.subscribe(`${id}/directive/powerState`);
        this.client.subscribe(`${id}/directive/reportState`);
        this.client.subscribe(`${id}/directive/status`);
      });

      this.syncFullState({ force: true });
    });

    this.client.on('message', (topic, buf) => {
      this._handleDirective(topic, buf.toString());
    });

    this.client.on('offline', () => {
      this.isConnected = false;
    });

    this.client.on('close', () => {
      this.isConnected = false;
    });

    this.client.on('error', (err) => {
      console.warn('⚠️ [Smartnest Bridge] Connection warning:', err.message);
    });
  }

  _enqueue(topic, payload, retain = true) {
    if (!this.client || !this.isConnected) return;
    // Deduplicate same topic pending in queue
    this.publishQueue = this.publishQueue.filter((item) => item.topic !== topic);
    this.publishQueue.push({ topic, payload: String(payload), retain });
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this.flushTimer || this.publishQueue.length === 0) return;
    const elapsed = Date.now() - this.lastSentAt;
    const waitMs = Math.max(0, 95 - elapsed); // Smartnest throttles rapid publishes
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.client || !this.isConnected || this.publishQueue.length === 0) return;
      const item = this.publishQueue.shift();
      this.lastSentAt = Date.now();
      this.client.publish(item.topic, item.payload, { qos: 0, retain: item.retain });
      if (this.publishQueue.length > 0) this._scheduleFlush();
    }, waitMs);
  }

  _handleDirective(topic, rawMsg) {
    const deviceIds = config.smartnest.deviceIds;
    const msg = String(rawMsg || '').trim().toUpperCase();

    for (let i = 0; i < deviceIds.length; i++) {
      const snId = deviceIds[i];
      const outletId = i + 1;

      if (topic === `${snId}/directive/powerState`) {
        const wantsOn = msg === 'ON' || msg === '1' || msg === 'TRUE';
        const wantsOff = msg === 'OFF' || msg === '0' || msg === 'FALSE';
        if (!wantsOn && !wantsOff) return;

        try {
          this.deviceRouter.setOutletState(outletId, wantsOn, 'smartnest_voice');
          this.lastReportedStates.set(outletId, wantsOn);
          this._enqueue(`${snId}/report/powerState`, wantsOn ? 'ON' : 'OFF', true);
        } catch (err) {
          console.warn(`🚫 [Smartnest Bridge] Blocked voice command on Outlet ${outletId}: ${err.message}`);
          const dev = this.storage.getDeviceState();
          const actual = Boolean(dev.outlets[i]?.state);
          this._enqueue(`${snId}/report/powerState`, actual ? 'ON' : 'OFF', true);
          this.storage.logEvent({
            source: 'smartnest_voice',
            action: 'voice_command_blocked',
            details: { outletId, targetState: wantsOn, reason: err.message }
          });
        }
        return;
      }

      if (topic === `${snId}/directive/reportState` || topic === `${snId}/directive/status`) {
        const dev = this.storage.getDeviceState();
        const actual = Boolean(dev.outlets[i]?.state);
        this._enqueue(`${snId}/report/online`, dev.isOnline ? 'true' : 'false', true);
        this._enqueue(`${snId}/report/powerState`, actual ? 'ON' : 'OFF', true);
        return;
      }
    }
  }

  syncFullState({ force = false } = {}) {
    if (!config.smartnest.enabled || !this.client || !this.isConnected || !this.storage) return;

    const dev = this.storage.getDeviceState();
    const deviceIds = config.smartnest.deviceIds;
    const onlineStr = dev.isOnline ? 'true' : 'false';

    if (force || this.lastOnlinePublished !== onlineStr) {
      this.lastOnlinePublished = onlineStr;
      deviceIds.forEach((snId) => {
        this._enqueue(`${snId}/report/online`, onlineStr, true);
      });
    }

    dev.outlets.forEach((o, idx) => {
      const snId = deviceIds[idx];
      if (!snId) return;
      const stateVal = Boolean(o.state && dev.isOnline);
      if (force || this.lastReportedStates.get(o.id) !== stateVal) {
        this.lastReportedStates.set(o.id, stateVal);
        this._enqueue(`${snId}/report/powerState`, stateVal ? 'ON' : 'OFF', true);
      }
    });

    const now = Date.now();
    if (force || now - this.lastTelemetrySyncAt >= 15000) {
      this.lastTelemetrySyncAt = now;
      const rootId = deviceIds[0];
      if (rootId) {
        this._enqueue(`${rootId}/report/temperature`, Number(dev.safety.temperatureC || 25).toFixed(1), true);
        this._enqueue(`${rootId}/report/current`, Number(dev.safety.totalAmps || 0).toFixed(2), true);
        const statusJson = JSON.stringify({
          deviceId: dev.id,
          temp: Number(dev.safety.temperatureC || 25),
          current: Number(dev.safety.totalAmps || 0),
          power: Number(dev.safety.totalWatts || 0),
          voltage: Number(dev.safety.volts || 220),
          thermalCut: Boolean(dev.safety.isOverheatLocked),
          overcurrentCut: Boolean(dev.safety.isOverloadBlocked),
          overcurrentLatched: Boolean(dev.safety.isOvercurrentLatched),
          sensorFault: Boolean(dev.safety.isSensorFault),
          safetyAlert: dev.safety.alert === 'OK' ? null : dev.safety.alert,
          online: Boolean(dev.isOnline)
        });
        this._enqueue(`${rootId}/report/status`, statusJson, true);
      }
    }
  }

  getStatus() {
    return {
      enabled: Boolean(config.smartnest.enabled),
      connected: Boolean(this.isConnected),
      host: config.smartnest.enabled ? config.smartnest.host : null,
      username: config.smartnest.enabled ? config.smartnest.username : null,
      linkedChannels: config.smartnest.deviceIds.length
    };
  }

  stop() {
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.publishQueue = [];
    if (this.client) {
      try {
        this.client.end(true);
      } catch (_) {}
      this.client = null;
    }
    this.isConnected = false;
  }
}

module.exports = new SmartnestBridgeService();
