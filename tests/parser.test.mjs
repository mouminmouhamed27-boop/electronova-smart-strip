import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from '../public/js/voice/parser.js';
import { evaluateCommandSafety } from '../public/js/core/safety.js';
import { parseTelemetry, buildCommand } from '../public/js/core/protocol.js';
import { createInitialState } from '../public/js/core/store.js';

test('English voice commands (strict)', () => {
  assert.deepEqual(parseCommand('turn on all').actions, [{ type: 'all', state: true }]);
  assert.deepEqual(parseCommand('turn off all').actions, [{ type: 'all', state: false }]);
  assert.deepEqual(parseCommand('turn on 1').actions, [{ type: 'outlet', id: 1, state: true }]);
  assert.deepEqual(parseCommand('2 off').actions, [{ type: 'outlet', id: 2, state: false }]);
  assert.deepEqual(parseCommand('turn on 1 and 3').actions, [
    { type: 'outlet', id: 1, state: true },
    { type: 'outlet', id: 3, state: true }
  ]);
  assert.deepEqual(parseCommand('1 and 2 off').actions, [
    { type: 'outlet', id: 1, state: false },
    { type: 'outlet', id: 2, state: false }
  ]);
  assert.deepEqual(parseCommand('turn on 1 turn off 2').actions, [
    { type: 'outlet', id: 1, state: true },
    { type: 'outlet', id: 2, state: false }
  ]);
  assert.deepEqual(parseCommand('shutdown').actions, [{ type: 'all', state: false }]);
});

test('Arabic voice commands (Egyptian & Standard)', () => {
  assert.deepEqual(parseCommand('شغل الكل').actions, [{ type: 'all', state: true }]);
  assert.deepEqual(parseCommand('اطفي الكل').actions, [{ type: 'all', state: false }]);
  assert.deepEqual(parseCommand('افصل 2').actions, [{ type: 'outlet', id: 2, state: false }]);
  assert.deepEqual(parseCommand('شغل واحد وتلاتة').actions, [
    { type: 'outlet', id: 1, state: true },
    { type: 'outlet', id: 3, state: true }
  ]);
  assert.deepEqual(parseCommand('اقفل التالت').actions, [{ type: 'outlet', id: 3, state: false }]);
  assert.deepEqual(parseCommand('شغل ٣').actions, [{ type: 'outlet', id: 3, state: true }]);
  assert.deepEqual(parseCommand('شغل الراوتر').actions, [{ type: 'outlet', id: 1, state: true }]);
  assert.deepEqual(parseCommand('اطفي النور').actions, [{ type: 'outlet', id: 3, state: false }]);
});

test('Fuzzy matching (strict interim = empty, final = matched)', () => {
  assert.deepEqual(parseCommand('turn on to', { allowFuzzy: false }).actions, []);
  assert.deepEqual(parseCommand('turn on to', { allowFuzzy: true }).actions, [{ type: 'outlet', id: 2, state: true }]);
  assert.deepEqual(parseCommand('olaf', { allowFuzzy: false }).actions, []);
  assert.deepEqual(parseCommand('olaf', { allowFuzzy: true }).actions, [{ type: 'all', state: false }]);
});

test('Negative and non-matching sentences', () => {
  assert.deepEqual(parseCommand('hello world').actions, []);
  assert.deepEqual(parseCommand('turn on').actions, []);
  assert.deepEqual(parseCommand('one two three').actions, []);
  assert.deepEqual(parseCommand('فصل بنتي').actions, []);
});

test('Safety rules: offline blocks EVERYTHING, overheat & overload block ON only', () => {
  const offlineState = { cloudStatus: 'connected', isOnline: false };
  assert.equal(evaluateCommandSafety({}, true, offlineState).allowed, false);
  assert.equal(evaluateCommandSafety({}, false, offlineState).allowed, false);

  const cloudDownState = { cloudStatus: 'disconnected', isOnline: true };
  assert.equal(evaluateCommandSafety({}, true, cloudDownState).allowed, false);
  assert.equal(evaluateCommandSafety({}, false, cloudDownState).allowed, false);

  const onlineState = { cloudStatus: 'connected', isOnline: true };
  const overheat = { isOverheatLocked: true, alert: 'OVERHEAT', totalAmps: 0 };
  assert.equal(evaluateCommandSafety(overheat, true, onlineState).allowed, false);
  assert.equal(evaluateCommandSafety(overheat, false, onlineState).allowed, true);

  const overload = { isOverheatLocked: false, isOverloadBlocked: true, totalAmps: 16.5 };
  assert.equal(evaluateCommandSafety(overload, true, onlineState).allowed, false);
  assert.equal(evaluateCommandSafety(overload, false, onlineState).allowed, true);
});

test('Protocol telemetry normalization & Unified command builders', () => {
  assert.deepEqual(buildCommand({ type: 'outlet', id: 1, state: true }), { type: 'outlet', id: 1, state: true });
  assert.deepEqual(buildCommand({ type: 'all', state: false }), { type: 'all', state: false });
  assert.deepEqual(buildCommand({ type: 'sync' }), { type: 'sync' });

  const base = createInitialState();
  base.pendingUntil[1] = Date.now() + 1500;
  base.pendingState[1] = true;

  // Regular heartbeat keeps optimistic ON while pending
  const afterHb = parseTelemetry({ src: 'hb', outlets: [false, false, false, false], temp: 30, amps: 1, watts: 220 }, base);
  assert.equal(afterHb.outlets[0].state, true);
  assert.equal(afterHb.isOnline, true);

  // Bypass source ('btn') forces actual hardware state
  const afterBtn = parseTelemetry({ src: 'btn', outlets: [false, false, false, false], temp: 30, amps: 0, watts: 0 }, { ...base, ...afterHb });
  assert.equal(afterBtn.outlets[0].state, false);

  // Retained message does NOT mark ESP32 online
  const afterRetained = parseTelemetry({ temp: 29, outlets: [false, false, false, false] }, createInitialState(), { retained: true });
  assert.equal(afterRetained.isOnline, false);
});
