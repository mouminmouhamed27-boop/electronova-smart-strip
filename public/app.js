/**
 * ElectroNova Smart Power Strip — Frontend Application Controller
 * Unified with Express REST API + WebSocket + EMQX Cloud Contract (v4.2)
 */

const CONFIG = {
  apiBase: '/api',
  wsUrl: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/telemetry`
};

const OUTLET_META = [
  { id: 1, sub: "أولوية قصوى: راوتر / جهاز أساسي", badge: "P1 Top", badgeCls: "bg-emerald-950/80 text-emerald-400 border-emerald-800" },
  { id: 2, sub: "محطة عمل / كمبيوتر", badge: "P2 High", badgeCls: "bg-blue-950/80 text-blue-400 border-blue-800" },
  { id: 3, sub: "إضاءة المعمل / طرفيات", badge: "P3 Med", badgeCls: "bg-yellow-950/80 text-yellow-400 border-yellow-800" },
  { id: 4, sub: "أحمال غير حرجة / شواحن", badge: "P4 Low", badgeCls: "bg-rose-950/80 text-rose-400 border-rose-800" }
];

let state = {
  token: localStorage.getItem('electronova_token') || null,
  user: null,
  deviceId: 'EN_SIM1',
  isOnline: false,
  outlets: [
    { id: 1, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.0 },
    { id: 2, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.0 },
    { id: 3, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.0 },
    { id: 4, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.0 }
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
  wsConnected: false,
  lastTelemetryAt: 0
};

let ws = null;
let wsReconnectTimer = null;
let powerChart = null;
let audioCtx = null;

// Speech Recognition & Voice Variables
let recognition = null;
let isVoiceActive = false;
let voiceLang = localStorage.getItem('electronova_voice_lang') || 'ar-EG';
let voiceRestartTimer = null;
let lastVoiceTranscript = '';
let lastVoiceAt = 0;

// ─── 1. INITIALIZATION ────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  renderOutletCards();
  initChart();
  checkAuth();
  connectWebSocket();
  initVoiceEngine();
  startWatchdogs();
});

// ─── 2. AUTHENTICATION HELPERS ────────────────────────────────────────────────
async function apiRequest(endpoint, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${CONFIG.apiBase}${endpoint}`, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || `HTTP Error ${res.status}`);
  }
  return data;
}

async function checkAuth() {
  if (!state.token) {
    updateAuthUI(false);
    return;
  }
  try {
    const data = await apiRequest('/auth/me');
    state.user = data.user;
    updateAuthUI(true);
    logMsg(`👤 مرحباً بك، ${state.user.name}`);
  } catch (err) {
    console.warn('Auth token expired or invalid:', err.message);
    logout();
  }
}

function updateAuthUI(isLoggedIn) {
  const btnAuth = document.getElementById('btnAuth');
  const userBadge = document.getElementById('userBadge');
  const userName = document.getElementById('userName');

  if (isLoggedIn && state.user) {
    userBadge.classList.remove('hidden');
    userBadge.classList.add('flex');
    userName.textContent = state.user.name;
    btnAuth.innerHTML = '<i class="fa-solid fa-arrow-right-from-bracket"></i> <span>خروج</span>';
    btnAuth.onclick = logout;
  } else {
    userBadge.classList.add('hidden');
    userBadge.classList.remove('flex');
    btnAuth.innerHTML = '<i class="fa-solid fa-user-lock"></i> <span>تسجيل دخول</span>';
    btnAuth.onclick = openAuthModal;
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errorBox = document.getElementById('authError');
  errorBox.classList.add('hidden');

  try {
    const data = await apiRequest('/auth/login', 'POST', { email, password });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('electronova_token', data.token);
    updateAuthUI(true);
    closeAuthModal();
    logMsg(`✅ تم تسجيل الدخول بنجاح: ${state.user.name}`);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.remove('hidden');
  }
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('electronova_token');
  updateAuthUI(false);
  logMsg('🔒 تم تسجيل الخروج');
}

// ─── 3. WEBSOCKET REAL-TIME CONNECTION ────────────────────────────────────────
function connectWebSocket() {
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }

  updateConnBadge('connecting', 'السحابة: اتصال...');

  try {
    ws = new WebSocket(CONFIG.wsUrl);

    ws.onopen = () => {
      state.wsConnected = true;
      updateConnBadge('connected', 'السحابة: متصل');
      logMsg('⚡ متصل بالبث الحي (WebSocket Active)');
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init' || msg.type === 'telemetry_update') {
          if (msg.data?.isOnline) {
            state.lastTelemetryAt = Date.now();
          }
          processTelemetry(msg.data);
        }
      } catch (e) {
        console.error('WS Parse Error:', e);
      }
    };

    ws.onclose = () => {
      state.wsConnected = false;
      updateConnBadge('disconnected', 'السحابة: منقطع');
      scheduleWsReconnect();
    };

    ws.onerror = () => {
      state.wsConnected = false;
      updateConnBadge('disconnected', 'السحابة: خطأ');
    };
  } catch (err) {
    scheduleWsReconnect();
  }
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectWebSocket, 3000);
}

