/**
 * Reactive UI Renderer (subscribes to Store and updates DOM safely via textContent)
 */

import { store } from '../core/store.js';
import { STRINGS } from '../strings.js';
import { isOverheatLocked, isOverloadLocked, isDeviceReady } from '../core/safety.js';
import { renderPowerChart } from './chart.js';
import { patchOutletCards } from './outletCards.js';
import { renderEnergyView } from './energyView.js';

const RING_CIRCUMFERENCE = 2 * Math.PI * 24; // r=24 -> ~150.8

function initQuickTiles(controller) {
  const wrap = document.getElementById('quickTiles');
  if (!wrap) return;
  wrap.innerHTML = [1, 2, 3, 4].map((id) => `
    <button id="quickTile${id}" class="quick-tile" type="button" aria-label="تبديل سريع لمخرج ${id}">
      <div>
        <div class="quick-tile-title">مخرج ${id}</div>
        <div id="quickTileMeta${id}" class="quick-tile-meta num">0 W</div>
      </div>
      <span id="quickTileDot${id}" class="dot"></span>
    </button>
  `).join('');

  [1, 2, 3, 4].forEach((id) => {
    const btn = document.getElementById(`quickTile${id}`);
    btn?.addEventListener('click', () => {
      const o = store.getState().outlets.find((item) => item.id === id);
      controller.setOutlet(id, !(o?.state), { shakeTarget: `quick-${id}` });
    });
  });
}

function renderLogs(logs) {
  const box = document.getElementById('logConsole');
  if (!box) return;
  box.innerHTML = '';

  if (logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-info';
    empty.textContent = '> في انتظار أحداث النظام...';
    box.appendChild(empty);
    return;
  }

  logs.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'log-row';

    const msgSpan = document.createElement('span');
    msgSpan.className = `log-${entry.level || 'info'}`;
    msgSpan.textContent = entry.text;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'num';
    timeSpan.style.fontSize = '0.68rem';
    timeSpan.style.color = 'var(--mute)';
    timeSpan.style.flexShrink = '0';
    timeSpan.textContent = entry.time || '';

    row.appendChild(msgSpan);
    row.appendChild(timeSpan);
    box.appendChild(row);
  });

  box.scrollTop = box.scrollHeight;
}

export function triggerShake(targetKey) {
  let el = null;
  if (targetKey === 'master-on') el = document.getElementById('btnMasterOn');
  else if (String(targetKey).startsWith('outlet-')) el = document.getElementById(`cardOutlet${targetKey.split('-')[1]}`);
  else if (String(targetKey).startsWith('quick-')) el = document.getElementById(`quickTile${targetKey.split('-')[1]}`);
  if (!el) return;
  el.classList.remove('shake-lock');
  void el.offsetWidth;
  el.classList.add('shake-lock');
}

