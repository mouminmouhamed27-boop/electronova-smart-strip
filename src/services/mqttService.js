const mqtt = require('mqtt');
const EventEmitter = require('events');
const config = require('../config');
const storage = require('./storageService');
const safetyService = require('./safetyService');
const deviceGateway = require('./deviceGateway');
const smartnestBridge = require('./smartnestBridgeService');

class MqttService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.isConnected = false;
    this.deviceId = config.mqtt.deviceId;
    this.topics = {
      cmd: config.mqtt.topicCmd,
      state: config.mqtt.topicState,
      lwt: config.mqtt.topicLwt,
    };
  }

  isDeviceTransportConnected() {
    return Boolean(deviceGateway.isConnected(this.deviceId) || this.isConnected);
  }

  getConnectionMode() {
    if (deviceGateway.isConnected(this.deviceId)) return 'ws';
    if (this.isConnected && storage.getDeviceState().isOnline) return 'mqtt';
    return 'offline';
  }

  connect() {
    console.log(`🔌 [MQTT Service] Connecting to broker: ${config.mqtt.brokerUrl} (Device: ${this.deviceId})`);

    const options = {
      clientId: config.mqtt.clientId,
      clean: true,
      keepalive: 30,
      resubscribe: true,
      connectTimeout: 8000,
      reconnectPeriod: 3000,
      rejectUnauthorized: config.mqtt.rejectUnauthorized
    };

    if (config.mqtt.username) options.username = config.mqtt.username;
    if (config.mqtt.password) options.password = config.mqtt.password;

    try {
      this.client = mqtt.connect(config.mqtt.brokerUrl, options);

      this.client.on('connect', () => {
        this.isConnected = true;
        console.log(`✅ [MQTT Service] Connected to EMQX Cloud successfully.`);
        this.subscribeToActiveTopics();
        this.emit('connected');
      });

      this.client.on('message', (topic, messageBuffer, packet) => {
        const messageStr = messageBuffer.toString();
        const retained = Boolean(packet && packet.retain);
        this.handleIncomingMessage(topic, messageStr, { retained });
      });

      this.client.on('error', (err) => {
        console.error(`⚠️ [MQTT Service] Error:`, err.message);
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        this.emit('mqtt_error', err);
      });

      this.client.on('offline', () => {
        this.isConnected = false;
        if (!deviceGateway.isConnected(this.deviceId)) {
          storage.setDeviceOffline();
          smartnestBridge.syncFullState();
          this.emit('telemetry', storage.getDeviceState());
        }
        console.warn('⚠️ [MQTT Service] EMQX client went offline; auto-reconnect active.');
      });

      this.client.on('reconnect', () => {
        console.log('🔄 [MQTT Service] Reconnecting to EMQX Cloud...');
      });

      this.client.on('close', () => {
        if (this.isConnected) {
          console.warn(`⚠️ [MQTT Service] EMQX connection closed.`);
        }
        this.isConnected = false;
        if (!deviceGateway.isConnected(this.deviceId)) {
          storage.setDeviceOffline();
          smartnestBridge.syncFullState();
          this.emit('telemetry', storage.getDeviceState());
        }
        this.emit('disconnected');
      });

    } catch (err) {
      console.error(`❌ [MQTT Service] Initialization error:`, err.message);
    }
  }

  subscribeToActiveTopics() {
    if (!this.client || !this.isConnected) return;
    const topics = [this.topics.state, this.topics.lwt];
    this.client.subscribe(topics, (err) => {
      if (err) {
        console.error(`❌ [MQTT Service] Failed to subscribe to topics:`, err);
      } else {
        console.log(`📡 [MQTT Service] Subscribed to:`, topics);
        this.publishCommand({ type: 'sync' });
      }
    });
  }

  switchDeviceId(newDeviceId) {
    const cleanId = String(newDeviceId || '').trim();
    if (!cleanId || !/^[A-Za-z0-9_-]{1,64}$/.test(cleanId)) {
      const err = new Error('Invalid Device ID. Use 1-64 alphanumeric characters, "_" or "-".');
      err.status = 400;
      throw err;
    }

    const oldTopics = [this.topics.state, this.topics.lwt];
    this.deviceId = cleanId;
    this.topics = config.mqtt.buildTopics(cleanId, false);
    config.mqtt.deviceId = cleanId;
    config.mqtt.topicCmd = this.topics.cmd;
    config.mqtt.topicState = this.topics.state;
    config.mqtt.topicLwt = this.topics.lwt;

    storage.setDeviceId(cleanId);
    storage.logEvent({
      source: 'api_backend',
      action: 'device_switched',
      details: { deviceId: cleanId, topics: this.topics }
    });

    if (this.client && this.isConnected) {
      this.client.unsubscribe(oldTopics, () => {
        this.subscribeToActiveTopics();
      });
    }
    if (deviceGateway.isConnected(cleanId)) {
      storage.setDeviceOnline('ws');
      deviceGateway.sendCommand(cleanId, { type: 'sync' });
    }

    smartnestBridge.syncFullState({ force: true });
    this.emit('telemetry', storage.getDeviceState());
    return { deviceId: this.deviceId, topics: this.topics };
  }

  handleDeviceTelemetry(payload, { retained = false, connectionMode = 'mqtt' } = {}) {
    const updatedDevice = storage.recordTelemetry(payload, { retained, connectionMode });
    safetyService.evaluateTelemetry(payload, this);
    smartnestBridge.syncFullState();
    this.emit('telemetry', updatedDevice);
    return updatedDevice;
  }

  handleIncomingMessage(topic, messageStr, { retained = false } = {}) {
    try {
      if (topic === this.topics.lwt) {
        const statusText = messageStr.trim().toLowerCase();
        if (statusText === 'offline') {
          if (!deviceGateway.isConnected(this.deviceId)) {
            storage.setDeviceOffline();
            storage.logEvent({ source: 'esp32_lwt', action: 'offline', details: `LWT offline (${this.deviceId})` });
            smartnestBridge.syncFullState({ force: true });
          }
        } else if (statusText === 'online') {
          storage.setDeviceOnline(deviceGateway.isConnected(this.deviceId) ? 'ws' : 'mqtt');
          storage.logEvent({ source: 'esp32_lwt', action: 'online', details: `LWT online (${this.deviceId})` });
          smartnestBridge.syncFullState({ force: true });
        }
        this.emit('telemetry', storage.getDeviceState());
        return;
      }

      if (topic === this.topics.state) {
        const payload = JSON.parse(messageStr);
        this.handleDeviceTelemetry(payload, { retained, connectionMode: 'mqtt' });
      }
    } catch (err) {
      console.warn(`⚠️ [MQTT Service] Could not parse MQTT message:`, err.message);
    }
  }

  publishCommand(cmdObject) {
    // 1. Prefer direct ESP32 WebSocket (/ws/device over port 443) when connected
    if (deviceGateway.sendCommand(this.deviceId, cmdObject)) {
      return true;
    }

    // 2. Fallback to EMQX MQTT broker when connected
    if (this.client && this.isConnected) {
      try {
        const payload = JSON.stringify(cmdObject);
        this.client.publish(this.topics.cmd, payload, { qos: 1 }, (err) => {
          if (err) {
            console.error(`❌ [MQTT Service] Publish command failed:`, err.message);
          } else {
            console.log(`📤 [MQTT Service] Published to ${this.topics.cmd}:`, payload);
          }
        });
        return true;
      } catch (err) {
        console.error(`❌ [MQTT Service] Error serializing command:`, err.message);
        return false;
      }
    }

    console.warn(`⚠️ [Device Router] Cannot dispatch command (ESP32 WS & MQTT offline):`, JSON.stringify(cmdObject));
    return false;
  }

  _createSafetyError(message) {
    const err = new Error(message);
    err.status = 403;
    return err;
  }

  requireDeviceConnected() {
    const dev = storage.getDeviceState();
    if (!this.isDeviceTransportConnected()) {
      const err = new Error('🚫 Action rejected: Neither ESP32 WebSocket (/ws/device) nor EMQX broker is connected.');
      err.status = 503;
      throw err;
    }
    if (!dev.isOnline) {
      const err = new Error(`🚫 Action rejected: ESP32 device (${this.deviceId}) is offline! Connect a real ESP32 power strip first.`);
      err.status = 503;
      throw err;
    }
    return dev;
  }

  _assertSafeToTurnOn(dev) {
    if (dev.safety.isSensorFault) {
      throw this._createSafetyError('🚨 Action rejected: Hardware sensor fault (DS18B20 or ACS712 disconnected)!');
    }
    if (dev.safety.isOverheatLocked) {
      throw this._createSafetyError('🚫 Action rejected: Overheat lock is active (>=65°C)!');
    }
    if (dev.safety.isOvercurrentLatched) {
      throw this._createSafetyError('🔒 Action rejected: 3-Trip Overcurrent Latch active! Inspect loads & unlock manually.');
    }
    if (dev.safety.isOverloadBlocked) {
      throw this._createSafetyError('⚡ Action rejected: Overload limit reached (>16A)!');
    }
  }

  // --- Device Safety Protected Actions (Single Source of Truth) ---
  setOutletState(outletId, state, source = 'api_backend') {
    const dev = this.requireDeviceConnected();
    if (state) this._assertSafeToTurnOn(dev);

    const ok = this.publishCommand({ type: 'outlet', id: outletId, state: Boolean(state) });
    if (!ok) {
      const err = new Error('🚫 Action rejected: Failed to dispatch command to ESP32.');
      err.status = 503;
      throw err;
    }
    storage.updateOutletState(outletId, state);
    storage.logEvent({
      source,
      action: `outlet_${state ? 'on' : 'off'}`,
      details: { outletId, state: Boolean(state), mqttDispatched: ok }
    });
    smartnestBridge.syncFullState();
    this.emit('telemetry', storage.getDeviceState());
    return { ok: true, mqttDispatched: ok };
  }

  setAllOutlets(state, source = 'api_backend') {
    const dev = this.requireDeviceConnected();
    if (state) this._assertSafeToTurnOn(dev);

    const ok = this.publishCommand({ type: 'all', state: Boolean(state) });
    if (!ok) {
      const err = new Error('🚫 Action rejected: Failed to dispatch command to ESP32.');
      err.status = 503;
      throw err;
    }
    storage.updateAllOutlets(state);
    storage.logEvent({
      source,
      action: `master_${state ? 'on' : 'off'}`,
      details: { state: Boolean(state), mqttDispatched: ok }
    });
    smartnestBridge.syncFullState();
    this.emit('telemetry', storage.getDeviceState());
    return { ok: true, mqttDispatched: ok };
  }

  setSchedule(outletId, enabled, onTime, offTime) {
    this.requireDeviceConnected();
    const ok = this.publishCommand({
      type: 'schedule',
      id: outletId,
      enabled: Boolean(enabled),
      on: onTime,
      off: offTime
    });
    if (!ok) {
      const err = new Error('🚫 Action rejected: Failed to dispatch schedule command to ESP32.');
      err.status = 503;
      throw err;
    }
    storage.updateSchedule(outletId, { enabled: Boolean(enabled), onTime, offTime });
    storage.logEvent({
      source: 'api_backend',
      action: 'schedule_update',
      details: { outletId, enabled: Boolean(enabled), onTime, offTime, mqttDispatched: ok }
    });
    this.emit('telemetry', storage.getDeviceState());
    return { ok: true, mqttDispatched: ok };
  }

  setTimer(outletId, delaySec) {
    const dev = this.requireDeviceConnected();
    const outlet = dev.outlets.find((o) => o.id === outletId);
    const targetState = outlet ? !outlet.state : false;

    if (targetState) this._assertSafeToTurnOn(dev);

    const parsedSec = parseInt(delaySec, 10);
    const ok = this.publishCommand({
      type: 'timer',
      id: outletId,
      state: targetState,
      delaySec: parsedSec
    });
    if (!ok) {
      const err = new Error('🚫 Action rejected: Failed to dispatch timer command to ESP32.');
      err.status = 503;
      throw err;
    }

    storage.logEvent({
      source: 'api_backend',
      action: 'timer_set',
      details: { outletId, delaySec: parsedSec, targetState, mqttDispatched: ok }
    });
    return { ok: true, mqttDispatched: ok };
  }

  resetEnergy() {
    this.requireDeviceConnected();
    const ok = this.publishCommand({ type: 'resetEnergy' });
    if (!ok) {
      const err = new Error('🚫 Action rejected: Failed to dispatch resetEnergy command to ESP32.');
      err.status = 503;
      throw err;
    }
    storage.resetCumulativeEnergy();
    storage.logEvent({
      source: 'api_backend',
      action: 'reset_energy',
      details: { message: 'Energy kWh counter reset', mqttDispatched: ok }
    });
    this.emit('telemetry', storage.getDeviceState());
    return { ok: true, mqttDispatched: ok };
  }

  disconnect() {
    if (this.client) {
      try {
        this.client.end(true);
      } catch (_) {}
    }
  }
}

module.exports = new MqttService();