// ─── 4. TELEMETRY PROCESSING & DASHBOARD UI ───────────────────────────────────
function processTelemetry(device) {
  if (!device) return;

  if (device.id) {
    state.deviceId = device.id;
    const idEl = document.getElementById('activeDeviceId');
    if (idEl) idEl.textContent = device.id;
  }

  if (device.isOnline !== undefined) {
    state.isOnline = Boolean(device.isOnline);
    if (state.isOnline && device.lastHeartbeat) {
      state.lastTelemetryAt = new Date(device.lastHeartbeat).getTime() || Date.now();
    }
    updateEspHeartbeatUI();
  }

  // 1. Safety metrics
  if (device.safety) {
    state.safety = device.safety;
    const s = device.safety;

    // Temperature
    const tempNum = parseFloat(s.temperatureC ?? 25);
    document.getElementById('valTemp').textContent = tempNum.toFixed(1);
    const barTemp = document.getElementById('barTemp');
    barTemp.style.width = Math.min(100, Math.max(0, (tempNum / 65) * 100)) + '%';
    barTemp.className = tempNum > 60 ? 'bg-rose-500 h-full transition-all duration-300' :
                        tempNum > 45 ? 'bg-amber-500 h-full transition-all duration-300' :
                        'bg-emerald-500 h-full transition-all duration-300';

    // Total Current Amps (with 80% continuous safe limit 12.8A)
    const ampsNum = parseFloat(s.totalAmps ?? 0);
    const valAmpsEl = document.getElementById('valAmps');
    valAmpsEl.textContent = ampsNum.toFixed(1);
    valAmpsEl.className = `text-2xl sm:text-3xl font-black font-mono-num ${
      ampsNum > 15.5 ? 'text-rose-400' : ampsNum >= 12.8 ? 'text-amber-400' : 'text-cyan-400'
    }`;
    const barAmps = document.getElementById('barAmps');
    barAmps.style.width = Math.min(100, (ampsNum / 16) * 100) + '%';
    barAmps.className = ampsNum > 15.5 ? 'bg-rose-500 h-full transition-all duration-300' :
                        ampsNum >= 12.8 ? 'bg-amber-500 h-full transition-all duration-300' :
                        'bg-cyan-500 h-full transition-all duration-300';

    // Total Watts & Voltage
    const wattsVal = Math.round(s.totalWatts || 0);
    document.getElementById('valWatts').textContent = wattsVal;
    updateChart(wattsVal);

    const voltsNum = parseFloat(s.volts ?? 220);
    const voltsEl = document.getElementById('valVolts');
    if (voltsEl) {
      voltsEl.textContent = `${voltsNum.toFixed(1)}V AC`;
      voltsEl.className = `ltr font-mono-num ${(voltsNum < 190 || voltsNum > 250) ? 'text-rose-400 font-bold' : 'text-cyan-400'}`;
    }

    // Cumulative Energy & Cost
    document.getElementById('valKwh').textContent = parseFloat(s.totalKwh || 0).toFixed(3);
    document.getElementById('valCost').textContent = parseFloat(s.costEgp || 0).toFixed(2);

    // Alert Banner (Handles OVERHEAT / OVERHEAT_SHUTDOWN & OVERLOAD / LOAD_SHEDDING)
    handleAlertBanner(s.alert, s.isVoltageFault, voltsNum);
  }

  // 2. Outlets state
  if (Array.isArray(device.outlets)) {
    device.outlets.forEach((o) => {
      const idx = o.id - 1;
      if (state.outlets[idx]) {
        state.outlets[idx] = { ...state.outlets[idx], ...o };
        updateOutletCardUI(o.id, o.state, o.currentAmps, o.currentWatts, o.totalKwh);
      }
    });
  }

  // 3. Schedules
  if (Array.isArray(device.schedules)) {
    device.schedules.forEach((sch) => {
      const enEl = document.getElementById(`schEn${sch.outletId}`);
      const onEl = document.getElementById(`schOn${sch.outletId}`);
      const offEl = document.getElementById(`schOff${sch.outletId}`);
      const badge = document.getElementById(`schBadge${sch.outletId}`);
      if (enEl && onEl && offEl && badge && document.activeElement !== onEl && document.activeElement !== offEl) {
        enEl.checked = Boolean(sch.enabled);
        if (sch.onTime) onEl.value = sch.onTime;
        if (sch.offTime) offEl.value = sch.offTime;
        badge.textContent = sch.enabled ? `${sch.onTime}–${sch.offTime} ▾` : 'معطّل ▾';
        badge.className = sch.enabled ? 'ltr text-[10px] text-emerald-400 font-mono-num' : 'text-[10px] text-gray-500';
      }
    });
  }

  updateSafetyGuardUI();
}

