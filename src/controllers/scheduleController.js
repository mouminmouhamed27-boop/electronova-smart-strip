const storage = require('../services/storageService');
const mqtt = require('../services/mqttService');
const { parseBooleanStrict, parseOutletId, isValidTimeHHMM } = require('../utils/validators');

exports.getSchedules = (req, res) => {
  const dev = storage.getDeviceState();
  res.json({
    success: true,
    schedules: dev.schedules
  });
};

exports.updateSchedule = (req, res, next) => {
  try {
    const outletId = parseOutletId(req.params.id);
    if (!outletId) {
      return res.status(400).json({ success: false, message: 'Invalid outlet ID (1-4).' });
    }

    const { enabled, onTime, offTime } = req.body || {};
    const parsedEnabled = enabled === undefined ? true : parseBooleanStrict(enabled);
    if (parsedEnabled === null) {
      return res.status(400).json({ success: false, message: 'Valid boolean "enabled" is required.' });
    }

    if (!isValidTimeHHMM(onTime) || !isValidTimeHHMM(offTime)) {
      return res.status(400).json({ success: false, message: 'Both onTime and offTime must be in valid 24-hour HH:MM format.' });
    }

    const cleanOn = onTime.trim();
    const cleanOff = offTime.trim();
    const result = mqtt.setSchedule(outletId, parsedEnabled, cleanOn, cleanOff);

    res.json({
      success: true,
      mqttDispatched: result.mqttDispatched,
      message: `Daily schedule saved for Outlet ${outletId}`,
      schedule: { outletId, enabled: parsedEnabled, onTime: cleanOn, offTime: cleanOff }
    });
  } catch (err) {
    next(err);
  }
};
