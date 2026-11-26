const cron = require('node-cron');
const config = require('../config');
const storage = require('./storageService');
const mqtt = require('./mqttService');

/**
 * Backend Automation & Schedule Engine
 * Runs continuous checks every minute in the configured timezone (default: Africa/Cairo)
 * to ensure schedule triggers execute even if ESP32 loses its local time synchronization.
 */
class CronService {
  constructor() {
    this.task = null;
    this.lastTriggered = new Map();
  }

  getCurrentHHMM(now = new Date()) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: config.timezone || 'Africa/Cairo',
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit'
      }).format(now);
    } catch (_) {
      return now.toTimeString().slice(0, 5);
    }
  }

  start() {
    if (this.task) return;
    const tz = config.timezone || 'Africa/Cairo';
    console.log(`⏰ [Cron Engine] Initializing automation & schedule watcher (TZ: ${tz})...`);

    // Runs every minute at second 0 in target timezone
    this.task = cron.schedule('* * * * *', () => {
      this.checkSchedules();
    }, { timezone: tz });

    console.log('✅ [Cron Engine] Active and scheduled (checks every minute).');
  }

  checkSchedules(now = new Date()) {
    const dev = storage.getDeviceState();
    const currentHHMM = this.getCurrentHHMM(now);
    const minuteBucket = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${currentHHMM}`;

    dev.schedules.forEach((sch) => {
      if (!sch.enabled) return;

      const outlet = dev.outlets.find(o => o.id === sch.outletId);
      if (!outlet) return;

      // Check ON schedule (blocked safely during safety locks without aborting OFF schedules)
      if (sch.onTime === currentHHMM && !outlet.state) {
        const key = `${sch.outletId}:on`;
        if (this.lastTriggered.get(key) === minuteBucket) return;
        if (dev.safety.isOverheatLocked || dev.safety.isOverloadBlocked) {
          console.warn(`🚫 [Cron Engine] Skipped ON schedule for Outlet ${sch.outletId} at ${currentHHMM}: safety lock active.`);
          return;
        }
        try {
          console.log(`📅 [Cron Engine] Triggering ON schedule for Outlet ${sch.outletId} at ${currentHHMM}`);
          mqtt.setOutletState(sch.outletId, true);
          this.lastTriggered.set(key, minuteBucket);
          storage.logEvent({
            source: 'cron_scheduler',
            action: 'schedule_on',
            details: { outletId: sch.outletId, time: currentHHMM, timezone: config.timezone }
          });
        } catch (err) {
          console.warn(`⚠️ [Cron Engine] Failed ON schedule for Outlet ${sch.outletId}:`, err.message);
        }
      }

      // Check OFF schedule (always allowed even during overload/overheat)
      if (sch.offTime === currentHHMM && outlet.state) {
        const key = `${sch.outletId}:off`;
        if (this.lastTriggered.get(key) === minuteBucket) return;
        try {
          console.log(`📅 [Cron Engine] Triggering OFF schedule for Outlet ${sch.outletId} at ${currentHHMM}`);
          mqtt.setOutletState(sch.outletId, false);
          this.lastTriggered.set(key, minuteBucket);
          storage.logEvent({
            source: 'cron_scheduler',
            action: 'schedule_off',
            details: { outletId: sch.outletId, time: currentHHMM, timezone: config.timezone }
          });
        } catch (err) {
          console.warn(`⚠️ [Cron Engine] Failed OFF schedule for Outlet ${sch.outletId}:`, err.message);
        }
      }
    });
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log('⏹️ [Cron Engine] Stopped.');
    }
  }
}

module.exports = new CronService();