function handleAlertBanner(alertCode, isVoltageFault = false, voltsNum = 220) {
  const banner = document.getElementById('alertBanner');
  const msgEl = document.getElementById('alertMsg');

  if (alertCode && alertCode !== 'OK') {
    banner.classList.remove('hidden');
    if (alertCode === 'OVERHEAT' || alertCode === 'OVERHEAT_SHUTDOWN') {
      msgEl.textContent = '🚨 قفل حماية الحرارة (> 65°C): تم فصل المخارج وقفل التشغيل حتى تنخفض الحرارة دون 60°C.';
    } else if (alertCode === 'OVERLOAD' || alertCode.startsWith('LOAD_SHEDDING')) {
      msgEl.textContent = `⚡ زيادة حمل (> 16A): تم تخفيف الأحمال تلقائياً لحماية المشترك (${alertCode}).`;
    } else {
      msgEl.textContent = `تنبيه أمان: ${alertCode}`;
    }
  } else if (isVoltageFault) {
    banner.classList.remove('hidden');
    msgEl.textContent = `⚠️ تحذير جهد غير مستقر (${voltsNum.toFixed(1)}V AC): خارج النطاق الآمن 190V–250V!`;
  } else {
    banner.classList.add('hidden');
  }
}

function updateSafetyGuardUI() {
  const isOverheat = state.safety.isOverheatLocked;
  const isOverload = state.safety.isOverloadBlocked;
  const btnAllOn = document.getElementById('btnAllOn');
  const labelAllOn = document.getElementById('labelAllOn');
  const iconAllOn = document.getElementById('iconAllOn');

  if (isOverheat) {
    btnAllOn.className = 'flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 rounded-xl bg-gray-800 border border-rose-600/70 text-rose-300 font-bold text-xs cursor-not-allowed opacity-80';
    iconAllOn.className = 'fa-solid fa-lock';
    labelAllOn.textContent = 'محظور (حرارة عالية)';
  } else if (isOverload) {
    btnAllOn.className = 'flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 rounded-xl bg-gray-800 border border-amber-500/70 text-amber-300 font-bold text-xs cursor-not-allowed opacity-80';
    iconAllOn.className = 'fa-solid fa-bolt';
    labelAllOn.textContent = 'محظور (حمل > 16A)';
  } else {
    btnAllOn.className = 'flex items-center justify-center gap-2 px-3 sm:px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg shadow-emerald-600/25 transition active:scale-95';
    iconAllOn.className = 'fa-solid fa-power-off';
    labelAllOn.textContent = 'تشغيل الكل';
  }
}

