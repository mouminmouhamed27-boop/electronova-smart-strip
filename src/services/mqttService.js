const mqtt = require('mqtt');
const EventEmitter = require('events');
const config = require('../config');
const storage = require('./storageService');
const safetyService = require('./safetyService');

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
        storage.setDeviceOffline();
        this.emit('telemetry', storage.getDeviceState());
        console.warn('⚠️ [MQTT Service] Client went offline; auto-reconnect active.');
      });

      this.client.on('reconnect', () => {
        console.log('🔄 [MQTT Service] Reconnecting to EMQX Cloud...');
      });

      this.client.on('close', () => {
        if (this.isConnected) {
          console.warn(`⚠️ [MQTT Service] Connection closed.`);
        }
        this.isConnected = false;
        storage.setDeviceOffline();
        this.emit('telemetry', storage.getDeviceState());
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
        // Request instant sync from ESP32
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
    // Keep config synced in memory
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

    this.emit('telemetry', storage.getDeviceState());
    return { deviceId: this.deviceId, topics: this.topics };
  }

  handleIncomingMessage(topic, messageStr, { retained = false } = {}) {
    try {
      if (topic === this.topics.lwt) {
        const statusText = messageStr.trim().toLowerCase();
        if (statusText === 'offline') {
          storage.setDeviceOffline();
          storage.logEvent({ source: 'esp32_lwt', action: 'offline', details: `LWT offline (${this.deviceId})` });
        } else if (statusText === 'online') {
          storage.setDeviceOnline();
          storage.logEvent({ source: 'esp32_lwt', action: 'online', details: `LWT online (${this.deviceId})` });
        }
        this.emit('telemetry', storage.getDeviceState());
        return;
      }

      if (topic === this.topics.state) {
        const payload = JSON.parse(messageStr);
        const updatedDevice = storage.recordTelemetry(payload, { retained });
        // Run hardware safety & load shedding evaluations
        safetyService.evaluateTelemetry(payload, this);
        this.emit('telemetry', updatedDevice);
      }
    } catch (err) {
      console.warn(`⚠️ [MQTT Service] Could not parse MQTT message:`, err.message);
    }
  }

  publishCommand(cmdObject) {
    if (!this.client || !this.isConnected) {
      console.warn(`⚠️ [MQTT Service] Cannot publish command (Offline/Mock):`, JSON.stringify(cmdObject));
      return false;
    }

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

  _createSafetyError(message) {
    const err = new Error(message);
    err.status = 403;
    return err;
  }

  requireDeviceConnected() {
    const dev = storage.getDeviceState();
    if (!this.isConnected) {
      const err = new Error('🚫 Action rejected: Cloud MQTT broker is not connected.');
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

  // --- Device Safety Protected Actions (Unified Mohamed Ayman Contract Format) ---
  setOutletState(outletId, state) {
    const dev = this.requireDeviceConnected();
    if (state && dev.safety.isOverheatLocked) {
      throw this._createSafetyError(`🚫 Action rejected: Overheat lock is active (>65°C)!`);
    }
    if (state && dev.safety.isOverloadBlocked) {
      throw this._createSafetyError(`⚡ Action rejected: Overload limit reached (>16A)!`);
    }

    const ok = this.publishCommand({ type: 'outlet', id: outletId, state: Boolean(state) });
    if (!ok) {
      const err = new Error('🚫 Action rejected: Failed to publish command to MQTT broker.');
      err.status = 503;
      throw err;
    }
    storage.updateOutletState(outletId, state);
    storage.logEvent({
      source: 'api_backend',
      action: `outlet_${state ? 'on' : 'off'}`,
      details: { outletId, state: Boolean(state), mqttDispatched: ok }
    });
    this.emit('telemetry', storage.getDeviceState());
    return { ok: true, mqttDispatched: ok };
  }

  setAllOutlets(state) {
    const dev = this.requireDeviceConnected();
    if (state && dev.safety.isOverheatLocked) {
      throw this._createSafetyError(`🚫 Action rejected: Overheat lock is active (>65°C)!`);
    }
    if (state && dev.safety.isOverloadBlocked) {
      throw this._createSafetyError(`⚡ Action rejected: Overload limit reached (>16A)!`);
    }

    const ok = this.publishCommand({ type: 'all', state: Boolean(state) });
    if (!ok) {
      const err = new Error('🚫 Action rejected: Failed to publish command to MQTT broker.');
      err.status = 503;
      throw err;
    }
    storage.updateAllOutlets(state);
    storage.logEvent({
      source: 'api_backend',
      action: `master_${state ? 'on' : 'off'}`,
      details: { state: Boolean(state), mqttDispatched: ok }
    });
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
      const err = new Error('🚫 Action rejected: Failed to publish schedule command to MQTT broker.');
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
    const outlet = dev.outlets.find(o => o.id === outletId);
    const targetState = outlet ? !outlet.state : false;

    if (targetState && dev.safety.isOverheatLocked) {
      throw this._createSafetyError(`🚫 Cannot schedule ON timer during Overheat safety lock!`);
    }
    if (targetState && dev.safety.isOverloadBlocked) {
      throw this._createSafetyError(`⚡ Cannot schedule ON timer during Overload limit (>16A)!`);
    }

    const parsedSec = parseInt(delaySec, 10);
    const ok = this.publishCommand({
      type: 'timer',
      id: outletId,
      state: targetState,
      delaySec: parsedSec
    });
    if (!ok) {
      const err = new Error('🚫 Action rejected: Failed to publish timer command to MQTT broker.');
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
      const err = new Error('🚫 Action rejected: Failed to publish resetEnergy command to MQTT broker.');
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
