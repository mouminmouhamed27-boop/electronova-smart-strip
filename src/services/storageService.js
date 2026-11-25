const fs = require('fs');
const path = require('path');
const config = require('../config');

const DATA_FILE = path.join(__dirname, '../../data/store.json');

// Ensure data folder exists
const dataDir = path.dirname(DATA_FILE);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const defaultData = {
  users: [
    {
      id: 'admin_1',
      name: 'مهندس المشروع',
      email: 'admin@electronova.local',
      // hashed '123456'
      passwordHash: '$2a$10$kmPmay90Zr7CC2vxBlMGL.bqriw3X1Zm0XFUiqsZFBwJe9kWgzmwu',
      role: 'owner',
      createdAt: new Date().toISOString()
    }
  ],
  device: {
    id: config.mqtt.deviceId || 'EN_SIM1',
    name: 'المشترك الذكي - هندسة الأزهر',
    isOnline: false,
    lastHeartbeat: null,
    tariffEgp: config.defaultTariffEgp || 1.25,
    outlets: [
      { id: 1, name: 'راوتر / جهاز أساسي', priority: 1, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.000 },
      { id: 2, name: 'كمبيوتر / محطة عمل', priority: 2, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.000 },
      { id: 3, name: 'إضاءة المعمل / طرفيات', priority: 3, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.000 },
      { id: 4, name: 'أحمال غير حرجة / شواحن', priority: 4, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.000 }
    ],
    safety: {
      temperatureC: 25.0,
      volts: 220.0,
      totalAmps: 0.0,
      totalWatts: 0,
      totalKwh: 0.000,
      costEgp: 0.00,
      isOverheatLocked: false,
      isOverloadBlocked: false,
      isContinuousWarning: false,
      isVoltageFault: false,
      alert: 'OK'
    },
    schedules: [
      { outletId: 1, enabled: false, onTime: '08:00', offTime: '23:00' },
      { outletId: 2, enabled: false, onTime: '08:00', offTime: '23:00' },
      { outletId: 3, enabled: false, onTime: '08:00', offTime: '23:00' },
      { outletId: 4, enabled: false, onTime: '08:00', offTime: '23:00' }
    ]
  },
  telemetryHistory: [],
  eventLogs: []
};

