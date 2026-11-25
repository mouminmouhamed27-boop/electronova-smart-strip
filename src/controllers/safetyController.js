const storage = require('../services/storageService');
const safetyService = require('../services/safetyService');
const mqttService = require('../services/mqttService');

exports.getSafetyStatus = (req, res) => {
  const dev = storage.getDeviceState();
  return res.json({
    success: true,
    safety: {
      ...dev.safety,
      thresholds: {
        overheatTripTempC: safetyService.OVERHEAT_TRIP_TEMP,
        overheatResetTempC: safetyService.OVERHEAT_RESET_TEMP,
        maxRatedAmps: safetyService.MAX_RATED_AMPS,
        safeContinuousAmps: safetyService.SAFE_CONTINUOUS_AMPS,
        perOutletSafeAmps: safetyService.PER_OUTLET_SAFE_AMPS,
        loadShedThresholdAmps: safetyService.LOAD_SHED_THRESHOLD,
        minSafeVolts: safetyService.MIN_SAFE_VOLTS,
        maxSafeVolts: safetyService.MAX_SAFE_VOLTS
      }
    }
  });
};

exports.unlockSafety = (req, res, next) => {
  try {
    const dev = storage.getDeviceState();
    if (dev.safety.temperatureC >= safetyService.OVERHEAT_RESET_TEMP) {
      return res.status(400).json({
        success: false,
        message: `Cannot unlock: Current temperature (${dev.safety.temperatureC}°C) is still above safe threshold (<${safetyService.OVERHEAT_RESET_TEMP}°C)!`
      });
    }

    dev.safety.isOverheatLocked = false;
    if (dev.safety.totalAmps < safetyService.LOAD_SHED_THRESHOLD) {
      dev.safety.isOverloadBlocked = false;
    }
    dev.safety.alert = 'OK';
    storage.saveData();

    storage.logEvent({
      source: 'manual_unlock',
      action: 'safety_unlocked',
      details: 'Admin manual safety lock reset'
    });

    return res.json({
      success: true,
      message: 'Safety lock manually reset.',
      safety: dev.safety
    });
  } catch (err) {
    next(err);
  }
};

exports.sequentialRestore = async (req, res, next) => {
  try {
    const delayMs = parseInt(req.body.delayMs || '3000', 10);
    // Trigger in background without blocking response
    safetyService.sequentialPowerRestore(mqttService, delayMs);

    return res.json({
      success: true,
      message: `Sequential power restore initiated (${delayMs}ms delay between outlets).`
    });
  } catch (err) {
    next(err);
  }
};
