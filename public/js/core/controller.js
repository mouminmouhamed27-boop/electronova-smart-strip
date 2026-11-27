/**
 * Application Controller (wires Store <-> Transport <-> Safety <-> Smart Assistant Hub)
 * Zero direct DOM manipulation inside this module.
 */

import { store, createInitialState } from './store.js';
import { parseTelemetry, buildCommand } from './protocol.js';
import { evaluateCommandSafety, isDeviceReady } from './safety.js';
import { parseCommand } from '../voice/parser.js';
import { loadConfig, saveConfig, resetConfig } from '../config.js';
import { STRINGS } from '../strings.js';
import { playConfirmBeep, playErrorBeep } from '../voice/beep.js';

function cairoTimeNow() {
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

export function createController({ createTransport, onToast, onShake, onAuthRequired }) {
  let config = loadConfig();
  let transport = null;
  let watchdogTimer = null;
  let clockTimer = null;
  const timerIntervals = new Map();

  function addLog(text, level = 'info', time = null) {
    const entry = {
      text: String(text),
      level,
      time: time || cairoTimeNow()
    };
    store.setState((prev) => {
      const nextLogs = [...prev.logs, entry];
      if (nextLogs.length > 100) nextLogs.splice(0, nextLogs.length - 100);
      return { ...prev, logs: nextLogs };
    });
  }

  function applyTheme(theme) {
    const clean = theme === 'light' ? 'light' : 'dark';
    config.theme = clean;
    saveConfig(config);
    store.patch({ theme: clean });
  }

  function toggleTheme() {
    applyTheme(store.getState().theme === 'dark' ? 'light' : 'dark');
  }

  function formatServerLog(evt) {
    const d = evt.details || {};
    const map = {
      outlet_on: [`🔌 تشغيل مخرج ${d.outletId || ''} (${evt.source === 'smartnest_voice' ? 'Alexa/Google' : evt.source === 'ai_voice' ? 'AI' : 'ويب'})`, 'ok'],
      outlet_off: [`🔌 فصل مخرج ${d.outletId || ''}`, 'info'],
      master_on: ['⚡ تشغيل جميع المخارج', 'ok'],
      master_off: ['🛑 فصل جميع المخارج', 'warn'],
      schedule_update: [`📅 تحديث جدول مخرج ${d.outletId || ''}`, 'info'],
      schedule_on: [`📅 تشغيل مجدول لمخرج ${d.outletId || ''}`, 'ok'],
      schedule_off: [`📅 فصل مجدول لمخرج ${d.outletId || ''}`, 'info'],
      timer_set: [`⏰ ضبط مؤقت لمخرج ${d.outletId || ''} (${d.delaySec || ''}ث)`, 'info'],
      reset_energy: ['🔄 تصفير عداد الطاقة', 'warn'],
      device_switched: [`📡 تحويل الجهاز إلى ${d.deviceId || ''}`, 'info'],
      outlet_meta_updated: [`🏷️ تحديث اسم/حماية مخرج ${d.outletId || ''}`, 'info'],
      overheat_shutdown: [`🚨 إيقاف طوارئ للحرارة (${d.temperature || ''}°C)`, 'bad'],
      overheat_lock_released: [`✅ تبريد وفك قفل الحرارة (${d.temperature || ''}°C)`, 'ok'],
      sensor_fault_shutdown: ['🚨 فصل طوارئ: عطل حساس الحرارة/التيار', 'bad'],
      outlet_overcurrent_trip: [`⚡ فصل مخرج ${d.outletId || ''} (> 10A): ${d.amps || ''}A`, 'bad'],
      load_shedding: [`⚡ تخفيف حمل: فصل مخرج ${d.outletId || ''}`, 'warn'],
      safety_unlocked: ['🔓 فك قفل الأمان يدوياً', 'ok'],
      sequential_restore_complete: ['🔄 اكتمال التشغيل المتسلسل للمخارج', 'ok'],
      voice_command_blocked: [`🚫 رفض أمر أليكسا/جوجل: ${d.reason || ''}`, 'warn'],
      online: ['🟢 ESP32 متصل', 'ok'],
      offline: ['🔴 ESP32 منقطع', 'bad']
    };
    return map[evt.action] || [`• ${evt.action}`, 'info'];
  }

  function formatHistoryTime(iso) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Cairo',
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(new Date(iso));
    } catch (_) {
      return cairoTimeNow();
    }
  }

  async function loadBackendBootstrap() {
    if (!transport?.isBackend) return;
    const tok = transport.getToken();
    store.patch({ token: tok });

    try {
      const [histRes, liveRes] = await Promise.all([
        transport.fetchHistory().catch(() => null),
        transport.fetchLive().catch(() => null)
      ]);
      if (histRes && Array.isArray(histRes.history) && histRes.history.length > 0) {
        const points = histRes.history.slice(-30).map((h) => ({
          label: formatHistoryTime(h.timestamp),
          watts: Math.round(h.totalWatts || 0)
        }));
        store.patch({ history: points });
      }
      if (liveRes?.device) {
        handleTelemetryPayload(liveRes.device, true);
      }
    } catch (_) {}

    if (tok) {
      try {
        const me = await transport.getMe();
        store.patch({ user: me.user, token: tok });
        addLog(`👤 مرحباً بك، ${me.user.name}`, 'ok');
        loadBackendLogsAndAnalytics();
      } catch (_) {
        transport.setToken(null);
        store.patch({ user: null, token: null });
      }
    }
  }

  async function loadBackendLogsAndAnalytics() {
    if (!transport?.isBackend || !transport.getToken()) return;
    try {
      const [logsRes, analyticsRes] = await Promise.all([
        transport.fetchLogs().catch(() => null),
        transport.fetchAnalytics().catch(() => null)
      ]);
      if (logsRes && Array.isArray(logsRes.logs) && logsRes.logs.length > 0) {
        const recent = logsRes.logs.slice(0, 25).reverse();
        recent.forEach((evt) => {
          const [txt, lvl] = formatServerLog(evt);
          addLog(txt, lvl, formatHistoryTime(evt.timestamp));
        });
      }
      if (analyticsRes?.data) {
        store.patch({ analytics: analyticsRes.data });
      }
    } catch (_) {}
  }

  function handleTelemetryPayload(raw, retained = false) {
    const prev = store.getState();
    const parsed = parseTelemetry(raw, prev, { retained });
    if (!parsed) return;

    const wasOverheat = prev.safety.isOverheatLocked;
    const isOverheat = parsed.safety.isOverheatLocked;
    const wasOverload = prev.safety.isOverloadBlocked;
    const isOverload = parsed.safety.isOverloadBlocked;
    const wasSensorFault = prev.safety.isSensorFault;
    const isSensorFault = parsed.safety.isSensorFault;
    const wasLatched = prev.safety.isOvercurrentLatched;
    const isLatched = parsed.safety.isOvercurrentLatched;

    const shouldSkipHistory = retained && prev.history.length > 0;
    const nextHistory = shouldSkipHistory
      ? prev.history
      : [
          ...prev.history.slice(-29),
          { label: parsed.espTime && parsed.espTime !== '--:--:--' ? parsed.espTime : cairoTimeNow(), watts: parsed.safety.totalWatts }
        ];

    store.setState((curr) => ({
      ...curr,
      ...parsed,
      history: nextHistory
    }));

    if (!wasSensorFault && isSensorFault) {
      addLog(`🚨 ${STRINGS.sensorFaultBanner}`, 'bad');
      onToast?.('🚨 عطل في الحساسات — تم فصل المشترك لحين الفحص', 'bad');
    }
    if (!wasLatched && isLatched) {
      addLog(`🔒 ${STRINGS.latchedBanner}`, 'bad');
      onToast?.('🔒 قفل دائم بعد 3 فصلات تيار زائد', 'bad');
    }
    if (!wasOverheat && isOverheat) {
      addLog(`🚨 ${STRINGS.overheatBanner}`, 'bad');
      onToast?.('🚨 قفل حماية الحرارة (>= 65°C)!', 'bad');
    } else if (wasOverheat && !isOverheat) {
      addLog('✅ انخفضت الحرارة (< 60°C) وتم فك قفل الأمان', 'ok');
      onToast?.('✅ تم فك قفل الحرارة بأمان', 'ok');
    }

    if (!wasOverload && isOverload && !isLatched) {
      addLog(`⚡ ${STRINGS.overloadBanner(parsed.safety.alert)}`, 'warn');
      onToast?.('⚡ تم تخفيف الحمل لحماية المشترك (> 16A)', 'warn');
    }
  }

  function handleTransportMessage({ kind, data, text, retained }) {
    if (kind === 'lwt') {
      const statusText = String(text || '').trim().toLowerCase();
      if (statusText === 'offline') {
        store.patch({ isOnline: false, connectionMode: 'offline' });
        addLog('🔴 انقطاع اتصال المشترك (LWT Offline)', 'bad');
      } else if (statusText === 'online' && !retained) {
        store.patch({ isOnline: true, lastHeartbeatMs: Date.now() });
        addLog('🟢 المشترك متصل (LWT Online)', 'ok');
      }
      return;
    }

    if (kind === 'telemetry' && data) {
      handleTelemetryPayload(data, retained);
    }
  }

  function connectTransport() {
    if (transport) {
      transport.disconnect();
      transport = null;
    }

    const baseState = createInitialState();
    store.patch({
      theme: config.theme,
      transportType: config.transport,
      deviceId: config.deviceId,
      cloudStatus: 'connecting',
      isOnline: false,
      connectionMode: 'offline',
      lastHeartbeatMs: 0,
      history: config.transport === 'backend' ? store.getState().history : [],
      outlets: baseState.outlets,
      safety: baseState.safety
    });

    transport = createTransport(config, {
      onStatus(status) {
        store.patch({ cloudStatus: status });
        if (status === 'connected') {
          addLog(`⚡ تم الاتصال عبر (${config.transport})`, 'ok');
          Promise.resolve(transport.publish(buildCommand({ type: 'sync' }))).catch(() => {});
        } else if (status === 'disconnected') {
          addLog(`⚠️ انقطع الاتصال بـ (${config.transport})`, 'warn');
        }
      },
      onMessage: handleTransportMessage,
      onAuthRequired() {
        store.patch({ user: null, token: null });
        onAuthRequired?.(STRINGS.authRequired);
      }
    });

    transport.connect();
    loadBackendBootstrap();
  }

  function ensureAuthIfBackend() {
    if (transport?.isBackend && !transport.getToken()) {
      onAuthRequired?.(STRINGS.authRequired);
      return false;
    }
    return true;
  }

  function applyOptimisticOutlet(id, targetState) {
    const exp = Date.now() + 1500;
    store.setState((prev) => ({
      ...prev,
      outlets: prev.outlets.map((o) =>
        o.id === id ? { ...o, state: Boolean(targetState) } : o
      ),
      pendingUntil: { ...prev.pendingUntil, [id]: exp },
      pendingState: { ...prev.pendingState, [id]: Boolean(targetState) }
    }));
  }

  function applyOptimisticAll(targetState) {
    const exp = Date.now() + 1500;
    const pendingUntil = {};
    const pendingState = {};
    [1, 2, 3, 4].forEach((id) => {
      pendingUntil[id] = exp;
      pendingState[id] = Boolean(targetState);
    });
    store.setState((prev) => ({
      ...prev,
      outlets: prev.outlets.map((o) => ({ ...o, state: Boolean(targetState) })),
      pendingUntil,
      pendingState
    }));
  }

  function clearPending(ids) {
    store.setState((prev) => {
      const nextUntil = { ...prev.pendingUntil };
      const nextState = { ...prev.pendingState };
      ids.forEach((id) => {
        delete nextUntil[id];
        delete nextState[id];
      });
      return { ...prev, pendingUntil: nextUntil, pendingState: nextState };
    });
  }

  function requireOnlineDevice(shakeTarget = null, { silentToast = false } = {}) {
    const st = store.getState();
    if (!isDeviceReady(st)) {
      const reason = st.cloudStatus !== 'connected'
        ? 'السحابة غير متصلة — لا يمكن التحكم حالياً.'
        : 'المشترك غير متصل بـ ESP32 حقيقي — لا يتغير أي شيء حتى يتصل الجهاز الفعلي.';
      playErrorBeep(config.voiceBeeps !== false);
      if (shakeTarget) onShake?.(shakeTarget);
      addLog(`🚫 مرفوض: ${reason}`, 'bad');
      if (!silentToast) onToast?.(reason, 'bad');
      return { ok: false, reason };
    }
    return { ok: true };
  }

  async function setOutlet(id, targetState, { shakeTarget = null, silentToast = false } = {}) {
    const st = store.getState();
    const safetyCheck = evaluateCommandSafety(st.safety, Boolean(targetState), st);
    if (!safetyCheck.allowed) {
      playErrorBeep(config.voiceBeeps !== false);
      onShake?.(shakeTarget || `outlet-${id}`);
      addLog(`🚫 مرفوض (مخرج ${id}): ${safetyCheck.reason}`, 'bad');
      if (!silentToast) onToast?.(safetyCheck.offline ? safetyCheck.reason : STRINGS.blockedToast(safetyCheck.reason), 'bad');
      return { ok: false, blocked: true, offline: safetyCheck.offline, reason: safetyCheck.reason };
    }

    if (!ensureAuthIfBackend()) return { ok: false, auth: true };

    const prevStates = new Map(st.outlets.map((o) => [o.id, o.state]));
    applyOptimisticOutlet(id, targetState);
    try {
      await transport.publish(buildCommand({ type: 'outlet', id, state: targetState }));
      playConfirmBeep(targetState, config.voiceBeeps !== false);
      addLog(`🔌 مخرج ${id} ← ${targetState ? 'ON' : 'OFF'}`, targetState ? 'ok' : 'info');
      return { ok: true };
    } catch (err) {
      clearPending([id]);
      store.setState((prev) => ({
        ...prev,
        outlets: prev.outlets.map((o) => (o.id === id ? { ...o, state: prevStates.get(id) } : o))
      }));
      playErrorBeep(config.voiceBeeps !== false);
      addLog(`❌ فشل تبديل مخرج ${id}: ${err.message}`, 'bad');
      onToast?.(err.message, 'bad');
      return { ok: false, error: err.message };
    }
  }

  async function setAll(targetState, { shakeTarget = 'master-on', silentToast = false } = {}) {
    const st = store.getState();
    const safetyCheck = evaluateCommandSafety(st.safety, Boolean(targetState), st);
    if (!safetyCheck.allowed) {
      playErrorBeep(config.voiceBeeps !== false);
      onShake?.(targetState ? shakeTarget : 'master-off');
      addLog(`🚫 مرفوض (الكل): ${safetyCheck.reason}`, 'bad');
      if (!silentToast) onToast?.(safetyCheck.offline ? safetyCheck.reason : STRINGS.blockedToast(safetyCheck.reason), 'bad');
      return { ok: false, blocked: true, offline: safetyCheck.offline, reason: safetyCheck.reason };
    }

    if (!ensureAuthIfBackend()) return { ok: false, auth: true };

    const prevOutlets = st.outlets;
    applyOptimisticAll(targetState);
    try {
      await transport.publish(buildCommand({ type: 'all', state: targetState }));
      playConfirmBeep(targetState, config.voiceBeeps !== false);
      addLog(targetState ? '⚡ تشغيل جميع المخارج' : '🛑 فصل جميع المخارج', targetState ? 'ok' : 'warn');
      return { ok: true };
    } catch (err) {
      clearPending([1, 2, 3, 4]);
      store.patch({ outlets: prevOutlets });
      playErrorBeep(config.voiceBeeps !== false);
      addLog(`❌ فشل أمر الكل: ${err.message}`, 'bad');
      onToast?.(err.message, 'bad');
      return { ok: false, error: err.message };
    }
  }

  async function updateOutletMeta(id, meta) {
    if (transport?.isBackend) {
      if (!ensureAuthIfBackend()) return false;
      try {
        const res = await transport.updateOutletMeta(id, meta);
        if (res?.outlet) {
          store.setState((prev) => ({
            ...prev,
            outlets: prev.outlets.map((o) => (o.id === id ? { ...o, ...res.outlet } : o))
          }));
        }
        onToast?.(`✅ تم تحديث إعدادات مخرج ${id} ومزامنتها`, 'ok');
        addLog(`🏷️ تحديث بيانات مخرج ${id}`, 'info');
        return true;
      } catch (err) {
        onToast?.(err.message, 'bad');
        return false;
      }
    }
    store.setState((prev) => ({
      ...prev,
      outlets: prev.outlets.map((o) => (o.id === id ? { ...o, ...meta } : o))
    }));
    onToast?.(`✅ تم تحديث بيانات مخرج ${id} محلياً`, 'ok');
    return true;
  }

  async function setSchedule(id, enabled, onTime, offTime) {
    if (!requireOnlineDevice(`outlet-${id}`).ok) return false;
    if (!ensureAuthIfBackend()) return false;
    try {
      await transport.publish(buildCommand({ type: 'schedule', id, enabled, onTime, offTime }));
      store.setState((prev) => ({
        ...prev,
        schedules: prev.schedules.map((s) =>
          s.outletId === id ? { ...s, enabled: Boolean(enabled), onTime, offTime } : s
        )
      }));
      addLog(`📅 تم حفظ جدول مخرج ${id} (${onTime}–${offTime})`, 'ok');
      onToast?.(`📅 تم حفظ جدول مخرج ${id}`, 'ok');
      return true;
    } catch (err) {
      addLog(`❌ فشل حفظ الجدول: ${err.message}`, 'bad');
      onToast?.(err.message, 'bad');
      return false;
    }
  }

  async function setTimer(id, delaySec) {
    const st = store.getState();
    const outlet = st.outlets.find((o) => o.id === id);
    const targetState = outlet ? !outlet.state : false;

    const safetyCheck = evaluateCommandSafety(st.safety, targetState, st);
    if (!safetyCheck.allowed) {
      playErrorBeep(config.voiceBeeps !== false);
      onShake?.(`outlet-${id}`);
      addLog(`🚫 مرفوض (مؤقت مخرج ${id}): ${safetyCheck.reason}`, 'bad');
      onToast?.(safetyCheck.offline ? safetyCheck.reason : STRINGS.blockedToast(safetyCheck.reason), 'bad');
      return false;
    }

    if (!ensureAuthIfBackend()) return false;

    const sec = parseInt(delaySec, 10);
    try {
      await transport.publish(buildCommand({ type: 'timer', id, state: targetState, delaySec: sec }));

      if (timerIntervals.has(id)) {
        clearInterval(timerIntervals.get(id));
      }
      let remaining = sec;
      store.setState((prev) => ({ ...prev, timers: { ...prev.timers, [id]: remaining } }));

      const iv = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(iv);
          timerIntervals.delete(id);
          store.setState((prev) => {
            const nextTimers = { ...prev.timers };
            delete nextTimers[id];
            return { ...prev, timers: nextTimers };
          });
        } else {
          store.setState((prev) => ({ ...prev, timers: { ...prev.timers, [id]: remaining } }));
        }
      }, 1000);
      timerIntervals.set(id, iv);

      playConfirmBeep(true, config.voiceBeeps !== false);
      addLog(`⏰ مؤقت لمخرج ${id}: ${sec} ثانية`, 'info');
      onToast?.(`⏰ تم ضبط مؤقت لمخرج ${id}`, 'ok');
      return true;
    } catch (err) {
      playErrorBeep(config.voiceBeeps !== false);
      addLog(`❌ فشل ضبط المؤقت: ${err.message}`, 'bad');
      onToast?.(err.message, 'bad');
      return false;
    }
  }

  async function resetEnergy() {
    if (!requireOnlineDevice().ok) return false;
    if (!ensureAuthIfBackend()) return false;
    try {
      await transport.publish(buildCommand({ type: 'resetEnergy' }));
      addLog('🔄 تم تصفير عداد الطاقة التراكمية', 'warn');
      onToast?.('🔄 تم تصفير عداد الطاقة', 'ok');
      return true;
    } catch (err) {
      addLog(`❌ تعذر تصفير الطاقة: ${err.message}`, 'bad');
      onToast?.(err.message, 'bad');
      return false;
    }
  }

  async function requestSync() {
    if (!transport) return;
    if (transport.isBackend && !transport.getToken()) {
      try {
        const live = await transport.fetchLive();
        if (live?.device) handleTelemetryPayload(live.device, true);
        onToast?.('🔄 تم تحديث القراءات من السيرفر', 'ok');
      } catch (_) {}
      return;
    }
    try {
      await transport.publish(buildCommand({ type: 'sync' }));
      addLog('🔄 تم إرسال طلب مزامنة فورية للـ ESP32', 'info');
      onToast?.('🔄 تم طلب مزامنة الحالة', 'ok');
    } catch (err) {
      addLog(`❌ تعذر المزامنة: ${err.message}`, 'bad');
    }
  }

  async function switchDevice(newDeviceId) {
    const clean = String(newDeviceId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(clean)) {
      throw new Error('استخدم أحرف إنجليزية وأرقام و _ أو - فقط (1-64).');
    }

    if (transport?.isBackend) {
      if (!ensureAuthIfBackend()) return false;
      const res = await transport.switchDevice(clean);
      config.deviceId = res.deviceId;
      saveConfig(config);
      store.patch({ deviceId: res.deviceId, isOnline: false, connectionMode: 'offline', lastHeartbeatMs: 0 });
      addLog(`📡 تم التحويل إلى الجهاز: ${res.deviceId}`, 'ok');
      onToast?.(`📡 تم الربط مع ${res.deviceId}`, 'ok');
      return true;
    }

    config.deviceId = clean;
    config.mqtt.topicState = `electronova/${clean}/state`;
    config.mqtt.topicCmd = `electronova/${clean}/cmd`;
    config.mqtt.topicLwt = `electronova/${clean}/status`;
    saveConfig(config);
    connectTransport();
    onToast?.(`📡 تم التحويل إلى ${clean}`, 'ok');
    return true;
  }

  async function unlockSafety() {
    if (!requireOnlineDevice().ok) return;
    if (!transport?.isBackend) {
      onToast?.('انخفاض الحرارة تحت 60°C يفك القفل تلقائياً من الـ ESP32.', 'warn');
      return;
    }
    if (!ensureAuthIfBackend()) return;
    try {
      await transport.unlockSafety();
      addLog('🔓 تم فك قفل الأمان واللاتش يدوياً', 'ok');
      onToast?.('🔓 تم فك قفل الأمان بنجاح', 'ok');
    } catch (err) {
      onToast?.(err.message, 'bad');
      addLog(`🚫 تعذر فك القفل: ${err.message}`, 'bad');
    }
  }

  async function sequentialRestore() {
    if (!requireOnlineDevice().ok) return;
    if (!transport?.isBackend) return;
    if (!ensureAuthIfBackend()) return;
    try {
      await transport.sequentialRestore(3000);
      addLog('🔄 بدأ التشغيل المتسلسل للمخارج (كل 3 ثوانٍ)', 'ok');
      onToast?.('🔄 بدأ التشغيل المتسلسل التدريجي', 'ok');
    } catch (err) {
      onToast?.(err.message, 'bad');
      addLog(`❌ تعذر التشغيل المتسلسل: ${err.message}`, 'bad');
    }
  }

  /**
   * Smart AI Command Runner (replaces flaky continuous SpeechRecognition)
   * Calls Backend /api/voice/command (Gemini AI + Safety) or local parser in non-backend mode.
   */
  async function executeSmartCommand(rawText) {
    const clean = String(rawText || '').trim();
    if (!clean) return false;

    store.setState((prev) => ({
      ...prev,
      assistantBar: { busy: true, statusText: '⏳ جاري التحليل عبر الباك إند...', statusMode: 'working' }
    }));

    if (transport?.isBackend) {
      if (!ensureAuthIfBackend()) {
        store.setState((prev) => ({
          ...prev,
          assistantBar: { busy: false, statusText: '🔐 سجل الدخول أولاً لإرسال الأوامر الذكية', statusMode: 'bad' }
        }));
        return false;
      }

      try {
        const res = await transport.sendVoiceCommand(clean, /[\u0600-\u06FF]/.test(clean) ? 'ar' : 'en');
        playConfirmBeep(true, config.voiceBeeps !== false);
        const prefix = res.aiPowered ? '🤖 Gemini AI' : '⚡ الأمر الذكي';
        const reply = res.message || 'تم التنفيذ';
        store.setState((prev) => ({
          ...prev,
          assistantBar: { busy: false, statusText: `${prefix}: ${reply}`, statusMode: 'ok' }
        }));
        addLog(`${prefix}: "${clean}" ⬅ ${reply}`, 'ok');
        onToast?.(reply, 'ok');
        return true;
      } catch (err) {
        playErrorBeep(config.voiceBeeps !== false);
        store.setState((prev) => ({
          ...prev,
          assistantBar: { busy: false, statusText: `🚫 ${err.message}`, statusMode: 'bad' }
        }));
        addLog(`🚫 رفض الأمر الذكي: ${err.message}`, 'bad');
        onToast?.(err.message, 'bad');
        return false;
      }
    }

    // Local fallback when testing in Mock / MQTT direct mode
    const parsed = parseCommand(clean, { allowFuzzy: true });
    if (!parsed.actions.length) {
      playErrorBeep(config.voiceBeeps !== false);
      store.setState((prev) => ({
        ...prev,
        assistantBar: { busy: false, statusText: '❓ لم يتم فهم الأمر — جرّب: شغل الراوتر أو اطفي الكل', statusMode: 'bad' }
      }));
      return false;
    }

    let okCount = 0;
    let lastErr = '';
    for (const act of parsed.actions) {
      const r = act.type === 'all' ? await setAll(act.state, { silentToast: true }) : await setOutlet(act.id, act.state, { silentToast: true });
      if (r.ok) okCount++;
      else lastErr = r.reason || r.error || 'تعذر التنفيذ';
    }

    store.setState((prev) => ({
      ...prev,
      assistantBar: {
        busy: false,
        statusText: okCount > 0 ? `✅ تم تنفيذ "${clean}"` : `🚫 ${lastErr}`,
        statusMode: okCount > 0 ? 'ok' : 'bad'
      }
    }));
    return okCount > 0;
  }

  async function login(email, password) {
    if (!transport?.isBackend) throw new Error('تسجيل الدخول متاح في وضع Backend فقط.');
    const res = await transport.login(email, password);
    transport.setToken(res.token);
    store.patch({ user: res.user, token: res.token });
    addLog(`✅ تم تسجيل الدخول: ${res.user.name}`, 'ok');
    onToast?.(`مرحباً بك، ${res.user.name}`, 'ok');
    loadBackendLogsAndAnalytics();
    return res;
  }

  async function register(name, email, password) {
    if (!transport?.isBackend) throw new Error('إنشاء الحساب متاح في وضع Backend فقط.');
    const res = await transport.register(name, email, password);
    transport.setToken(res.token);
    store.patch({ user: res.user, token: res.token });
    addLog(`✅ تم إنشاء الحساب: ${res.user.name}`, 'ok');
    onToast?.('تم إنشاء الحساب بنجاح', 'ok');
    loadBackendLogsAndAnalytics();
    return res;
  }

  function logout() {
    if (transport?.setToken) transport.setToken(null);
    store.patch({ user: null, token: null });
    addLog('🔒 تم تسجيل الخروج', 'info');
    onToast?.('🔒 تم تسجيل الخروج', 'info');
  }

  function clearLogs() {
    store.patch({ logs: [] });
  }

  function refreshAnalytics() {
    if (transport?.isBackend && transport.getToken()) {
      loadBackendLogsAndAnalytics();
    }
  }

  function updateConfigAndReconnect(nextCfg) {
    config = {
      ...config,
      ...nextCfg,
      mqtt: { ...config.mqtt, ...(nextCfg.mqtt || {}) },
      ws: { ...config.ws, ...(nextCfg.ws || {}) }
    };
    saveConfig(config);
    connectTransport();
  }

  function resetToDefaults() {
    config = resetConfig();
    connectTransport();
  }

  function setVoiceConfig(partialVoice) {
    config = { ...config, ...partialVoice };
    saveConfig(config);
  }

  function start() {
    applyTheme(config.theme);
    connectTransport();

    clearInterval(watchdogTimer);
    watchdogTimer = setInterval(() => {
      const st = store.getState();
      if (st.isOnline && st.lastHeartbeatMs > 0 && Date.now() - st.lastHeartbeatMs > 20000) {
        store.patch({ isOnline: false, connectionMode: 'offline' });
        addLog('⚠️ انتهى نبض الـ ESP32 (> 20 ثانية)', 'warn');
      }
    }, 2000);

    clearInterval(clockTimer);
    clockTimer = setInterval(() => {
      const st = store.getState();
      if (!st.isOnline || st.espTime === '--:--:--') {
        store.patch({ espTime: cairoTimeNow() });
      }
    }, 1000);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && transport?.isConnected()) {
        requestSync();
      }
    });
  }

  return {
    start,
    getConfig: () => config,
    applyTheme,
    toggleTheme,
    reconnect: connectTransport,
    updateConfigAndReconnect,
    resetToDefaults,
    setVoiceConfig,
    setOutlet,
    setAll,
    updateOutletMeta,
    setSchedule,
    setTimer,
    resetEnergy,
    requestSync,
    switchDevice,
    unlockSafety,
    sequentialRestore,
    executeSmartCommand,
    login,
    register,
    logout,
    clearLogs,
    refreshAnalytics,
    addLog
  };
}
