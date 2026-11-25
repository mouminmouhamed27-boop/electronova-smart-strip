const storage = require('../services/storageService');
const mqtt = require('../services/mqttService');

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
    const outletId = parseInt(req.params.id, 10);
    const { state } = req.body;

    if (isNaN(outletId) || outletId < 1 || outletId > 4) {
      return res.status(400).json({ success: false, message: 'Invalid outlet ID (1-4).' });
    }

    if (state === undefined) {
      return res.status(400).json({ success: false, message: 'Missing "state" (boolean).' });
    }

    mqtt.setOutletState(outletId, Boolean(state));

    res.json({
      success: true,
      message: `Outlet ${outletId} set to ${state ? 'ON' : 'OFF'}`,
      outlet: storage.getDeviceState().outlets.find(o => o.id === outletId)
    });
  } catch (err) {
    res.status(403).json({
      success: false,
      message: err.message
    });
  }
};

exports.setMasterAll = (req, res, next) => {
  try {
    const { state } = req.body;
    if (state === undefined) {
      return res.status(400).json({ success: false, message: 'Missing "state" (boolean).' });
    }

    mqtt.setAllOutlets(Boolean(state));

    res.json({
      success: true,
      message: `All outlets set to ${state ? 'ON' : 'OFF'}`,
      outlets: storage.getDeviceState().outlets
    });
  } catch (err) {
    res.status(403).json({
      success: false,
      message: err.message
    });
  }
};

exports.setTimer = (req, res, next) => {
  try {
    const outletId = parseInt(req.params.id, 10);
    const { delaySec } = req.body;

    if (isNaN(outletId) || outletId < 1 || outletId > 4) {
      return res.status(400).json({ success: false, message: 'Invalid outlet ID (1-4).' });
    }

    if (!delaySec || delaySec <= 0) {
      return res.status(400).json({ success: false, message: 'Valid "delaySec" is required.' });
    }

    mqtt.setTimer(outletId, delaySec);

    res.json({
      success: true,
      message: `Countdown timer set for Outlet ${outletId}: ${delaySec} seconds`
    });
  } catch (err) {
    res.status(403).json({ success: false, message: err.message });
  }
};
