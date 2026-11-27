/**
 * Pure Safety Rules (reflects hardware/backend protection; OFF is ALWAYS permitted when ESP32 is online)
 */

export const SAFETY_THRESHOLDS = {
  overheatTripC: 65.0,
  overheatResetC: 60.0,
  maxRatedAmps: 16.0,
  perOutletMaxAmps: 10.0,
  safeContinuousAmps: 12.8,
  perOutletSafeAmps: 7.0,
  minVolts: 190.0,
  maxVolts: 250.0
};

export function isSensorFaultLocked(safety = {}) {
  const alert = String(safety.alert || 'OK');
  return Boolean(
    safety.isSensorFault ||
    safety.isTempSensorFault ||
    safety.isCurrentSensorFault ||
    alert === 'SENSOR_FAULT'
  );
}

export function isOverheatLocked(safety = {}) {
  const alert = String(safety.alert || 'OK');
  return Boolean(
    safety.isOverheatLocked ||
    alert === 'OVERHEAT' ||
    alert === 'OVERHEAT_SHUTDOWN'
  );
}

export function isOvercurrentLatched(safety = {}) {
  const alert = String(safety.alert || 'OK');
  return Boolean(safety.isOvercurrentLatched || alert === 'OVERCURRENT_LATCHED');
}

export function isOverloadLocked(safety = {}) {
  const amps = Number(safety.totalAmps || 0);
  return Boolean(safety.isOverloadBlocked || isOvercurrentLatched(safety) || amps > SAFETY_THRESHOLDS.maxRatedAmps);
}

export function getSafetyLockReason(safety = {}) {
  if (isSensorFaultLocked(safety)) return 'عطل في حساس الحرارة أو التيار (SENSOR_FAULT)';
  if (isOverheatLocked(safety)) return 'حماية الحرارة مفعّلة (>= 65°C)';
  if (isOvercurrentLatched(safety)) return 'قفل دائم بعد 3 فصلات تيار زائد — افحص الأحمال ثم فك القفل';
  if (isOverloadLocked(safety)) return 'حماية زيادة الحمل مفعّلة (> 16A)';
  return null;
}

export function isDeviceReady(state = {}) {
  return state.cloudStatus === 'connected' && Boolean(state.isOnline);
}

/**
 * Evaluate whether turning ON/OFF or setting timer is permitted.
 * - Requires active connection to real ESP32 first (both ON and OFF blocked when offline).
 * - When connected: OFF is always allowed; ON is blocked on Sensor Fault / Overheat / Latch / Overload.
 */
export function evaluateCommandSafety(safety, targetState, state = null) {
  if (state && !isDeviceReady(state)) {
    const msg = state.cloudStatus !== 'connected'
      ? 'السحابة غير متصلة — تعذر إرسال الأمر.'
      : 'المشترك غير متصل بـ ESP32 حقيقي — وصّل المشترك الفعلي أولاً.';
    return { allowed: false, offline: true, reason: msg };
  }
  if (!targetState) {
    return { allowed: true, offline: false, reason: null };
  }
  const reason = getSafetyLockReason(safety);
  return {
    allowed: !reason,
    offline: false,
    reason
  };
}
