const storage = require('../services/storageService');
const mqtt = require('../services/mqttService');

exports.getLive = (req, res) => {
  const dev = storage.getDeviceState();
  res.json({
    success: true,
    device: {
      id: dev.id,
      name: dev.name,
      isOnline: dev.isOnline,
      lastHeartbeat: dev.lastHeartbeat,
      tariffEgp: dev.tariffEgp,
      mqttConnected: mqtt.isConnected,
      topics: mqtt.topics,
      safety: dev.safety,
      outlets: dev.outlets
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
      message: ok ? 'Sync request dispatched to ESP32.' : 'MQTT broker reconnecting; returned cached state.'
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
