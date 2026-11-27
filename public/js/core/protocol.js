/**
 * Telemetry Normalization, Unified/Legacy Command Builders, & Optimistic Sync Rules
 * Matches Express Backend & ESP32 Unified Contract (zero DOM access).
 */

const BYPASS_SOURCES = new Set(['btn', 'cmd', 'sync', 'boot', 'prot', 'timer', 'sch', 'ws']);

function finiteOr(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  const num = Number(val);
  return Number.isFinite(num) ? num : fallback;
}

function parseFlag(val) {
  if (typeof val === 'boolean') return val;
  if (val === 1 || val === '1' || String(val).toLowerCase() === 'true') return true;
  if (val === 0 || val === '0' || String(val).toLowerCase() === 'false') return false;
  return Boolean(val);
}

/**
 * Normalize either Backend deviceState OR raw ESP32 JSON packet (Unified / Legacy)
 */
export function parseTelemetry(raw, prevState, { retained = false, nowMs = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const isBackendShape = Boolean(raw.safety && Array.isArray(raw.outlets));

  const src = String(raw.src || '').trim().toLowerCase();
  const bypassOptimistic = BYPASS_SOURCES.has(src);

  const prevSafety = prevState.safety || {};
  let temperatureC = prevSafety.temperatureC ?? 25.0;
  let volts = prevSafety.volts ?? 220.0;
  let totalAmps = prevSafety.totalAmps ?? 0.0;
  let totalWatts = prevSafety.totalWatts ?? 0;
  let totalKwh = prevSafety.totalKwh ?? 0.0;
  let costEgp = prevSafety.costEgp ?? 0.0;
  let alert = 'OK';
  let overheatFlag = false;
  let overloadFlag = false;
  let latchedFlag = false;
  let sensorFaultFlag = false;
  let tempFaultFlag = false;
  let currFaultFlag = false;
  let overcurrentTrips = prevSafety.overcurrentTrips ?? 0;
  let lastTripReason = prevSafety.lastTripReason ?? null;
  let continuousFlag = false;
  let voltageFlag = false;
  const tariffEgp = finiteOr(raw.tariffEgp, prevState.tariffEgp || 1.25);

  if (isBackendShape) {
    temperatureC = finiteOr(raw.safety.temperatureC, temperatureC);
    volts = finiteOr(raw.safety.volts, volts);
    totalAmps = finiteOr(raw.safety.totalAmps, totalAmps);
    totalWatts = Math.round(finiteOr(raw.safety.totalWatts, totalWatts));
    totalKwh = finiteOr(raw.safety.totalKwh, totalKwh);
    costEgp = finiteOr(raw.safety.costEgp, costEgp);
    alert = String(raw.safety.alert || 'OK');
    overheatFlag = Boolean(raw.safety.isOverheatLocked) || alert === 'OVERHEAT' || alert === 'OVERHEAT_SHUTDOWN';
    latchedFlag = Boolean(raw.safety.isOvercurrentLatched) || alert === 'OVERCURRENT_LATCHED';
    tempFaultFlag = Boolean(raw.safety.isTempSensorFault);
    currFaultFlag = Boolean(raw.safety.isCurrentSensorFault);
    sensorFaultFlag = Boolean(raw.safety.isSensorFault) || tempFaultFlag || currFaultFlag || alert === 'SENSOR_FAULT';
    overloadFlag = Boolean(raw.safety.isOverloadBlocked) || latchedFlag || alert === 'OVERLOAD' || alert.startsWith('LOAD_SHEDDING') || totalAmps > 16.0;
    overcurrentTrips = finiteOr(raw.safety.overcurrentTrips, overcurrentTrips);
    lastTripReason = raw.safety.lastTripReason ?? lastTripReason;
    continuousFlag = Boolean(raw.safety.isContinuousWarning) || totalAmps >= 12.8;
    voltageFlag = Boolean(raw.safety.isVoltageFault) || volts < 190.0 || volts > 250.0;
  } else {
    temperatureC = finiteOr(raw.temp ?? raw.t ?? raw.temp_c, temperatureC);
    volts = finiteOr(raw.volts ?? raw.v, volts);
    totalAmps = finiteOr(raw.amps ?? raw.ta ?? raw.total_amps, totalAmps);
    const wRaw = raw.watts ?? raw.w ?? raw.total_w;
    totalWatts = wRaw !== undefined ? Math.round(finiteOr(wRaw, totalWatts)) : Math.round(totalAmps * volts);
    totalKwh = finiteOr(raw.kwh ?? raw.tk ?? raw.total_kwh, totalKwh);
    const cRaw = raw.cost ?? raw.c ?? raw.cost_egp;
    costEgp = cRaw !== undefined ? finiteOr(cRaw, costEgp) : parseFloat((totalKwh * tariffEgp).toFixed(2));
    alert = String(raw.alert ?? raw.al ?? 'OK').trim() || 'OK';
    overheatFlag = alert === 'OVERHEAT' || alert === 'OVERHEAT_SHUTDOWN' || Boolean(raw.thermalCut);
    latchedFlag = alert === 'OVERCURRENT_LATCHED' || Boolean(raw.overcurrentLatched);
    tempFaultFlag = Boolean(raw.tempSensorFault);
    currFaultFlag = Boolean(raw.currentSensorFault);
    sensorFaultFlag = alert === 'SENSOR_FAULT' || Boolean(raw.sensorFault) || tempFaultFlag || currFaultFlag;
    overloadFlag = alert === 'OVERLOAD' || alert.startsWith('LOAD_SHEDDING') || latchedFlag || totalAmps > 16.0;
    overcurrentTrips = finiteOr(raw.overcurrentTrips, overcurrentTrips);
    if (raw.lastTripReason !== undefined) lastTripReason = raw.lastTripReason;
    continuousFlag = totalAmps >= 12.8;
    voltageFlag = volts < 190.0 || volts > 250.0;
  }

  const blockOptimistic = overheatFlag || sensorFaultFlag || latchedFlag;
  const nextPendingUntil = blockOptimistic ? {} : { ...(prevState.pendingUntil || {}) };
  const nextPendingState = blockOptimistic ? {} : { ...(prevState.pendingState || {}) };

  const outletStatesArr = !isBackendShape ? (Array.isArray(raw.outlets) ? raw.outlets : (Array.isArray(raw.s) ? raw.s : null)) : null;
  const outletAmpsArr = !isBackendShape ? (Array.isArray(raw.outletAmps) ? raw.outletAmps : (Array.isArray(raw.a) ? raw.a : null)) : null;
  const outletKwhArr = !isBackendShape ? (Array.isArray(raw.outletKwh) ? raw.outletKwh : (Array.isArray(raw.k) ? raw.k : null)) : null;

  const outlets = prevState.outlets.map((prevOutlet, idx) => {
    const id = prevOutlet.id;
    let incomingState = prevOutlet.state;
    let amps = prevOutlet.currentAmps;
    let watts = prevOutlet.currentWatts;
    let kwh = prevOutlet.totalKwh;

    if (isBackendShape && raw.outlets[idx]) {
      const bOut = raw.outlets[idx];
      incomingState = Boolean(bOut.state);
      amps = finiteOr(bOut.currentAmps, amps);
      watts = Math.round(finiteOr(bOut.currentWatts, amps * volts));
      kwh = finiteOr(bOut.totalKwh, kwh);
    } else {
      if (outletStatesArr && outletStatesArr[idx] !== undefined) {
        incomingState = parseFlag(outletStatesArr[idx]);
      }
      if (outletAmpsArr && outletAmpsArr[idx] !== undefined) {
        amps = finiteOr(outletAmpsArr[idx], amps);
        watts = Math.round(amps * volts);
      } else if (!incomingState) {
        amps = 0.0;
        watts = 0;
      }
      if (outletKwhArr && outletKwhArr[idx] !== undefined) {
        kwh = finiteOr(outletKwhArr[idx], kwh);
      }
    }

    const pendingExp = nextPendingUntil[id] || 0;
    let finalState = incomingState;
    if (!blockOptimistic && !bypassOptimistic && pendingExp > nowMs) {
      if (incomingState !== nextPendingState[id]) {
        finalState = nextPendingState[id];
      } else {
        delete nextPendingUntil[id];
        delete nextPendingState[id];
      }
    } else if (bypassOptimistic && pendingExp > 0) {
      delete nextPendingUntil[id];
      delete nextPendingState[id];
    }

    return {
      ...prevOutlet,
      name: (isBackendShape && raw.outlets[idx]?.name) || prevOutlet.name,
      priority: (isBackendShape && raw.outlets[idx]?.priority) || prevOutlet.priority,
      isProtected: (isBackendShape && raw.outlets[idx]?.isProtected !== undefined)
        ? Boolean(raw.outlets[idx].isProtected)
        : prevOutlet.isProtected,
      state: finalState,
      currentAmps: finalState ? amps : 0.0,
      currentWatts: finalState ? watts : 0,
      totalKwh: kwh
    };
  });

  // Schedules merge
  let schedules = prevState.schedules;
  if (isBackendShape && Array.isArray(raw.schedules)) {
    schedules = prevState.schedules.map((sch, idx) =>
      raw.schedules[idx] ? { ...sch, ...raw.schedules[idx] } : sch
    );
  } else if (Array.isArray(raw.sch)) {
    schedules = prevState.schedules.map((sch, idx) => {
      const item = raw.sch[idx];
      if (!Array.isArray(item)) return sch;
      return {
        ...sch,
        enabled: Boolean(item[0]),
        onTime: item[1] || sch.onTime,
        offTime: item[2] || sch.offTime
      };
    });
  }

  let nextOnline = prevState.isOnline;
  let nextLastHeartbeatMs = prevState.lastHeartbeatMs;

  if (isBackendShape) {
    nextOnline = Boolean(raw.isOnline);
    if (raw.lastHeartbeat) {
      const hbMs = new Date(raw.lastHeartbeat).getTime();
      if (Number.isFinite(hbMs) && hbMs > 0) nextLastHeartbeatMs = hbMs;
    }
  } else if (!retained) {
    nextOnline = true;
    nextLastHeartbeatMs = nowMs;
  }

  return {
    deviceId: raw.id || prevState.deviceId,
    isOnline: nextOnline,
    connectionMode: raw.connectionMode || (nextOnline ? prevState.connectionMode : 'offline'),
    lastHeartbeatMs: nextLastHeartbeatMs,
    espTime: raw.tm || raw.time || prevState.espTime,
    ntpSynced: raw.ntp !== undefined ? Boolean(raw.ntp) : prevState.ntpSynced,
    tariffEgp,
    diagnostics: raw.diagnostics
      ? { ...(prevState.diagnostics || {}), ...raw.diagnostics }
      : {
          ...(prevState.diagnostics || {}),
          ...(raw.ip !== undefined ? { ip: raw.ip } : {}),
          ...(raw.rssi !== undefined ? { rssi: finiteOr(raw.rssi, null) } : {}),
          ...(raw.firmwareVersion ? { firmwareVersion: raw.firmwareVersion } : {}),
          ...(lastTripReason ? { lastTripReason } : {}),
          overcurrentTrips
        },
    assistants: raw.assistants ? { ...(prevState.assistants || {}), ...raw.assistants } : prevState.assistants,
    safety: {
      temperatureC,
      volts,
      totalAmps,
      totalWatts,
      totalKwh,
      costEgp,
      isOverheatLocked: overheatFlag,
      isOverloadBlocked: overloadFlag,
      isOvercurrentLatched: latchedFlag,
      isSensorFault: sensorFaultFlag,
      isTempSensorFault: tempFaultFlag,
      isCurrentSensorFault: currFaultFlag,
      overcurrentTrips,
      lastTripReason,
      isContinuousWarning: continuousFlag,
      isVoltageFault: voltageFlag,
      alert
    },
    outlets,
    schedules,
    pendingUntil: nextPendingUntil,
    pendingState: nextPendingState
  };
}

/**
 * Build Unified Contract Command Object (identical to Backend & ESP32 contract)
 */
export function buildCommand(action) {
  switch (action.type) {
    case 'outlet':
      return { type: 'outlet', id: action.id, state: Boolean(action.state) };
    case 'all':
      return { type: 'all', state: Boolean(action.state) };
    case 'sync':
      return { type: 'sync' };
    case 'schedule':
      return {
        type: 'schedule',
        id: action.id,
        enabled: Boolean(action.enabled),
        on: action.onTime,
        off: action.offTime
      };
    case 'timer':
      return {
        type: 'timer',
        id: action.id,
        state: Boolean(action.state),
        delaySec: parseInt(action.delaySec, 10)
      };
    case 'resetEnergy':
      return { type: 'resetEnergy' };
    default:
      throw new Error(`Unknown command type: ${action.type}`);
  }
}
