/**
 * Shared input & telemetry parsing validators.
 */

function toFiniteNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function parseBooleanStrict(val) {
  if (typeof val === 'boolean') return val;
  if (val === 1) return true;
  if (val === 0) return false;
  if (typeof val === 'string') {
    const norm = val.trim().toLowerCase();
    if (['true', '1', 'on'].includes(norm)) return true;
    if (['false', '0', 'off'].includes(norm)) return false;
  }
  return null;
}

function parseOutletId(rawId) {
  const str = String(rawId || '').trim();
  if (!/^[1-4]$/.test(str)) return null;
  return parseInt(str, 10);
}

function isValidTimeHHMM(val) {
  return typeof val === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(val.trim());
}

function isValidEmail(val) {
  return typeof val === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());
}

module.exports = {
  toFiniteNumber,
  parseBooleanStrict,
  parseOutletId,
  isValidTimeHHMM,
  isValidEmail
};