export function initRenderer(controller) {
  initQuickTiles(controller);

  // Wire Home + Header action buttons
  document.getElementById('espChip')?.addEventListener('click', () => controller.requestSync());
  document.getElementById('cloudChip')?.addEventListener('click', () => controller.reconnect());
  document.getElementById('btnMasterOn')?.addEventListener('click', () => controller.setAll(true));
  document.getElementById('btnMasterOff')?.addEventListener('click', () => controller.setAll(false));
  document.getElementById('btnClearLogs')?.addEventListener('click', () => controller.clearLogs());
  document.getElementById('btnSafetyUnlock')?.addEventListener('click', () => controller.unlockSafety());
  document.getElementById('btnSequentialRestore')?.addEventListener('click', () => controller.sequentialRestore());
  document.getElementById('btnRefreshAnalytics')?.addEventListener('click', () => controller.refreshAnalytics());

  let lastLogsRef = null;
  let lastHistoryRef = null;

  function render(state) {
    // 1. Theme Sync
    const isLight = state.theme === 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    const metaTheme = document.getElementById('metaThemeColor');
    if (metaTheme) metaTheme.setAttribute('content', isLight ? '#f1f5f9' : '#07101f');
    const themeIcon = document.getElementById('iconThemeTopbar');
    if (themeIcon) themeIcon.className = isLight ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    const settingsThemeTxt = document.getElementById('settingsThemeText');
    if (settingsThemeTxt) settingsThemeTxt.textContent = isLight ? 'فاتح (Light)' : 'داكن (Dark)';

    // 2. Topbar Badges & Chips
    const transportBadge = document.getElementById('activeTransportBadge');
    if (transportBadge) transportBadge.textContent = state.transportType.toUpperCase();

    const clockEl = document.getElementById('espClock');
    if (clockEl) clockEl.textContent = state.espTime || '--:--:--';
    const ntpBadge = document.getElementById('ntpBadge');
    if (ntpBadge) ntpBadge.classList.toggle('hidden', !state.ntpSynced);

    const devEl = document.getElementById('activeDeviceId');
    if (devEl) devEl.textContent = state.deviceId || 'EN_SIM1';

    const espChip = document.getElementById('espChip');
    const espText = document.getElementById('espStatusText');
    if (espChip && espText) {
      espChip.className = state.isOnline ? 'chip chip-ok' : 'chip chip-bad';
      espText.textContent = state.isOnline
        ? STRINGS.espOnline
        : state.lastHeartbeatMs === 0
          ? STRINGS.espWaiting
          : STRINGS.espOffline;
    }

    const cloudChip = document.getElementById('cloudChip');
    const cloudText = document.getElementById('cloudStatusText');
    if (cloudChip && cloudText) {
      const clsMap = { connected: 'chip chip-ok', connecting: 'chip chip-warn', disconnected: 'chip chip-bad' };
      const txtMap = { connected: STRINGS.cloudConnected, connecting: STRINGS.cloudConnecting, disconnected: STRINGS.cloudDisconnected };
      cloudChip.className = clsMap[state.cloudStatus] || 'chip';
      cloudText.textContent = txtMap[state.cloudStatus] || state.cloudStatus;
    }

    // 3. Auth UI Sync (Topbar + Settings)
    const authLabel = document.getElementById('authLabelTopbar');
    const btnAuthTopbar = document.getElementById('btnAuthTopbar');
    const accName = document.getElementById('settingsAccountName');
    const accEmail = document.getElementById('settingsAccountEmail');
    const btnAuthSettings = document.getElementById('btnAuthSettings');
    if (state.user) {
      if (authLabel) authLabel.textContent = state.user.name;
      if (btnAuthTopbar) btnAuthTopbar.className = 'chip chip-ok';
      if (accName) accName.textContent = state.user.name;
      if (accEmail) accEmail.textContent = state.user.email;
      if (btnAuthSettings) btnAuthSettings.textContent = 'تسجيل خروج';
    } else {
      if (authLabel) authLabel.textContent = 'دخول';
      if (btnAuthTopbar) btnAuthTopbar.className = 'chip';
      if (accName) accName.textContent = 'زائر (غير مسجل)';
      if (accEmail) accEmail.textContent = state.transportType === 'backend' ? 'سجل دخولك للتحكم عبر الـ Backend' : `تعمل بوضع ${state.transportType}`;
      if (btnAuthSettings) btnAuthSettings.textContent = 'تسجيل دخول';
    }

    // 4. Safety Banner
    const overheat = isOverheatLocked(state.safety);
    const overload = isOverloadLocked(state.safety);
    const banner = document.getElementById('alertBanner');
    const bannerMsg = document.getElementById('alertBannerMsg');
    const bannerActions = document.getElementById('alertBannerActions');
    if (banner && bannerMsg) {
      banner.classList.remove('hidden', 'banner-warn');
      if (overheat) {
        bannerMsg.textContent = STRINGS.overheatBanner;
      } else if (overload) {
        bannerMsg.textContent = STRINGS.overloadBanner(state.safety.alert);
      } else if (state.safety.isVoltageFault) {
        banner.classList.add('banner-warn');
        bannerMsg.textContent = STRINGS.voltageBanner(Number(state.safety.volts || 0));
      } else {
        banner.classList.add('hidden');
      }
      if (bannerActions) {
        bannerActions.classList.toggle('hidden', state.transportType !== 'backend');
      }
    }

    // 5. KPI Cards
    const temp = Number(state.safety.temperatureC ?? 25);
    const tempPct = Math.min(100, Math.max(0, (temp / 65) * 100));
    const tempColor = temp > 60 ? 'var(--danger)' : temp >= 45 ? 'var(--warn)' : 'var(--accent-2)';
    document.getElementById('kpiTemp').textContent = temp.toFixed(1);
    const barTemp = document.getElementById('barTemp');
    barTemp.style.width = `${tempPct}%`;
    barTemp.style.background = tempColor;
    const ringTemp = document.getElementById('ringTemp');
    if (ringTemp) {
      ringTemp.style.strokeDashoffset = (RING_CIRCUMFERENCE * (1 - tempPct / 100)).toFixed(1);
      ringTemp.style.stroke = tempColor;
    }

    const amps = Number(state.safety.totalAmps || 0);
    const ampsColor = amps > 15.0 ? 'var(--danger)' : amps >= 12.8 ? 'var(--warn)' : 'var(--accent)';
    const kpiAmps = document.getElementById('kpiAmps');
    kpiAmps.textContent = amps.toFixed(1);
    kpiAmps.style.color = ampsColor;
    const barAmps = document.getElementById('barAmps');
    barAmps.style.width = `${Math.min(100, (amps / 16) * 100)}%`;
    barAmps.style.background = ampsColor;

    document.getElementById('kpiWatts').textContent = Math.round(state.safety.totalWatts || 0);
    const volts = Number(state.safety.volts ?? 220);
    const voltsEl = document.getElementById('kpiVolts');
    voltsEl.textContent = `${volts.toFixed(1)}V AC`;
    voltsEl.style.color = state.safety.isVoltageFault ? 'var(--danger)' : 'var(--accent)';

    document.getElementById('kpiKwh').textContent = Number(state.safety.totalKwh || 0).toFixed(3);
    document.getElementById('kpiCost').textContent = Number(state.safety.costEgp || 0).toFixed(2);
    document.getElementById('kpiTariff').textContent = `${Number(state.tariffEgp || 1.25).toFixed(2)} EGP/kWh`;

    // 6. Master ON / OFF lock UI (locked when ESP32 offline, or ON locked during overheat/overload)
    const ready = isDeviceReady(state);
    const btnMasterOn = document.getElementById('btnMasterOn');
    const btnMasterOff = document.getElementById('btnMasterOff');
    const iconMasterOn = document.getElementById('iconMasterOn');
    const labelMasterOn = document.getElementById('labelMasterOn');

    if (!ready) {
      btnMasterOn.className = 'btn btn-locked';
      iconMasterOn.className = 'fa-solid fa-plug-circle-xmark';
      labelMasterOn.textContent = 'بانتظار ESP32';
      btnMasterOff.className = 'btn btn-locked';
    } else if (overheat) {
      btnMasterOn.className = 'btn btn-locked';
      iconMasterOn.className = 'fa-solid fa-lock';
      labelMasterOn.textContent = STRINGS.masterOnOverheat;
      btnMasterOff.className = 'btn btn-danger';
    } else if (overload) {
      btnMasterOn.className = 'btn btn-locked';
      iconMasterOn.className = 'fa-solid fa-bolt';
      labelMasterOn.textContent = STRINGS.masterOnOverload;
      btnMasterOff.className = 'btn btn-danger';
    } else {
      btnMasterOn.className = 'btn btn-success';
      iconMasterOn.className = 'fa-solid fa-power-off';
      labelMasterOn.textContent = STRINGS.masterOnNormal;
      btnMasterOff.className = 'btn btn-danger';
    }

    // 7. Quick Outlet Tiles
    state.outlets.forEach((o) => {
      const tile = document.getElementById(`quickTile${o.id}`);
      const meta = document.getElementById(`quickTileMeta${o.id}`);
      const dot = document.getElementById(`quickTileDot${o.id}`);
      if (!tile) return;
      tile.classList.remove('tile-on', 'tile-locked');
      if (!ready) {
        tile.classList.add('tile-locked');
        dot.style.background = 'var(--mute)';
        if (meta) meta.textContent = 'غير متصل';
      } else if (o.state) {
        tile.classList.add('tile-on');
        dot.style.background = 'var(--accent-2)';
        if (meta) meta.textContent = `${Math.round(o.currentWatts || 0)}W`;
      } else if (overheat || overload) {
        tile.classList.add('tile-locked');
        dot.style.background = 'var(--danger)';
        if (meta) meta.textContent = 'OFF';
      } else {
        dot.style.background = 'var(--mute)';
        if (meta) meta.textContent = 'OFF';
      }
    });

    // 8. SVG Chart & Logs (update when reference changes)
    if (state.history !== lastHistoryRef) {
      lastHistoryRef = state.history;
      renderPowerChart(state.history);
    }
    if (state.logs !== lastLogsRef) {
      lastLogsRef = state.logs;
      renderLogs(state.logs);
    }

    // 9. Outlets & Energy screens
    patchOutletCards(state);
    renderEnergyView(state);

    // 10. Floating Voice Dock
    const btnVoice = document.getElementById('btnVoiceDock');
    const voiceIcon = document.getElementById('voiceDockIcon');
    const voiceLabel = document.getElementById('voiceDockLabel');
    const voicePill = document.getElementById('voiceDockPill');
    const btnVoiceLang = document.getElementById('btnVoiceLangDock');
    if (btnVoice && voicePill) {
      btnVoice.classList.toggle('live', state.voice.active);
      btnVoice.disabled = !state.voice.supported;
      voiceIcon.className = state.voice.active ? 'fa-solid fa-stop-circle' : 'fa-solid fa-microphone';
      voiceLabel.textContent = state.voice.active ? 'إيقاف' : 'صوت';
      voicePill.textContent = state.voice.pillText;
      voicePill.className = `voice-pill ${state.voice.pillMode || ''}`;
    }
    if (btnVoiceLang) {
      btnVoiceLang.textContent = state.voice.lang.startsWith('ar') ? 'ع' : 'EN';
    }
  }

  store.subscribe(render);
  render(store.getState());
}