// ─── 5. RENDER OUTLET CARDS ───────────────────────────────────────────────────
function renderOutletCards() {
  const container = document.getElementById('outletsContainer');
  container.innerHTML = OUTLET_META.map(m => `
    <div id="cardOutlet${m.id}" class="glass-card rounded-2xl p-4 border border-transparent transition-all duration-200 flex flex-col gap-3 min-w-0">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-gray-600 shrink-0" id="dotOutlet${m.id}"></span>
            <h3 class="font-bold text-white text-sm">مخرج ${m.id}</h3>
            <span class="ltr text-[10px] text-gray-500 font-mono-num">OUT-${m.id}</span>
          </div>
          <p class="text-[11px] text-gray-400 mt-0.5 truncate">${m.sub}</p>
        </div>
        <span class="ltr text-[10px] border px-2 py-0.5 rounded font-mono-num shrink-0 ${m.badgeCls}">${m.badge}</span>
      </div>

      <div class="grid grid-cols-3 gap-1 bg-gray-900/80 rounded-xl p-2 border border-gray-800/80 text-center">
        <div>
          <div class="text-[10px] text-gray-400">تيار</div>
          <div id="ampsOutlet${m.id}" class="ltr font-mono-num text-xs font-bold text-cyan-400 mt-0.5">0.0 A</div>
        </div>
        <div class="border-x border-gray-800">
          <div class="text-[10px] text-gray-400">قدرة</div>
          <div id="wattsOutlet${m.id}" class="ltr font-mono-num text-xs font-bold text-emerald-400 mt-0.5">0 W</div>
        </div>
        <div>
          <div class="text-[10px] text-gray-400">طاقة</div>
          <div id="kwhOutlet${m.id}" class="ltr font-mono-num text-[11px] font-bold text-yellow-400 mt-0.5">0.000</div>
        </div>
      </div>

      <div class="flex items-center justify-between py-2 border-y border-gray-800/80">
        <span class="text-xs font-bold text-gray-400" id="labelOutlet${m.id}">مغلق (OFF)</span>
        <button id="toggleBtn${m.id}" onclick="toggleOutlet(${m.id})" dir="ltr" role="switch" aria-checked="false" aria-label="تبديل مخرج ${m.id}"
          class="h-7 rounded-full bg-gray-700 p-1 flex items-center justify-start transition duration-150 focus:outline-none" style="width:3.25rem;">
          <div id="toggleBall${m.id}" class="w-5 h-5 rounded-full bg-gray-300 shadow-md"></div>
        </button>
      </div>

      <details class="group">
        <summary class="flex items-center justify-between text-xs text-cyan-300 cursor-pointer select-none py-1 hover:text-cyan-200">
          <span><i class="fa-regular fa-clock ml-1.5"></i>الجدولة والمؤقت</span>
          <span id="schBadge${m.id}" class="text-[10px] text-gray-500">معطّل ▾</span>
        </summary>

        <div class="mt-2.5 space-y-3 pt-2.5 border-t border-gray-800/80">
          <div class="space-y-2">
            <div class="flex items-center justify-between text-[11px]">
              <span class="text-gray-300 font-semibold">جدولة يومية (NTP)</span>
              <label class="flex items-center gap-1.5 cursor-pointer text-gray-400">
                <input type="checkbox" id="schEn${m.id}" class="accent-cyan-500 w-3.5 h-3.5">
                <span>تفعيل</span>
              </label>
            </div>
            <div class="grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span class="text-gray-500 block mb-0.5">تشغيل</span>
                <input type="time" id="schOn${m.id}" value="08:00"
                  class="ltr w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-white font-mono-num">
              </div>
              <div>
                <span class="text-gray-500 block mb-0.5">فصل</span>
                <input type="time" id="schOff${m.id}" value="23:00"
                  class="ltr w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-white font-mono-num">
              </div>
            </div>
            <button onclick="saveSchedule(${m.id})"
              class="w-full py-1.5 rounded-lg bg-indigo-900/70 hover:bg-indigo-800 border border-indigo-700 text-indigo-200 text-[11px] font-bold transition">
              حفظ الجدول
            </button>
          </div>

          <div class="pt-2 border-t border-gray-800/70">
            <div class="flex items-center justify-between text-[11px] text-gray-400 mb-1.5">
              <span>مؤقت سريع:</span>
              <span id="timerLabel${m.id}" class="text-cyan-400">معطّل</span>
            </div>
            <div class="flex items-center gap-2">
              <select id="timerSec${m.id}" class="bg-gray-900 border border-gray-700 text-[11px] rounded-lg px-2 py-1.5 text-gray-300 flex-1 min-w-0">
                <option value="10">10 ثواني</option>
                <option value="60">1 دقيقة</option>
                <option value="300">5 دقائق</option>
                <option value="1800">30 دقيقة</option>
                <option value="3600">1 ساعة</option>
              </select>
              <button onclick="setOutletTimer(${m.id})" class="px-3 py-1.5 rounded-lg bg-cyan-900/80 hover:bg-cyan-800 border border-cyan-700 text-cyan-300 text-[11px] font-bold transition shrink-0">
                ضبط
              </button>
            </div>
          </div>
        </div>
      </details>
    </div>
  `).join('');
}

