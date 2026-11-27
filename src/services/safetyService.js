const storage = require('./storageService');

/**
 * Safety & Load Shedding Engine (Unified with 4x ACS712 + DS18B20 Hardware Standards)
 * 1. Sensor Fault Shutdown (disconnected DS18B20 or ACS712 -> cut all relays & lock ON)
 * 2. Overheat Shutdown (>= 65°C -> OVERHEAT) & Hysteresis Lockout until < 60°C
 * 3. Per-Outlet Relay Safety Limit (> 10.0A per SRD-05VDC relay -> cut offending outlet)
 * 4. Total Current Overload Detection (> 16A -> OVERLOAD) & Priority Load Shedding (P4 -> P3 -> P2; P1 Protected)
 * 5. 3-Trip Overcurrent Latch Lockout (OVERCURRENT_LATCHED) until explicit admin/power reset
 * 6. Inrush current prevention (3000ms sequential staggered power restore)
 */
class SafetyService {
  constructor() {
    this.OVERHEAT_TRIP_TEMP = 65.0;      // °C
    this.OVERHEAT_RESET_TEMP = 60.0;     // °C
    this.MAX_RATED_AMPS = 16.0;          // Amperes (Total Strip Limit)
    this.PER_OUTLET_MAX_AMPS = 10.0;     // Amperes (SRD-05VDC-SL-C 10A max per outlet)
    this.SAFE_CONTINUOUS_AMPS = 12.8;    // 80% continuous safe current rule
    this.PER_OUTLET_SAFE_AMPS = 7.0;     // Safe continuous rating per relay
    this.LOAD_SHED_THRESHOLD = 15.5;     // Amps threshold to initiate priority shedding
    this.MIN_SAFE_VOLTS = 190.0;         // Under-voltage threshold
    this.MAX_SAFE_VOLTS = 250.0;         // Over-voltage threshold
    this.isRestoring = false;
  }

