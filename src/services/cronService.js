const cron = require('node-cron');
const storage = require('./storageService');
const mqtt = require('./mqttService');

/**
 * Backend Automation & Schedule Engine
 * Runs continuous checks every minute to ensure schedule triggers execute
 * even if ESP32 loses its local time synchronization.
 */
class CronService {
  constructor() {
    this.task = null;
    this.countdownTimers = new Map();
  }

  start() {
    console.log('⏰ [Cron Engine] Initializing automation & schedule watcher...');

    // Runs every minute at second 0
    this.task = cron.schedule('* * * * *', () => {
      this.checkSchedules();
    });

    console.log('✅ [Cron Engine] Active and scheduled (checks every minute).');
  }

  checkSchedules() {
    const dev = storage.getDeviceState();
    if (dev.safety.isOverheatLocked) return;

    const now = new Date();
    // Format current time in 24-hr format HH:MM (e.g. "08:00")
    const currentHHMM = now.toTimeString().slice(0, 5);

    dev.schedules.forEach((sch) => {
      if (!sch.enabled) return;

      const outlet = dev.outlets.find(o => o.id === sch.outletId);
      if (!outlet) return;

      // Check ON schedule
      if (sch.onTime === currentHHMM && !outlet.state) {
        console.log(`📅 [Cron Engine] Triggering ON schedule for Outlet ${sch.outletId} at ${currentHHMM}`);
        mqtt.setOutletState(sch.outletId, true);
        storage.logEvent({
          source: 'cron_scheduler',
          action: 'schedule_on',
          details: { outletId: sch.outletId, time: currentHHMM }
        });
      }

      // Check OFF schedule
      if (sch.offTime === currentHHMM && outlet.state) {
        console.log(`📅 [Cron Engine] Triggering OFF schedule for Outlet ${sch.outletId} at ${currentHHMM}`);
        mqtt.setOutletState(sch.outletId, false);
        storage.logEvent({
          source: 'cron_scheduler',
          action: 'schedule_off',
          details: { outletId: sch.outletId, time: currentHHMM }
        });
      }
    });
  }

  stop() {
    if (this.task) {
      this.task.stop();
      console.log('⏹️ [Cron Engine] Stopped.');
    }
  }
}

module.exports = new CronService();