function updateOutletCardUI(id, stateBool, amps = 0, watts = 0, kwh = 0) {
  const card = document.getElementById(`cardOutlet${id}`);
  const dot = document.getElementById(`dotOutlet${id}`);
  const label = document.getElementById(`labelOutlet${id}`);
  const btn = document.getElementById(`toggleBtn${id}`);
  const ball = document.getElementById(`toggleBall${id}`);
  const ampsEl = document.getElementById(`ampsOutlet${id}`);

  const ampsFloat = parseFloat(amps || 0);
  ampsEl.textContent = `${ampsFloat.toFixed(1)} A`;
  ampsEl.className = `ltr font-mono-num text-xs font-bold mt-0.5 ${ampsFloat > 7.0 ? 'text-amber-400' : 'text-cyan-400'}`;
  document.getElementById(`wattsOutlet${id}`).textContent = `${Math.round(watts || 0)} W`;
  document.getElementById(`kwhOutlet${id}`).textContent = parseFloat(kwh || 0).toFixed(3);
  btn.setAttribute('aria-checked', stateBool ? 'true' : 'false');

  if (stateBool) {
    card.className = 'glass-card rounded-2xl p-4 border border-emerald-500/50 neon-green transition-all duration-200 flex flex-col gap-3 min-w-0';
    dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 shadow-md shadow-emerald-400/50 shrink-0';
    label.textContent = 'يعمل (ON)';
    label.className = 'text-xs font-bold text-emerald-400';
    btn.className = 'h-7 rounded-full bg-emerald-500 p-1 flex items-center justify-end transition duration-150 focus:outline-none';
    ball.className = 'w-5 h-5 rounded-full bg-white shadow-md';
  } else if (state.safety.isOverheatLocked) {
    card.className = 'glass-card rounded-2xl p-4 border border-rose-700/60 transition-all duration-200 flex flex-col gap-3 min-w-0';
    dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500 shrink-0';
    label.textContent = '🔒 محظور (حرارة)';
    label.className = 'text-xs font-bold text-rose-400';
    btn.className = 'h-7 rounded-full bg-rose-950/80 border border-rose-700/60 p-1 flex items-center justify-start cursor-not-allowed opacity-75';
    ball.className = 'w-5 h-5 rounded-full bg-rose-300 shadow-md';
  } else {
    card.className = 'glass-card rounded-2xl p-4 border border-transparent transition-all duration-200 flex flex-col gap-3 min-w-0';
    dot.className = 'w-2.5 h-2.5 rounded-full bg-gray-600 shrink-0';
    label.textContent = 'مغلق (OFF)';
    label.className = 'text-xs font-bold text-gray-400';
    btn.className = 'h-7 rounded-full bg-gray-700 p-1 flex items-center justify-start transition duration-150 focus:outline-none';
    ball.className = 'w-5 h-5 rounded-full bg-gray-300 shadow-md';
  }
}

// ─── 6. OUTLET & DEVICE COMMANDS VIA REST API ─────────────────────────────────
async function toggleOutlet(id) {
  const current = state.outlets[id - 1]?.state || false;
  const target = !current;

  if (target && state.safety.isOverheatLocked) {
    playErrorBeep();
    flashLockWarning(document.getElementById(`cardOutlet${id}`));
    logMsg(`🚫 مرفوض: حماية الحرارة مفعّلة (> 65°C)!`);
    return;
  }

  try {
    await apiRequest(`/outlets/${id}`, 'POST', { state: target });
    playConfirmBeep(target);
    logMsg(`🌐 مخرج ${id} ⬅ ${target ? 'ON' : 'OFF'}`);
  } catch (err) {
    playErrorBeep();
    logMsg(`❌ خطأ: ${err.message}`);
    if (err.message.includes('Access denied') || err.message.includes('Token')) openAuthModal();
  }
}

async function sendMasterCommand(targetState) {
  if (targetState && state.safety.isOverheatLocked) {
    playErrorBeep();
    flashLockWarning(document.getElementById('btnAllOn'));
    logMsg(`🚫 مرفوض: حماية الحرارة مفعّلة!`);
    return;
  }

  try {
    await apiRequest('/outlets/all', 'POST', { state: targetState });
    playConfirmBeep(targetState);
    logMsg(`🌐 ${targetState ? 'تشغيل الكل' : 'فصل الكل'}`);
  } catch (err) {
    playErrorBeep();
    logMsg(`❌ خطأ: ${err.message}`);
    if (err.message.includes('Access denied') || err.message.includes('Token')) openAuthModal();
  }
}

async function saveSchedule(id) {
  const enabled = document.getElementById(`schEn${id}`).checked;
  const onTime = document.getElementById(`schOn${id}`).value || '08:00';
  const offTime = document.getElementById(`schOff${id}`).value || '23:00';

  try {
    await apiRequest(`/schedules/${id}`, 'POST', { enabled, onTime, offTime });
    logMsg(`📅 تم حفظ جدول مخرج ${id}: (${onTime}–${offTime})`);
  } catch (err) {
    logMsg(`❌ فشل حفظ الجدول: ${err.message}`);
    if (err.message.includes('Access denied')) openAuthModal();
  }
}

async function setOutletTimer(id) {
  const sec = parseInt(document.getElementById(`timerSec${id}`).value, 10);
  try {
    await apiRequest(`/outlets/${id}/timer`, 'POST', { delaySec: sec });
    const label = document.getElementById(`timerLabel${id}`);
    label.textContent = `عكس بعد ${sec}ث`;
    setTimeout(() => { label.textContent = 'معطّل'; }, sec * 1000);
    logMsg(`⏰ تم ضبط مؤقت لمخرج ${id}: ${sec} ثانية`);
  } catch (err) {
    logMsg(`❌ فشل ضبط المؤقت: ${err.message}`);
    if (err.message.includes('Access denied')) openAuthModal();
  }
}

