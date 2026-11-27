const storage = require('./storageService');

/**
 * Safety & Load Shedding Engine (Unified with Hardware Standards & Mohamed Ayman Contract)
 * 1. Overheat Shutdown (>= 65°C -> alert: "OVERHEAT") & Hysteresis Lockout until < 60°C
 * 2. Overload Detection (> 16A -> alert: "OVERLOAD") & Priority-based Load Shedding (P4 -> P3 -> P2; P1 Critical Protected)
 * 3. 80% Continuous Safe Load Monitoring (12.8A continuous limit, 7.0A relay safety limit)
 * 4. Over/Under Voltage Monitoring (190V - 250V AC)
 * 5. Inrush current prevention (3000ms sequential staggered power restore)
 */
class SafetyService {
  constructor() {
    this.OVERHEAT_TRIP_TEMP = 65.0;      // °C
    this.OVERHEAT_RESET_TEMP = 60.0;     // °C
    this.MAX_RATED_AMPS = 16.0;          // Amperes (MCB 16A max)
    this.SAFE_CONTINUOUS_AMPS = 12.8;    // 80% continuous safe current rule
    this.PER_OUTLET_SAFE_AMPS = 7.0;     // Safe continuous rating for SRD-05VDC relays
    this.LOAD_SHED_THRESHOLD = 15.5;     // Amps threshold to initiate priority shedding
    this.MIN_SAFE_VOLTS = 190.0;         // Under-voltage threshold
    this.MAX_SAFE_VOLTS = 250.0;         // Over-voltage threshold
    this.isRestoring = false;
  }

  evaluateTelemetry(payload, mqttService) {
    const dev = storage.getDeviceState();
    const currentAlert = String(dev.safety.alert || 'OK');

    // 1. Evaluate Temperature (trip >= 65°C, hysteresis release < 60°C)
    const temp = dev.safety.temperatureC;
    if (temp >= this.OVERHEAT_TRIP_TEMP) {
      if (!dev.safety.isOverheatLocked || currentAlert === 'OK') {
        dev.safety.isOverheatLocked = true;
        dev.safety.alert = 'OVERHEAT';

        console.error(`🚨 [Safety Engine] CRITICAL: Temperature ${temp}°C >= ${this.OVERHEAT_TRIP_TEMP}°C! Triggering Emergency Shutdown!`);

        // Emergency action: Command all relays OFF using Unified Contract
        mqttService.publishCommand({ type: 'all', state: false });
        storage.updateAllOutlets(false);
        storage.logEvent({
          source: 'safety_engine',
          action: 'overheat_shutdown',
          details: { temperature: temp, threshold: this.OVERHEAT_TRIP_TEMP, alert: 'OVERHEAT' }
        });
      }
    } else if (temp < this.OVERHEAT_RESET_TEMP && dev.safety.isOverheatLocked) {
      // Hysteresis release: Cool-down threshold achieved
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
      // Preserve overheat alert inside hysteresis zone (60°C..65°C)
      dev.safety.alert = 'OVERHEAT';
    }

    // 2. Evaluate Total Current & Priority Load Shedding
    const totalAmps = dev.safety.totalAmps;
    dev.safety.isContinuousWarning = totalAmps >= this.SAFE_CONTINUOUS_AMPS;
    const latestAlert = String(dev.safety.alert || 'OK');

    if (totalAmps >= this.LOAD_SHED_THRESHOLD && !dev.safety.isOverheatLocked) {
      console.warn(`⚡ [Safety Engine] Total Current ${totalAmps}A approaching rated limit (${this.MAX_RATED_AMPS}A)! Evaluating Load Shedding...`);

      // Find lowest priority active outlet (Priority 4 first, then 3, then 2. P1 Critical is protected)
      const activeOutlets = dev.outlets
        .filter(o => o.state === true && o.priority > 1)
        .sort((a, b) => b.priority - a.priority);

      if (activeOutlets.length > 0) {
        const outletToShed = activeOutlets[0];
        console.warn(`⚡ [Safety Engine] Load Shedding: Turning OFF Outlet ${outletToShed.id} (${outletToShed.name}, Priority ${outletToShed.priority})`);

        // Unified Contract Command
        mqttService.publishCommand({ type: 'outlet', id: outletToShed.id, state: false });
        storage.updateOutletState(outletToShed.id, false);
        dev.safety.alert = 'OVERLOAD';
        dev.safety.isOverloadBlocked = true;

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
        // Even if only Priority 1 critical load remains, block further turn-ons above rated 16A
        dev.safety.alert = 'OVERLOAD';
        dev.safety.isOverloadBlocked = true;
      }
    } else if (totalAmps < this.LOAD_SHED_THRESHOLD && !dev.safety.isOverheatLocked && (latestAlert === 'OVERLOAD' || latestAlert.startsWith('LOAD_SHEDDING'))) {
      dev.safety.isOverloadBlocked = false;
      dev.safety.alert = 'OK';
    }

    // 3. Evaluate Over/Under Voltage Warning (preserve explicit 0V reading)
    const volts = typeof dev.safety.volts === 'number' && Number.isFinite(dev.safety.volts) ? dev.safety.volts : 220.0;
    dev.safety.isVoltageFault = volts < this.MIN_SAFE_VOLTS || volts > this.MAX_SAFE_VOLTS;

    storage.syncLatestHistoryAlert(dev.safety.alert);
    storage.saveData();
    return dev.safety;
  }

  /**
   * Staggered Power Restore (Prevents inrush current tripping the home breaker)
   */
  async sequentialPowerRestore(mqttService, delayMs = 3000) {
    if (this.isRestoring) {
      return false;
    }
    this.isRestoring = true;
    const dev = storage.getDeviceState();
    console.log(`🔄 [Safety Engine] Starting Sequential Staggered Power Restore (${delayMs}ms delay between outlets)...`);

    try {
      for (let i = 0; i < dev.outlets.length; i++) {
        const outlet = dev.outlets[i];
        if (!mqttService.isConnected || !dev.isOnline) {
          console.warn(`🚫 [Safety Engine] Aborting sequential restore: ESP32 went offline!`);
          break;
        }
        if (dev.safety.isOverheatLocked || dev.safety.isOverloadBlocked) {
          console.warn(`🚫 [Safety Engine] Aborting sequential restore: Safety lock active!`);
          break;
        }

        console.log(`🔌 [Safety Engine] Activating Outlet ${outlet.id} (${outlet.name})...`);
        mqttService.publishCommand({ type: 'outlet', id: outlet.id, state: true });
        storage.updateOutletState(outlet.id, true);
        mqttService.emit('telemetry', storage.getDeviceState());

        if (i < dev.outlets.length - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
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
