const fs = require('fs');
const path = require('path');
const config = require('../config');
const { toFiniteNumber, parseBooleanStrict } = require('../utils/validators');

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

function parseOutletFlag(val) {
  const parsed = parseBooleanStrict(val);
  return parsed !== null ? parsed : Boolean(val);
}

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
        // Always start offline on boot until live ESP32/LWT confirms connection
        if (parsed.device) {
          parsed.device.id = parsed.device.id || config.mqtt.deviceId || 'EN_SIM1';
          parsed.device.isOnline = false;
          parsed.device.tariffEgp = config.defaultTariffEgp || parsed.device.tariffEgp || 1.25;
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
    if (typeof email !== 'string') return undefined;
    const normalized = email.trim().toLowerCase();
    return this.data.users.find(u => u.email.toLowerCase() === normalized);
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
      if (!outlet.state) {
        outlet.currentAmps = 0.0;
        outlet.currentWatts = 0;
      }
      this.saveData();
    }
    return outlet;
  }

  updateAllOutlets(state) {
    const boolState = Boolean(state);
    this.data.device.outlets.forEach(o => {
      o.state = boolState;
      if (!boolState) {
        o.currentAmps = 0.0;
        o.currentWatts = 0;
      }
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
    this.lastEnergyTickMs = Date.now();
    this.saveData();
  }

  // --- Telemetry Processing (Supports Unified Contract + Legacy v4.0/v4.1 Payloads) ---
  recordTelemetry(payload, { retained = false } = {}) {
    const dev = this.data.device;
    const nowMs = Date.now();
    const prevOverheatLocked = Boolean(dev.safety.isOverheatLocked);
    if (!retained) {
      dev.isOnline = true;
      dev.lastHeartbeat = new Date(nowMs).toISOString();
    }

    // 1. Temperature (Unified: temp | Legacy: t, temp_c)
    const tempVal = toFiniteNumber(
      payload.temp !== undefined ? payload.temp : (payload.t !== undefined ? payload.t : payload.temp_c)
    );
    if (tempVal !== null) {
      dev.safety.temperatureC = tempVal;
    }

    // 2. Voltage (Optional: volts, v — handles 0V faults accurately)
    const voltsVal = toFiniteNumber(payload.volts !== undefined ? payload.volts : payload.v);
    if (voltsVal !== null && voltsVal >= 0) {
      dev.safety.volts = voltsVal;
    }
    const lineVolts = toFiniteNumber(dev.safety.volts) ?? 220.0;

    // 3. Total Amps & Watts (Unified: amps, watts | Legacy: ta, total_amps, w, total_w)
    const ampsVal = toFiniteNumber(
      payload.amps !== undefined ? payload.amps : (payload.ta !== undefined ? payload.ta : payload.total_amps)
    );
    if (ampsVal !== null && ampsVal >= 0) {
      dev.safety.totalAmps = ampsVal;
    }

    const wattsVal = toFiniteNumber(
      payload.watts !== undefined ? payload.watts : (payload.w !== undefined ? payload.w : payload.total_w)
    );
    if (wattsVal !== null && wattsVal >= 0) {
      dev.safety.totalWatts = Math.round(wattsVal);
    } else if (ampsVal !== null && ampsVal >= 0) {
      dev.safety.totalWatts = Math.round(dev.safety.totalAmps * lineVolts);
    }

    // 4. Outlets (Unified: outlets[] | Legacy: s[], a[], k[])
    const outletStatesArr = Array.isArray(payload.outlets) ? payload.outlets : (Array.isArray(payload.s) ? payload.s : null);
    const outletAmpsArr = Array.isArray(payload.outletAmps) ? payload.outletAmps : (Array.isArray(payload.a) ? payload.a : null);
    const outletKwhArr = Array.isArray(payload.outletKwh) ? payload.outletKwh : (Array.isArray(payload.k) ? payload.k : null);

    if (outletStatesArr) {
      outletStatesArr.forEach((st, idx) => {
        if (dev.outlets[idx]) {
          dev.outlets[idx].state = parseOutletFlag(st);
          const perAmps = outletAmpsArr ? toFiniteNumber(outletAmpsArr[idx]) : null;
          if (perAmps !== null && perAmps >= 0) {
            dev.outlets[idx].currentAmps = perAmps;
            dev.outlets[idx].currentWatts = Math.round(perAmps * lineVolts);
          } else if (!dev.outlets[idx].state) {
            dev.outlets[idx].currentAmps = 0.0;
            dev.outlets[idx].currentWatts = 0;
          }
          const perKwh = outletKwhArr ? toFiniteNumber(outletKwhArr[idx]) : null;
          if (perKwh !== null && perKwh >= 0) {
            dev.outlets[idx].totalKwh = perKwh;
          }
        }
      });
    }

    // 5. Energy & Cost (Explicit from ESP32 or calculated incrementally by Backend)
    const kwhVal = toFiniteNumber(
      payload.kwh !== undefined ? payload.kwh : (payload.tk !== undefined ? payload.tk : payload.total_kwh)
    );
    const costVal = toFiniteNumber(
      payload.cost !== undefined ? payload.cost : (payload.c !== undefined ? payload.c : payload.cost_egp)
    );

    if (kwhVal !== null && kwhVal >= 0) {
      dev.safety.totalKwh = kwhVal;
    } else if (this.lastEnergyTickMs !== null && dev.safety.totalWatts > 0) {
      const dtHours = Math.min((nowMs - this.lastEnergyTickMs) / 3600000.0, 0.05); // cap interval to avoid jump after long offline gap
      const deltaKwh = (dev.safety.totalWatts / 1000.0) * dtHours;
      dev.safety.totalKwh = parseFloat((dev.safety.totalKwh + deltaKwh).toFixed(5));

      // Distribute delta proportionally by per-outlet watts when available, else split equally among active outlets
      if (!outletKwhArr) {
        const activeOutlets = dev.outlets.filter(o => o.state);
        if (activeOutlets.length > 0) {
          const activeWattsSum = activeOutlets.reduce((sum, o) => sum + (o.currentWatts || 0), 0);
          activeOutlets.forEach(o => {
            const shareRatio = activeWattsSum > 0
              ? ((o.currentWatts || 0) / activeWattsSum)
              : (1 / activeOutlets.length);
            o.totalKwh = parseFloat((o.totalKwh + deltaKwh * shareRatio).toFixed(5));
          });
        }
      }
    }
    this.lastEnergyTickMs = nowMs;

    const tariff = dev.tariffEgp || 1.25;
    if (costVal !== null && costVal >= 0) {
      dev.safety.costEgp = costVal;
    } else {
      dev.safety.costEgp = parseFloat((dev.safety.totalKwh * tariff).toFixed(2));
    }

    // 6. Alert Synchronization (Keep prior overheat lock so safetyService evaluates <60°C release & logs it)
    const alertVal = String(payload.alert || payload.al || 'OK').trim() || 'OK';
    const isOverheatAlert = alertVal === 'OVERHEAT' || alertVal === 'OVERHEAT_SHUTDOWN';
    const isOverloadAlert = alertVal === 'OVERLOAD' || alertVal.startsWith('LOAD_SHEDDING');

    dev.safety.isOverheatLocked = isOverheatAlert || prevOverheatLocked;
    dev.safety.alert = dev.safety.isOverheatLocked && !isOverheatAlert ? 'OVERHEAT' : alertVal;
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

  syncLatestHistoryAlert(alert) {
    if (this.data.telemetryHistory.length > 0 && alert) {
      this.data.telemetryHistory[this.data.telemetryHistory.length - 1].alert = alert;
    }
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