  evaluateTelemetry(payload, deviceRouter) {
    const dev = storage.getDeviceState();
    const currentAlert = String(dev.safety.alert || 'OK');

    // 0. Sensor Fault Lockout (critical fail-safe if DS18B20 or ACS712 disconnected)
    if (dev.safety.isSensorFault) {
      const anyActive = dev.outlets.some((o) => o.state);
      dev.safety.alert = 'SENSOR_FAULT';
      dev.safety.lastTripReason = 'SENSOR_FAULT';
      dev.diagnostics.lastTripReason = 'SENSOR_FAULT';
      if (anyActive) {
        console.error('🚨 [Safety Engine] CRITICAL: Sensor Fault detected! Cutting all outlets.');
        deviceRouter.publishCommand({ type: 'all', state: false });
        storage.updateAllOutlets(false);
        storage.logEvent({
          source: 'safety_engine',
          action: 'sensor_fault_shutdown',
          details: {
            tempSensorFault: dev.safety.isTempSensorFault,
            currentSensorFault: dev.safety.isCurrentSensorFault
          }
        });
      }
      storage.syncLatestHistoryAlert(dev.safety.alert);
      storage.saveData();
      return dev.safety;
    }

    // 1. Evaluate Temperature (trip >= 65°C, hysteresis release < 60°C)
    const temp = dev.safety.temperatureC;
    if (temp >= this.OVERHEAT_TRIP_TEMP) {
      if (!dev.safety.isOverheatLocked || currentAlert === 'OK') {
        dev.safety.isOverheatLocked = true;
        dev.safety.alert = 'OVERHEAT';
        dev.safety.lastTripReason = 'OVERHEAT';
        dev.diagnostics.lastTripReason = 'OVERHEAT';

        console.error(`🚨 [Safety Engine] CRITICAL: Temperature ${temp}°C >= ${this.OVERHEAT_TRIP_TEMP}°C! Emergency Shutdown!`);
        deviceRouter.publishCommand({ type: 'all', state: false });
        storage.updateAllOutlets(false);
        storage.logEvent({
          source: 'safety_engine',
          action: 'overheat_shutdown',
          details: { temperature: temp, threshold: this.OVERHEAT_TRIP_TEMP, alert: 'OVERHEAT' }
        });
      }
    } else if (temp < this.OVERHEAT_RESET_TEMP && dev.safety.isOverheatLocked) {
      dev.safety.isOverheatLocked = false;
      if (currentAlert === 'OVERHEAT' || currentAlert === 'OVERHEAT_SHUTDOWN') {
        dev.safety.alert = 'OK';
      }
      console.log(`✅ [Safety Engine] Temperature cooled to ${temp}°C (< ${this.OVERHEAT_RESET_TEMP}°C). Safety lock released.`);
      storage.logEvent({
        source: 'safety_engine',
        action: 'overheat_lock_released',
        details: { temperature: temp }
      });
    } else if (dev.safety.isOverheatLocked) {
      dev.safety.alert = 'OVERHEAT';
    }

    // 2. Per-Outlet Relay Current Protection (> 10A on a single outlet with 4x ACS712)
    if (!dev.safety.isOverheatLocked && !dev.safety.isOvercurrentLatched) {
      dev.outlets.forEach((outlet) => {
        if (outlet.state && outlet.currentAmps > this.PER_OUTLET_MAX_AMPS) {
          console.warn(`⚡ [Safety Engine] Outlet ${outlet.id} exceeded 10A relay limit (${outlet.currentAmps}A)! Cutting Outlet ${outlet.id}.`);
          deviceRouter.publishCommand({ type: 'outlet', id: outlet.id, state: false });
          storage.updateOutletState(outlet.id, false);
          dev.safety.alert = 'OUTLET_OVERCURRENT';
          dev.safety.lastTripReason = `OUTLET_${outlet.id}_OVERCURRENT`;
          dev.diagnostics.lastTripReason = dev.safety.lastTripReason;
          storage.logEvent({
            source: 'safety_engine',
            action: 'outlet_overcurrent_trip',
            details: { outletId: outlet.id, amps: outlet.currentAmps, limit: this.PER_OUTLET_MAX_AMPS }
          });
        }
      });
    }

    // 3. Evaluate Total Current & Priority Load Shedding (16A total limit)
    const totalAmps = dev.safety.totalAmps;
    dev.safety.isContinuousWarning = totalAmps >= this.SAFE_CONTINUOUS_AMPS;
    const latestAlert = String(dev.safety.alert || 'OK');

    if (dev.safety.isOvercurrentLatched) {
      dev.safety.alert = 'OVERCURRENT_LATCHED';
      dev.safety.isOverloadBlocked = true;
      if (dev.outlets.some((o) => o.state)) {
        deviceRouter.publishCommand({ type: 'all', state: false });
        storage.updateAllOutlets(false);
      }
    } else if (totalAmps >= this.LOAD_SHED_THRESHOLD && !dev.safety.isOverheatLocked) {
      console.warn(`⚡ [Safety Engine] Total Current ${totalAmps}A approaching rated limit (${this.MAX_RATED_AMPS}A)! Evaluating Load Shedding...`);

      // Prefer shedding unprotected non-P1 outlets from lowest priority (4 -> 3 -> 2)
      const activeOutlets = dev.outlets
        .filter((o) => o.state === true && (o.priority > 1 && !o.isProtected))
        .sort((a, b) => b.priority - a.priority || b.currentAmps - a.currentAmps);

      const fallbackOutlets = activeOutlets.length > 0
        ? activeOutlets
        : dev.outlets.filter((o) => o.state === true && o.priority > 1).sort((a, b) => b.priority - a.priority);

      if (fallbackOutlets.length > 0) {
        const outletToShed = fallbackOutlets[0];
        console.warn(`⚡ [Safety Engine] Load Shedding: Turning OFF Outlet ${outletToShed.id} (${outletToShed.name}, Priority ${outletToShed.priority})`);

        deviceRouter.publishCommand({ type: 'outlet', id: outletToShed.id, state: false });
        storage.updateOutletState(outletToShed.id, false);
        dev.safety.alert = 'OVERLOAD';
        dev.safety.isOverloadBlocked = true;
        dev.safety.lastTripReason = 'OVERLOAD_SHED';
        dev.diagnostics.lastTripReason = 'OVERLOAD_SHED';

        storage.logEvent({
          source: 'safety_engine',
          action: 'load_shedding',
          details: {
            outletId: outletToShed.id,
            outletName: outletToShed.name,
            totalAmps,
            priority: outletToShed.priority,
            alert: 'OVERLOAD'
          }
        });
      } else if (totalAmps > this.MAX_RATED_AMPS) {
        deviceRouter.publishCommand({ type: 'all', state: false });
        storage.updateAllOutlets(false);
        dev.safety.alert = 'OVERLOAD';
        dev.safety.isOverloadBlocked = true;
        dev.safety.lastTripReason = 'OVERLOAD';
        dev.diagnostics.lastTripReason = 'OVERLOAD';
      }
    } else if (
      totalAmps < this.LOAD_SHED_THRESHOLD &&
      !dev.safety.isOverheatLocked &&
      !dev.safety.isOvercurrentLatched &&
      (latestAlert === 'OVERLOAD' || latestAlert.startsWith('LOAD_SHEDDING'))
    ) {
      dev.safety.isOverloadBlocked = false;
      dev.safety.alert = 'OK';
    }

    // 4. Evaluate Over/Under Voltage Warning
    const volts = typeof dev.safety.volts === 'number' && Number.isFinite(dev.safety.volts) ? dev.safety.volts : 220.0;
    dev.safety.isVoltageFault = volts < this.MIN_SAFE_VOLTS || volts > this.MAX_SAFE_VOLTS;

    storage.syncLatestHistoryAlert(dev.safety.alert);
    storage.saveData();
    return dev.safety;
  }

  /**
   * Staggered Power Restore (Prevents inrush current tripping the home breaker)
   */
  async sequentialPowerRestore(deviceRouter, delayMs = 3000) {
    if (this.isRestoring) {
      return false;
    }
    this.isRestoring = true;
    const dev = storage.getDeviceState();
    console.log(`🔄 [Safety Engine] Starting Sequential Staggered Power Restore (${delayMs}ms delay between outlets)...`);

    try {
      for (let i = 0; i < dev.outlets.length; i++) {
        const outlet = dev.outlets[i];
        if (!deviceRouter.isDeviceTransportConnected() || !dev.isOnline) {
          console.warn(`🚫 [Safety Engine] Aborting sequential restore: ESP32 went offline!`);
          break;
        }
        if (dev.safety.isOverheatLocked || dev.safety.isOverloadBlocked || dev.safety.isOvercurrentLatched || dev.safety.isSensorFault) {
          console.warn(`🚫 [Safety Engine] Aborting sequential restore: Safety lock active!`);
          break;
        }

        console.log(`🔌 [Safety Engine] Activating Outlet ${outlet.id} (${outlet.name})...`);
        deviceRouter.publishCommand({ type: 'outlet', id: outlet.id, state: true });
        storage.updateOutletState(outlet.id, true);
        deviceRouter.emit('telemetry', storage.getDeviceState());

        if (i < dev.outlets.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      storage.logEvent({
        source: 'safety_engine',
        action: 'sequential_restore_complete',
        details: 'All outlets restored sequentially'
      });
    } finally {
      this.isRestoring = false;
    }
    return true;
  }
}

module.exports = new SafetyService();
