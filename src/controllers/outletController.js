const storage = require('../services/storageService');
const mqtt = require('../services/mqttService');
const { parseBooleanStrict, parseOutletId } = require('../utils/validators');

exports.getOutlets = (req, res) => {
  const dev = storage.getDeviceState();
  res.json({
    success: true,
    isOnline: dev.isOnline,
    connectionMode: dev.connectionMode || 'offline',
    outlets: dev.outlets,
    safety: dev.safety
  });
};

exports.updateOutletMeta = (req, res) => {
  const outletId = parseOutletId(req.params.id);
  if (!outletId) {
    return res.status(400).json({ success: false, message: 'Invalid outlet ID (1-4).' });
  }

  const { name, priority, isProtected } = req.body || {};
  const updated = storage.updateOutletMeta(outletId, { name, priority, isProtected });
  if (!updated) {
    return res.status(404).json({ success: false, message: 'Outlet not found.' });
  }

  storage.logEvent({
    source: 'api_backend',
    action: 'outlet_meta_updated',
    details: { outletId, name: updated.name, priority: updated.priority, isProtected: updated.isProtected }
  });
  mqtt.emit('telemetry', storage.getDeviceState());

  return res.json({
    success: true,
    message: `Outlet ${outletId} metadata updated & synced.`,
    outlet: updated
  });
};

exports.setOutlet = (req, res) => {
  try {
    const outletId = parseOutletId(req.params.id);
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'Invalid outlet ID (1-4).' });
    }

    const parsedState = parseBooleanStrict(req.body?.state);
    if (parsedState === null) {
      return res.status(400).json({ success: false, message: 'Valid boolean "state" (true/false) is required.' });
    }

    const result = mqtt.setOutletState(outletId, parsedState);

    res.json({
      success: true,
      mqttDispatched: result.mqttDispatched,
      message: `Outlet ${outletId} set to ${parsedState ? 'ON' : 'OFF'}`,
      outlet: storage.getDeviceState().outlets.find((o) => o.id === outletId)
    });
  } catch (err) {
    res.status(err.status || 403).json({
      success: false,
      message: err.message
    });
  }
};

exports.setMasterAll = (req, res) => {
  try {
    const parsedState = parseBooleanStrict(req.body?.state);
    if (parsedState === null) {
      return res.status(400).json({ success: false, message: 'Valid boolean "state" (true/false) is required.' });
    }

    const result = mqtt.setAllOutlets(parsedState);

    res.json({
      success: true,
      mqttDispatched: result.mqttDispatched,
      message: `All outlets set to ${parsedState ? 'ON' : 'OFF'}`,
      outlets: storage.getDeviceState().outlets
    });
  } catch (err) {
    res.status(err.status || 403).json({
      success: false,
      message: err.message
    });
  }
};

exports.setTimer = (req, res) => {
  try {
    const outletId = parseOutletId(req.params.id);
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'Invalid outlet ID (1-4).' });
    }

    const rawDelay = Number(req.body?.delaySec);
    if (!Number.isInteger(rawDelay) || rawDelay <= 0 || rawDelay > 86400) {
      return res.status(400).json({ success: false, message: 'Valid integer "delaySec" (1-86400) is required.' });
    }

    const result = mqtt.setTimer(outletId, rawDelay);

    res.json({
      success: true,
      mqttDispatched: result.mqttDispatched,
      message: `Countdown timer set for Outlet ${outletId}: ${rawDelay} seconds`
    });
  } catch (err) {
    res.status(err.status || 403).json({ success: false, message: err.message });
  }
};