class StorageService {
  constructor() {
    this.lastEnergyTickMs = null;
    this.data = this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Ensure newer schema fields exist when upgrading from older store.json
        if (parsed.device) {
          parsed.device.id = parsed.device.id || config.mqtt.deviceId || 'EN_SIM1';
          if (parsed.device.safety) {
            if (parsed.device.safety.volts === undefined) parsed.device.safety.volts = 220.0;
            if (parsed.device.safety.isContinuousWarning === undefined) parsed.device.safety.isContinuousWarning = false;
            if (parsed.device.safety.isVoltageFault === undefined) parsed.device.safety.isVoltageFault = false;
          }
        }
        return parsed;
      }
    } catch (e) {
      console.warn('⚠️ Could not read store.json, initializing fresh store:', e.message);
    }
    this.saveData(defaultData);
    return JSON.parse(JSON.stringify(defaultData));
  }

  saveData(dataToSave = this.data) {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
    } catch (e) {
      console.error('❌ Failed to save store.json:', e.message);
    }
  }

  // --- Users ---
  findUserByEmail(email) {
    return this.data.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  }

  findUserById(id) {
    return this.data.users.find(u => u.id === id);
  }

  createUser(user) {
    this.data.users.push(user);
    this.saveData();
    return user;
  }

  // --- Device & Outlets ---
  getDeviceState() {
    return this.data.device;
  }

  setDeviceId(newId) {
    if (!newId) return this.data.device;
    this.data.device.id = String(newId).trim();
    this.data.device.isOnline = false;
    this.saveData();
    return this.data.device;
  }

  updateOutletState(outletId, state) {
    const outlet = this.data.device.outlets.find(o => o.id === outletId);
    if (outlet) {
      outlet.state = Boolean(state);
      this.saveData();
    }
    return outlet;
  }

  updateAllOutlets(state) {
    this.data.device.outlets.forEach(o => {
      o.state = Boolean(state);
    });
    this.saveData();
    return this.data.device.outlets;
  }

  updateSchedule(outletId, scheduleData) {
    let sch = this.data.device.schedules.find(s => s.outletId === outletId);
    if (!sch) {
      sch = { outletId, ...scheduleData };
      this.data.device.schedules.push(sch);
    } else {
      Object.assign(sch, scheduleData);
    }
    this.saveData();
    return sch;
  }

  resetCumulativeEnergy() {
    this.data.device.safety.totalKwh = 0.000;
    this.data.device.safety.costEgp = 0.00;
    this.data.device.outlets.forEach(o => {
      o.totalKwh = 0.000;
    });
    this.saveData();
  }

  // --- Telemetry Processing (Supports Unified Contract + Legacy v4.0/v4.1 Payloads) ---
  recordTelemetry(payload) {
    const dev = this.data.device;
    const nowMs = Date.now();
    dev.isOnline = true;
    dev.lastHeartbeat = new Date(nowMs).toISOString();

    // 1. Temperature (Unified: temp | Legacy: t, temp_c)
    const tempRaw = payload.temp !== undefined ? payload.temp : (payload.t !== undefined ? payload.t : payload.temp_c);
    if (tempRaw !== undefined) {
      dev.safety.temperatureC = parseFloat(tempRaw);
    }

    // 2. Voltage (Optional: volts, v)
    const voltsRaw = payload.volts !== undefined ? payload.volts : payload.v;
    if (voltsRaw !== undefined) {
      dev.safety.volts = parseFloat(voltsRaw);
    }
    const lineVolts = dev.safety.volts || 220.0;

    // 3. Total Amps & Watts (Unified: amps, watts | Legacy: ta, total_amps, w, total_w)
    const ampsRaw = payload.amps !== undefined ? payload.amps : (payload.ta !== undefined ? payload.ta : payload.total_amps);
    if (ampsRaw !== undefined) {
      dev.safety.totalAmps = parseFloat(ampsRaw);
    }

    const wattsRaw = payload.watts !== undefined ? payload.watts : (payload.w !== undefined ? payload.w : payload.total_w);
    if (wattsRaw !== undefined) {
      dev.safety.totalWatts = Math.round(parseFloat(wattsRaw));
    } else if (ampsRaw !== undefined) {
      dev.safety.totalWatts = Math.round(dev.safety.totalAmps * lineVolts);
    }

    // 4. Outlets (Unified: outlets[] | Legacy: s[], a[], k[])
    const outletStatesArr = Array.isArray(payload.outlets) ? payload.outlets : (Array.isArray(payload.s) ? payload.s : null);
    const outletAmpsArr = Array.isArray(payload.outletAmps) ? payload.outletAmps : (Array.isArray(payload.a) ? payload.a : null);
    const outletKwhArr = Array.isArray(payload.outletKwh) ? payload.outletKwh : (Array.isArray(payload.k) ? payload.k : null);

    if (outletStatesArr) {
      outletStatesArr.forEach((st, idx) => {
        if (dev.outlets[idx]) {
          dev.outlets[idx].state = Boolean(st);
          if (outletAmpsArr && outletAmpsArr[idx] !== undefined) {
            dev.outlets[idx].currentAmps = parseFloat(outletAmpsArr[idx]);
            dev.outlets[idx].currentWatts = Math.round(dev.outlets[idx].currentAmps * lineVolts);
          } else if (!dev.outlets[idx].state) {
            dev.outlets[idx].currentAmps = 0.0;
            dev.outlets[idx].currentWatts = 0;
          }
          if (outletKwhArr && outletKwhArr[idx] !== undefined) {
            dev.outlets[idx].totalKwh = parseFloat(outletKwhArr[idx]);
          }
        }
      });
    }

    // 5. Energy & Cost (Explicit from ESP32 or calculated incrementally by Backend)
    const kwhRaw = payload.kwh !== undefined ? payload.kwh : (payload.tk !== undefined ? payload.tk : payload.total_kwh);
    const costRaw = payload.cost !== undefined ? payload.cost : (payload.c !== undefined ? payload.c : payload.cost_egp);

    if (kwhRaw !== undefined) {
      dev.safety.totalKwh = parseFloat(kwhRaw);
    } else if (this.lastEnergyTickMs !== null && dev.safety.totalWatts > 0) {
      const dtHours = Math.min((nowMs - this.lastEnergyTickMs) / 3600000.0, 0.05); // cap interval to avoid jump after long offline gap
      const deltaKwh = (dev.safety.totalWatts / 1000.0) * dtHours;
      dev.safety.totalKwh = parseFloat((dev.safety.totalKwh + deltaKwh).toFixed(5));

      // Distribute delta proportionally among active outlets if per-outlet kWh isn't reported
      if (!outletKwhArr) {
        const activeOutlets = dev.outlets.filter(o => o.state);
        if (activeOutlets.length > 0) {
          const shareKwh = deltaKwh / activeOutlets.length;
          activeOutlets.forEach(o => {
            o.totalKwh = parseFloat((o.totalKwh + shareKwh).toFixed(5));
          });
        }
      }
    }
    this.lastEnergyTickMs = nowMs;

    const tariff = dev.tariffEgp || 1.25;
    if (costRaw !== undefined) {
      dev.safety.costEgp = parseFloat(costRaw);
    } else {
      dev.safety.costEgp = parseFloat((dev.safety.totalKwh * tariff).toFixed(2));
    }

    // 6. Alert Synchronization (Unified: OVERHEAT / OVERLOAD / OK + Legacy: OVERHEAT_SHUTDOWN / LOAD_SHEDDING_*)
    const alertVal = String(payload.alert || payload.al || 'OK').trim();
    const isOverheatAlert = alertVal === 'OVERHEAT' || alertVal === 'OVERHEAT_SHUTDOWN';
    const isOverloadAlert = alertVal === 'OVERLOAD' || alertVal.startsWith('LOAD_SHEDDING');

    dev.safety.alert = alertVal;
    dev.safety.isOverheatLocked = isOverheatAlert;
    dev.safety.isOverloadBlocked = isOverloadAlert || dev.safety.totalAmps > 16.0;
    dev.safety.isContinuousWarning = dev.safety.totalAmps >= 12.8;
    dev.safety.isVoltageFault = lineVolts < 190.0 || lineVolts > 250.0;

    // 7. Schedules sync if included in legacy packets
    if (Array.isArray(payload.sch)) {
      payload.sch.forEach((item, idx) => {
        if (Array.isArray(item) && dev.schedules[idx]) {
          dev.schedules[idx].enabled = Boolean(item[0]);
          if (item[1]) dev.schedules[idx].onTime = item[1];
          if (item[2]) dev.schedules[idx].offTime = item[2];
        }
      });
    }

    // Store in history (keep last 100 entries)
    const historyEntry = {
      timestamp: dev.lastHeartbeat,
      temperatureC: dev.safety.temperatureC,
      volts: dev.safety.volts,
      totalWatts: dev.safety.totalWatts,
      totalAmps: dev.safety.totalAmps,
      totalKwh: dev.safety.totalKwh,
      alert: dev.safety.alert
    };
    this.data.telemetryHistory.push(historyEntry);
    if (this.data.telemetryHistory.length > 100) {
      this.data.telemetryHistory.shift();
    }

    this.saveData();
    return dev;
  }

  setDeviceOnline() {
    this.data.device.isOnline = true;
    this.data.device.lastHeartbeat = new Date().toISOString();
    this.saveData();
  }

  setDeviceOffline() {
    this.data.device.isOnline = false;
    this.saveData();
  }

  logEvent(event) {
    const entry = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      ...event
    };
    this.data.eventLogs.unshift(entry);
    if (this.data.eventLogs.length > 80) {
      this.data.eventLogs.pop();
    }
    this.saveData();
    return entry;
  }
}

module.exports = new StorageService();