async function resetEnergy() {
  if (!confirm('تصفير عداد الطاقة التراكمية (kWh) في المشترك والسيرفر؟')) return;
  try {
    await apiRequest('/telemetry/energy/reset', 'POST');
    logMsg('🔄 تم تصفير عداد الطاقة');
  } catch (err) {
    logMsg(`❌ خطأ: ${err.message}`);
    if (err.message.includes('Access denied')) openAuthModal();
  }
}

async function requestSync() {
  try {
    const res = await apiRequest('/telemetry/sync', 'POST');
    logMsg(`🔄 ${res.message}`);
  } catch (err) {
    if (err.message.includes('Access denied')) openAuthModal();
    else logMsg(`❌ تعذر المزامنة: ${err.message}`);
  }
}

async function promptSwitchDevice() {
  const newId = prompt('أدخل Device ID المطلوب الربط معه (مثلاً EN_SIM1 للمحاكاة أو EN_XXXX للهاردوير):', state.deviceId);
  if (!newId || !newId.trim()) return;
  try {
    const res = await apiRequest('/telemetry/device', 'POST', { deviceId: newId.trim() });
    state.deviceId = res.deviceId;
    document.getElementById('activeDeviceId').textContent = res.deviceId;
    logMsg(`📡 تم التحويل إلى الجهاز: ${res.deviceId}`);
  } catch (err) {
    if (err.message.includes('Access denied')) openAuthModal();
    else logMsg(`❌ خطأ: ${err.message}`);
  }
}

async function triggerSequentialRestore() {
  try {
    await apiRequest('/safety/sequential-restore', 'POST', { delayMs: 3000 });
    logMsg('🔄 بدأ التشغيل المتسلسل التدريجي لمنع القفلة (3 ثوانٍ)');
  } catch (err) {
    logMsg(`❌ خطأ: ${err.message}`);
  }
}

async function triggerSafetyUnlock() {
  try {
    await apiRequest('/safety/unlock', 'POST');
    logMsg('✅ تم فك قفل الأمان يدوياً');
  } catch (err) {
    logMsg(`🚫 تعذر فك القفل: ${err.message}`);
  }
}

// ─── 7. CONTINUOUS VOICE ENGINE (ARABIC + ENGLISH, ZERO-LAG) ──────────────────
function initVoiceEngine() {
  updateVoiceLangBtn();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const btn = document.getElementById('btnVoice');
    btn.disabled = true;
    document.getElementById('voiceStatus').textContent = 'المتصفح لا يدعم المايك';
    setVoicePill('استخدم Chrome / Edge لتفعيل الصوت', 'error');
    return;
  }

  recognition = new SR();
  recognition.lang = voiceLang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  recognition.onstart = () => {
    isVoiceActive = true;
    updateVoiceUI(true);
    setVoicePill(
      voiceLang.startsWith('ar')
        ? '🎙️ المايك يستمع (عربي)... قل: "شغل الراوتر" أو "افصل الكل"'
        : '🎙️ Listening (EN)... say: "turn on 1" or "all off"',
      'hearing'
    );
  };

  recognition.onresult = async (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const transcript = (res[0]?.transcript || '').trim();
      if (!transcript) continue;

      setVoicePill(`🗣️ "${transcript}"`, 'hearing');

      // Execute immediately on final, or debounce duplicate triggers within 800ms
      if (res.isFinal) {
        const now = Date.now();
        if (transcript === lastVoiceTranscript && now - lastVoiceAt < 800) continue;
        lastVoiceTranscript = transcript;
        lastVoiceAt = now;
        await sendVoiceCommandToBackend(transcript);
      }
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      isVoiceActive = false;
      updateVoiceUI(false);
      setVoicePill('❌ تم حظر المايك! اسمح به في إعدادات المتصفح', 'error');
    }
  };

  recognition.onend = () => {
    if (isVoiceActive) {
      if (voiceRestartTimer) clearTimeout(voiceRestartTimer);
      voiceRestartTimer = setTimeout(() => {
        if (isVoiceActive) {
          try { recognition.start(); } catch (e) {}
        }
      }, 120);
    } else {
      updateVoiceUI(false);
    }
  };
}

function toggleVoiceLang() {
  voiceLang = voiceLang.startsWith('ar') ? 'en-US' : 'ar-EG';
  localStorage.setItem('electronova_voice_lang', voiceLang);
  updateVoiceLangBtn();
  if (recognition) {
    recognition.lang = voiceLang;
    if (isVoiceActive) {
      try { recognition.stop(); } catch (e) {}
    }
  }
}

function updateVoiceLangBtn() {
  const btn = document.getElementById('btnVoiceLang');
  if (btn) btn.textContent = voiceLang.startsWith('ar') ? 'عربي' : 'EN';
}

