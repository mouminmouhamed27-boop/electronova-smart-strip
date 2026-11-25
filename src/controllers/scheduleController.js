const storage = require('../services/storageService');
const mqtt = require('../services/mqttService');

exports.getSchedules = (req, res) => {
  const dev = storage.getDeviceState();
  res.json({
    success: true,
    schedules: dev.schedules
  });
};

exports.updateSchedule = (req, res, next) => {
  try {
    const outletId = parseInt(req.params.id, 10);
    const { enabled, onTime, offTime } = req.body;

    if (isNaN(outletId) || outletId < 1 || outletId > 4) {
      return res.status(400).json({ success: false, message: 'Invalid outlet ID (1-4).' });
    }

    if (!onTime || !offTime) {
      return res.status(400).json({ success: false, message: 'Both onTime and offTime (HH:MM) are required.' });
    }

    mqtt.setSchedule(outletId, enabled, onTime, offTime);

    res.json({
      success: true,
      message: `Daily schedule saved for Outlet ${outletId}`,
      schedule: { outletId, enabled, onTime, offTime }
    });
  } catch (err) {
    next(err);
  }
};
