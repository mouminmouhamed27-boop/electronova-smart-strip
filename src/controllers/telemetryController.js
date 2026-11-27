const storage = require('../services/storageService');
const mqtt = require('../services/mqttService');
const smartnestBridge = require('../services/smartnestBridgeService');
const config = require('../config');

exports.getLive = (req, res) => {
  const dev = storage.getDeviceState();
  res.json({
    success: true,
    device: {
      id: dev.id,
      name: dev.name,
      isOnline: dev.isOnline,
      connectionMode: mqtt.getConnectionMode(),
      lastHeartbeat: dev.lastHeartbeat,
      tariffEgp: dev.tariffEgp,
      mqttConnected: mqtt.isConnected,
      wsConnected: mqtt.getConnectionMode() === 'ws',
      assistants: smartnestBridge.getStatus(),
      diagnostics: dev.diagnostics,
      topics: mqtt.topics,
      safety: dev.safety,
      outlets: dev.outlets,
      schedules: dev.schedules
    }
  });
};

exports.getHistory = (req, res) => {
  res.json({
    success: true,
    history: storage.data.telemetryHistory
  });
};

exports.getLogs = (req, res) => {
  res.json({
    success: true,
    logs: storage.data.eventLogs
  });
};

exports.resetEnergy = (req, res, next) => {
  try {
    const result = mqtt.resetEnergy();
    res.json({
      success: true,
      mqttDispatched: result.mqttDispatched,
      message: 'Cumulative energy (kWh) counter reset command dispatched.'
    });
  } catch (err) {
    next(err);
  }
};

exports.requestSync = (req, res, next) => {
  try {
    const ok = mqtt.publishCommand({ type: 'sync' });
    res.json({
      success: true,
      mqttDispatched: ok,
      deviceId: mqtt.deviceId,
      connectionMode: mqtt.getConnectionMode(),
      message: ok ? 'Sync request dispatched to ESP32.' : 'ESP32 offline; returned cached state.'
    });
  } catch (err) {
    next(err);
  }
};

exports.switchDevice = (req, res, next) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId || typeof deviceId !== 'string' || !deviceId.trim()) {
      return res.status(400).json({ success: false, message: 'Valid "deviceId" (e.g., EN_SIM1 or EN_XXXX) is required.' });
    }
    const result = mqtt.switchDeviceId(deviceId);
    res.json({
      success: true,
      message: `Switched active device to ${result.deviceId}`,
      ...result
    });
  } catch (err) {
    next(err);
  }
};

exports.getAssistantsStatus = (req, res) => {
  res.json({
    success: true,
    assistants: smartnestBridge.getStatus()
  });
};

exports.getFirmwareInfo = (req, res) => {
  res.json({
    success: true,
    latestVersion: config.deviceGateway.firmwareVersion,
    firmwareUrl: config.deviceGateway.firmwareUrl || null,
    currentDeviceVersion: storage.getDeviceState().diagnostics?.firmwareVersion || null
  });
};

exports.triggerOtaUpdate = (req, res, next) => {
  try {
    mqtt.requireDeviceConnected();
    const url = (req.body?.url || config.deviceGateway.firmwareUrl || '').trim();
    const version = (req.body?.version || config.deviceGateway.firmwareVersion || '3.0.0').trim();
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({
        success: false,
        message: 'Valid HTTPS firmware .bin URL is required (or set OTA_FIRMWARE_URL).'
      });
    }

    const ok = mqtt.publishCommand({ type: 'ota', url, version });
    if (!ok) {
      return res.status(503).json({ success: false, message: 'Failed to dispatch OTA command to ESP32.' });
    }

    storage.logEvent({
      source: 'api_backend',
      action: 'ota_triggered',
      details: { version, url }
    });

    return res.json({
      success: true,
      message: `OTA firmware update command (${version}) dispatched to ESP32.`
    });
  } catch (err) {
    next(err);
  }
};
