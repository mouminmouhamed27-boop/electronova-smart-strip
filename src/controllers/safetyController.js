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
        perOutletMaxAmps: safetyService.PER_OUTLET_MAX_AMPS,
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
    const dev = mqttService.requireDeviceConnected();
    if (dev.safety.isSensorFault) {
      return res.status(400).json({
        success: false,
        message: 'Cannot unlock: Hardware sensor fault (DS18B20 or ACS712 disconnected)! Check sensor wiring first.'
      });
    }
    if (dev.safety.temperatureC >= safetyService.OVERHEAT_RESET_TEMP) {
      return res.status(400).json({
        success: false,
        message: `Cannot unlock: Current temperature (${dev.safety.temperatureC}°C) is still above safe threshold (<${safetyService.OVERHEAT_RESET_TEMP}°C)!`
      });
    }

    dev.safety.isOverheatLocked = false;
    dev.safety.isOvercurrentLatched = false;
    dev.safety.overcurrentTrips = 0;
    dev.diagnostics.overcurrentTrips = 0;
    if (dev.safety.totalAmps < safetyService.LOAD_SHED_THRESHOLD) {
      dev.safety.isOverloadBlocked = false;
    }
    dev.safety.alert = 'OK';
    storage.saveData();

    mqttService.publishCommand({ type: 'unlock' });

    storage.logEvent({
      source: 'manual_unlock',
      action: 'safety_unlocked',
      details: 'Admin manual safety & overcurrent latch reset dispatched'
    });
    mqttService.emit('telemetry', dev);

    return res.json({
      success: true,
      message: 'Safety & latch locks reset successfully.',
      safety: dev.safety
    });
  } catch (err) {
    next(err);
  }
};

exports.sequentialRestore = async (req, res, next) => {
  try {
    const dev = mqttService.requireDeviceConnected();
    if (dev.safety.isOverheatLocked || dev.safety.isOverloadBlocked || dev.safety.isOvercurrentLatched || dev.safety.isSensorFault) {
      return res.status(403).json({
        success: false,
        message: 'Cannot initiate sequential restore while a safety, latch, or sensor fault lock is active.'
      });
    }
    if (safetyService.isRestoring) {
      return res.status(409).json({
        success: false,
        message: 'Sequential power restore is already in progress.'
      });
    }

    const parsedDelay = parseInt(req.body?.delayMs, 10);
    const delayMs = Number.isFinite(parsedDelay) ? Math.min(15000, Math.max(500, parsedDelay)) : 3000;
    safetyService.sequentialPowerRestore(mqttService, delayMs);

    return res.json({
      success: true,
      message: `Sequential power restore initiated (${delayMs}ms delay between outlets).`
    });
  } catch (err) {
    next(err);
  }
};