function toggleVoice() {
  initAudio();
  if (!recognition) return;

  if (isVoiceActive) {
    isVoiceActive = false;
    if (voiceRestartTimer) clearTimeout(voiceRestartTimer);
    try { recognition.stop(); } catch (e) {}
    updateVoiceUI(false);
    setVoicePill('تم إيقاف الاستماع. اضغط للتشغيل مجدداً', 'idle');
    logMsg('🔇 تم إغلاق المايك يدوياً');
  } else {
    if (!state.token) {
      openAuthModal();
      logMsg('⚠️ سجل دخولك أولاً لتفعيل إرسال الأوامر الصوتية للباك إند');
      return;
    }
    isVoiceActive = true;
    try { recognition.start(); } catch (e) {}
    logMsg(`🎤 المايك مفتوح للاستماع (${voiceLang})`);
  }
}

async function sendVoiceCommandToBackend(transcript) {
  try {
    const langCode = voiceLang.startsWith('ar') ? 'ar' : 'en';
    const data = await apiRequest('/voice/command', 'POST', { transcript, language: langCode });
    playConfirmBeep(data.command?.state !== false);
    setVoicePill(`⚡ "${transcript}" ⬅ ${data.message}`, 'success');
    logMsg(`🎤 أمر صوتي: "${transcript}" ⬅ ${data.message}`);
    speakText(data.feedbackSpeech || data.message);
  } catch (err) {
    playErrorBeep();
    setVoicePill(`🚫 "${transcript}" ⬅ ${err.message}`, 'error');
    logMsg(`⚠️ أمر صوتي مرفوض: ${err.message}`);
    if (err.message.includes('Access denied')) openAuthModal();
  }
}

function speakText(text) {
  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = /[\u0600-\u06FF]/.test(text) ? 'ar-EG' : 'en-US';
      utterance.rate = 1.05;
      window.speechSynthesis.speak(utterance);
    }
  } catch (e) {}
}

function updateVoiceUI(active) {
  const btn = document.getElementById('btnVoice');
  const icon = document.getElementById('voiceIcon');
  const status = document.getElementById('voiceStatus');

  if (active) {
    btn.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl bg-rose-600/90 hover:bg-rose-500 border border-rose-400 text-white text-xs font-bold transition active:scale-95 mic-live-glow';
    icon.className = 'fa-solid fa-stop-circle text-sm animate-pulse';
    status.textContent = 'المايك يعمل • اضغط للإيقاف';
  } else {
    btn.className = 'flex-1 sm:flex-initial flex items-center justify-center gap-2.5 px-4 py-2.5 rounded-xl bg-cyan-950/70 hover:bg-cyan-900/80 border border-cyan-600/70 text-cyan-200 text-xs font-bold transition active:scale-95';
    icon.className = 'fa-solid fa-microphone text-sm';
    status.textContent = 'تشغيل الأوامر الصوتية';
  }
}

function setVoicePill(text, mode = 'idle') {
  const box = document.getElementById('voiceFeedback');
  box.textContent = text;
  const styles = {
    idle: 'bg-gray-950/90 border-gray-800 text-gray-400',
    hearing: 'bg-cyan-950/80 border-cyan-600/70 text-cyan-200 font-bold',
    success: 'bg-emerald-950/80 border-emerald-500/70 text-emerald-300 font-bold',
    error: 'bg-rose-950/80 border-rose-600/70 text-rose-300 font-bold'
  };
  box.className = `text-[11px] px-3 py-2 rounded-xl border truncate max-w-full sm:max-w-md ${styles[mode] || styles.idle}`;
}

// ─── 8. LIVE CHART & AUDIO FEEDBACK ───────────────────────────────────────────
function initChart() {
  const ctx = document.getElementById('powerChart').getContext('2d');
  powerChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'القدرة (W)',
        data: [],
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.12)',
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        pointBackgroundColor: '#10b981',
        pointRadius: 2.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af', font: { family: 'Orbitron', size: 10 } } },
        x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 6, font: { family: 'Orbitron', size: 10 } } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

function updateChart(watts) {
  if (!powerChart) return;
  const timeStr = new Date().toTimeString().slice(0, 8);
  powerChart.data.labels.push(timeStr);
  powerChart.data.datasets[0].data.push(watts);
  if (powerChart.data.labels.length > 18) {
    powerChart.data.labels.shift();
    powerChart.data.datasets[0].data.shift();
  }
  powerChart.update('none');
}

function initAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}

