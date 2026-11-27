/**
 * Built-in ESP32 Hardware Simulator Transport (?mock=1 or via Settings)
 * Simulates currents (~0.9 / 2.1 / 1.2 / 0.6A), temp, kWh, schedules, timers & hardware safety.
 * Exposes window.__mock = { setTemp, setLoad, setVoltage, getState } for interactive testing.
 */

function cairoClockString() {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date());
  } catch (_) {
    return new Date().toTimeString().slice(0, 8);
  }
}

export function createMockTransport(config, handlers) {
  let connected = false;
  let tickInterval = null;
  let lastTickMs = Date.now();
  let lastScheduleMin = '';

  const nominalLoads = [0.9, 2.1, 1.2, 0.6];
  const sim = {
    outlets: [false, false, false, false],
    customAmps: [null, null, null, null],
    outletKwh: [0, 0, 0, 0],
    temp: 28.5,
    tempPinned: null,
    volts: 221.0,
    totalKwh: 0.0,
    alert: 'OK',
    overheatLocked: false,
    schedules: [
      { enabled: false, on: '08:00', off: '23:00' },
      { enabled: false, on: '08:00', off: '23:00' },
      { enabled: false, on: '08:00', off: '23:00' },
      { enabled: false, on: '08:00', off: '23:00' }
    ],
    timers: new Map()
  };

  function computePacket(src = 'hb') {
    const nowMs = Date.now();
    const dtHours = Math.min((nowMs - lastTickMs) / 3600000, 0.01);
    lastTickMs = nowMs;

    // Temperature simulation
    if (sim.tempPinned !== null) {
      sim.temp = sim.tempPinned;
    } else {
      const activeCount = sim.outlets.filter(Boolean).length;
      const targetTemp = 27.0 + activeCount * 2.1;
      sim.temp = Number((sim.temp + (targetTemp - sim.temp) * 0.15).toFixed(1));
    }

    // Overheat protection (>= 65°C trip, < 60°C reset)
    if (sim.temp >= 65.0) {
      sim.overheatLocked = true;
      sim.outlets = [false, false, false, false];
      sim.alert = 'OVERHEAT';
      src = 'prot';
    } else if (sim.temp < 60.0 && sim.overheatLocked) {
      sim.overheatLocked = false;
      sim.alert = 'OK';
      src = 'prot';
    }

    // Compute per-outlet amps
    const ampsArr = sim.outlets.map((isOn, idx) => {
      if (!isOn) return 0.0;
      if (sim.customAmps[idx] !== null) return sim.customAmps[idx];
      const jitter = (Math.random() - 0.5) * 0.06;
      return Number(Math.max(0.1, nominalLoads[idx] + jitter).toFixed(2));
    });

    let totalAmps = ampsArr.reduce((sum, a) => sum + a, 0);

    // Overload protection (> 16A triggers Priority Load Shedding P4 -> P3 -> P2; P1 kept)
    if (totalAmps > 16.0) {
      for (let i = 3; i >= 1; i--) {
        if (sim.outlets[i]) {
          sim.outlets[i] = false;
          ampsArr[i] = 0.0;
          sim.alert = 'OVERLOAD';
          src = 'prot';
          break;
        }
      }
      totalAmps = ampsArr.reduce((sum, a) => sum + a, 0);
    } else if (!sim.overheatLocked && sim.alert === 'OVERLOAD' && totalAmps < 15.5) {
      sim.alert = 'OK';
    }

    const totalWatts = Math.round(totalAmps * sim.volts);
    if (totalWatts > 0) {
      const deltaKwh = (totalWatts / 1000) * dtHours;
      sim.totalKwh = Number((sim.totalKwh + deltaKwh).toFixed(5));
      ampsArr.forEach((a, idx) => {
        if (a > 0 && totalAmps > 0) {
          sim.outletKwh[idx] = Number((sim.outletKwh[idx] + deltaKwh * (a / totalAmps)).toFixed(5));
        }
      });
    }

    return {
      src,
      tm: cairoClockString(),
      ntp: true,
      temp: sim.temp,
      volts: sim.volts,
      amps: Number(totalAmps.toFixed(2)),
      watts: totalWatts,
      kwh: Number(sim.totalKwh.toFixed(4)),
      cost: Number((sim.totalKwh * 1.25).toFixed(2)),
      alert: sim.alert,
      outlets: [...sim.outlets],
      outletAmps: ampsArr,
      outletKwh: sim.outletKwh.map((v) => Number(v.toFixed(4))),
      sch: sim.schedules.map((s) => [s.enabled, s.on, s.off])
    };
  }

  function emitTelemetry(src = 'hb') {
    if (!connected) return;
    handlers.onMessage?.({ kind: 'telemetry', data: computePacket(src), retained: false });
  }

  function checkSchedules() {
    const hhmm = cairoClockString().slice(0, 5);
    if (hhmm === lastScheduleMin) return;
    lastScheduleMin = hhmm;

    let changed = false;
    sim.schedules.forEach((sch, idx) => {
      if (!sch.enabled) return;
      if (sch.on === hhmm && !sim.overheatLocked && !sim.outlets[idx]) {
        sim.outlets[idx] = true;
        changed = true;
      } else if (sch.off === hhmm && sim.outlets[idx]) {
        sim.outlets[idx] = false;
        changed = true;
      }
    });
    if (changed) emitTelemetry('sch');
  }

  // Expose interactive test hook per Section 6 & 11
  window.__mock = {
    setTemp(tempC) {
      sim.tempPinned = Number(tempC);
      sim.temp = Number(tempC);
      emitTelemetry('prot');
    },
    clearTempPin() {
      sim.tempPinned = null;
    },
    setLoad(outletId, amps) {
      const idx = Number(outletId) - 1;
      if (idx >= 0 && idx < 4) {
        sim.customAmps[idx] = amps === null ? null : Number(amps);
        if (amps > 0 && !sim.overheatLocked) sim.outlets[idx] = true;
        emitTelemetry('hb');
      }
    },
    setVoltage(v) {
      sim.volts = Number(v);
      emitTelemetry('hb');
    },
    getState: () => JSON.parse(JSON.stringify(sim))
  };

  return {
    type: 'mock',
    connect() {
      connected = true;
      lastTickMs = Date.now();
      handlers.onStatus?.('connected');
      handlers.onMessage?.({ kind: 'lwt', text: 'online', retained: false });
      emitTelemetry('boot');
      clearInterval(tickInterval);
      tickInterval = setInterval(() => {
        checkSchedules();
        emitTelemetry('hb');
      }, 2000);
    },
    disconnect() {
      connected = false;
      clearInterval(tickInterval);
      for (const timerId of sim.timers.values()) clearTimeout(timerId);
      sim.timers.clear();
      handlers.onStatus?.('disconnected');
    },
    isConnected() {
      return connected;
    },
    publish(cmdObj) {
      if (!connected) return false;
      const type = cmdObj.type || (cmdObj.o !== undefined ? 'outlet' : cmdObj.all !== undefined ? 'all' : cmdObj.sync ? 'sync' : null);

      if (type === 'sync') {
        emitTelemetry('sync');
        return true;
      }
      if (type === 'resetEnergy') {
        sim.totalKwh = 0;
        sim.outletKwh = [0, 0, 0, 0];
        emitTelemetry('cmd');
        return true;
      }
      if (type === 'outlet') {
        const id = Number(cmdObj.id ?? cmdObj.o);
        const state = Boolean(cmdObj.state ?? cmdObj.s);
        if (state && sim.overheatLocked) {
          emitTelemetry('prot');
          return false;
        }
        if (id >= 1 && id <= 4) {
          sim.outlets[id - 1] = state;
          emitTelemetry('cmd');
        }
        return true;
      }
      if (type === 'all') {
        const state = Boolean(cmdObj.state ?? cmdObj.all);
        if (state && sim.overheatLocked) {
          emitTelemetry('prot');
          return false;
        }
        sim.outlets = [state, state, state, state];
        emitTelemetry('cmd');
        return true;
      }
      if (type === 'schedule') {
        const idx = Number(cmdObj.id ?? cmdObj.schedule) - 1;
        if (idx >= 0 && idx < 4) {
          sim.schedules[idx] = {
            enabled: Boolean(cmdObj.enabled),
            on: cmdObj.on || '08:00',
            off: cmdObj.off || '23:00'
          };
          emitTelemetry('sch');
        }
        return true;
      }
      if (type === 'timer') {
        const idx = Number(cmdObj.id ?? cmdObj.outlet) - 1;
        const delayMs = Math.max(100, Number(cmdObj.delaySec || 10) * 1000);
        const targetState = Boolean(cmdObj.state);
        if (idx >= 0 && idx < 4) {
          if (sim.timers.has(idx)) clearTimeout(sim.timers.get(idx));
          const tId = setTimeout(() => {
            sim.timers.delete(idx);
            if (!(targetState && sim.overheatLocked)) {
              sim.outlets[idx] = targetState;
              emitTelemetry('timer');
            }
          }, delayMs);
          sim.timers.set(idx, tId);
        }
        return true;
      }
      return false;
    }
  };
}
