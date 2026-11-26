const storage = require('../services/storageService');
const mqtt = require('../services/mqttService');
const { parseBooleanStrict, parseOutletId } = require('../utils/validators');

exports.getOutlets = (req, res) => {
  const dev = storage.getDeviceState();
  res.json({
    success: true,
    outlets: dev.outlets,
    safety: dev.safety
  });
};

exports.setOutlet = (req, res, next) => {
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
      outlet: storage.getDeviceState().outlets.find(o => o.id === outletId)
    });
  } catch (err) {
    res.status(err.status || 403).json({
      success: false,
      message: err.message
    });
  }
};

exports.setMasterAll = (req, res, next) => {
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

exports.setTimer = (req, res, next) => {
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