function playConfirmBeep(isOn) {
  try {
    initAudio();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isOn ? 880 : 440, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (e) {}
}

function playErrorBeep() {
  try {
    initAudio();
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(190, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.23);
  } catch (e) {}
}

// ─── 9. ENERGY ANALYTICS MODAL (XSS-SAFE DOM BUILDING) ────────────────────────
async function openAnalyticsModal() {
  try {
    const res = await apiRequest('/analytics/energy');
    const d = res.data;

    document.getElementById('anPeakWatts').textContent = `${d.metrics.peakWattsRecorded} W`;
    document.getElementById('anAvgWatts').textContent = `${d.metrics.averageWatts} W`;
    document.getElementById('anProjKwh').textContent = `${d.metrics.projectedMonthlyKwh} kWh`;
    document.getElementById('anProjCost').textContent = `${d.metrics.projectedMonthlyCostEgp} ج.م`;

    const tbody = document.getElementById('anTableBody');
    tbody.innerHTML = '';
    d.outlets.forEach(o => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-gray-800 text-[11px]';

      const cells = [
        { text: `${o.name} (مخرج ${o.id})`, cls: 'py-2 font-bold text-white' },
        { text: `${o.currentWatts} W`, cls: 'py-2 font-mono-num text-cyan-400' },
        { text: o.totalKwh.toFixed(3), cls: 'py-2 font-mono-num text-emerald-400' },
        { text: `${o.costEgp.toFixed(2)} ج.م`, cls: 'py-2 font-mono-num text-yellow-400' },
        { text: `${o.sharePercentage}%`, cls: 'py-2 font-mono-num text-gray-400' }
      ];

      cells.forEach(c => {
        const td = document.createElement('td');
        td.className = c.cls;
        td.textContent = c.text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    document.getElementById('analyticsModal').classList.remove('hidden');
  } catch (err) {
    logMsg(`❌ تعذر جلب التحليلات: ${err.message}`);
    if (err.message.includes('Access denied')) openAuthModal();
  }
}

function closeAnalyticsModal() {
  document.getElementById('analyticsModal').classList.add('hidden');
}

// ─── 10. UI HELPERS & WATCHDOG ────────────────────────────────────────────────
function updateConnBadge(status, text) {
  const badge = document.getElementById('connBadge');
  const dot = document.getElementById('connDot');
  document.getElementById('connText').textContent = text;
  const styles = {
    connected: ['bg-emerald-950/60 border-emerald-700/50 text-emerald-400', 'bg-emerald-400 animate-pulse'],
    connecting: ['bg-yellow-950/60 border-yellow-700/50 text-yellow-400', 'bg-yellow-400 animate-ping'],
    disconnected: ['bg-rose-950/60 border-rose-700/50 text-rose-400', 'bg-rose-500']
  }[status] || ['bg-gray-800 border-gray-700 text-gray-400', 'bg-gray-500'];

  badge.className = `flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] sm:text-xs font-semibold ${styles[0]}`;
  dot.className = `w-2 h-2 rounded-full ${styles[1]}`;
}

function updateEspHeartbeatUI() {
  const ageSec = (Date.now() - state.lastTelemetryAt) / 1000;
  const badge = document.getElementById('espBadge');
  const dot = document.getElementById('espDot');
  const text = document.getElementById('espText');

  if (state.isOnline && state.lastTelemetryAt > 0 && ageSec < 25) {
    badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-700/60 text-emerald-400 text-[11px] sm:text-xs font-semibold cursor-pointer transition hover:scale-105';
    dot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    text.textContent = 'ESP32: متصل';
  } else {
    badge.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-950/60 border border-rose-700/60 text-rose-400 text-[11px] sm:text-xs font-semibold cursor-pointer transition hover:scale-105';
    dot.className = 'w-2 h-2 rounded-full bg-rose-500';
    text.textContent = state.lastTelemetryAt === 0 ? 'ESP32: انتظار' : 'ESP32: منقطع';
  }
}

function startWatchdogs() {
  setInterval(() => {
    const now = new Date();
    document.getElementById('espClock').textContent = now.toTimeString().slice(0, 8);
  }, 1000);

  setInterval(updateEspHeartbeatUI, 2000);
}

function flashLockWarning(el) {
  if (!el) return;
  el.classList.remove('shake-lock');
  void el.offsetWidth;
  el.classList.add('shake-lock');
}

function logMsg(msg) {
  const box = document.getElementById('logConsole');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'flex items-start justify-between gap-2 border-b border-gray-900 pb-1';

  const msgSpan = document.createElement('span');
  msgSpan.className = 'break-words';
  msgSpan.textContent = msg;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'ltr text-[10px] text-gray-500 shrink-0 font-mono-num';
  timeSpan.textContent = new Date().toTimeString().slice(0, 8);

  div.appendChild(msgSpan);
  div.appendChild(timeSpan);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function clearLogs() {
  document.getElementById('logConsole').innerHTML = '';
}

function openAuthModal() {
  document.getElementById('authModal').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('authModal').classList.add('hidden');
}
