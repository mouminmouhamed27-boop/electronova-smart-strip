/**
 * Builds 4 Outlet Cards ONCE and patches DOM in place with 15s Edit-Lock protection.
 * Supports shared Website + Mobile App outlet naming & protection lock (`PATCH /api/outlets/:id`).
 */

import { OUTLET_META, STRINGS } from '../strings.js';
import {
  isOverheatLocked,
  isOverloadLocked,
  isSensorFaultLocked,
  isOvercurrentLatched,
  isDeviceReady
} from '../core/safety.js';

const editLockUntil = {}; // { [outletId]: timestampMs }

function markEditing(id) {
  editLockUntil[id] = Date.now() + 15000;
}

function formatSec(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export function initOutletCards(controller) {
  const container = document.getElementById('outletsContainer');
  if (!container) return;

  container.innerHTML = OUTLET_META.map((m) => `
    <article id="cardOutlet${m.id}" class="card outlet-card">
      <div class="outlet-top">
        <div style="min-width:0">
          <div class="section-title">
            <span id="dotOutlet${m.id}" class="dot"></span>
            <span>${m.name}</span>
            <span class="num" style="font-size:.7rem;color:var(--mute)">${m.code}</span>
            <span id="protBadgeOutlet${m.id}" class="badge badge-p1 hidden" title="محمي من الفصل الجماعي التلقائي">🛡️ محمي</span>
          </div>
          <p id="descOutlet${m.id}" class="section-sub" style="margin-top:2px">${m.desc}</p>
        </div>
        <span id="prioBadgeOutlet${m.id}" class="badge ${m.badgeClass} num">${m.badge}</span>
      </div>

      <div class="outlet-metrics">
        <div>
          <div class="metric-lbl">تيار (ACS712)</div>
          <div id="ampsOutlet${m.id}" class="metric-val num" style="color:var(--accent)">0.0 A</div>
        </div>
        <div>
          <div class="metric-lbl">قدرة</div>
          <div id="wattsOutlet${m.id}" class="metric-val num" style="color:var(--accent-2)">0 W</div>
        </div>
        <div>
          <div class="metric-lbl">طاقة</div>
          <div id="kwhOutlet${m.id}" class="metric-val num" style="color:var(--warn)">0.000</div>
        </div>
      </div>

      <div class="outlet-toggle-row">
        <span id="stateLabelOutlet${m.id}" style="font-size:.82rem;font-weight:800;color:var(--dim)">مغلق (OFF)</span>
        <button id="switchOutlet${m.id}" class="switch" role="switch" aria-checked="false" aria-label="تشغيل أو فصل ${m.name}">
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </button>
      </div>

      <details class="schedule-details">
        <summary>
          <span><i class="fa-regular fa-clock"></i> الجدولة والمؤقت والتخصيص</span>
          <span id="schBadgeOutlet${m.id}" style="font-size:.72rem;color:var(--mute)">معطّل ▾</span>
        </summary>
        <div class="schedule-body">
          <!-- Shared Name & Critical Protection Lock -->
          <div class="field">
            <label class="field-label" for="metaName${m.id}">اسم الجهاز المتصل (يتزامن مع التطبيق)</label>
            <div class="timer-row">
              <input id="metaName${m.id}" type="text" class="input" maxlength="60" value="${m.desc}">
              <button id="btnSaveMeta${m.id}" type="button" class="btn btn-ghost btn-sm" style="flex-shrink:0">حفظ</button>
            </div>
          </div>
          <label class="checkbox-row" style="min-height:34px">
            <input type="checkbox" id="metaProt${m.id}" ${m.id === 1 ? 'checked' : ''}>
            <span>🛡️ مخرج حرج (محمي من تخفيف الحمل والإطفاء الجماعي)</span>
          </label>

          <div style="border-top:1px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="section-header">
              <span style="font-size:.76rem;font-weight:700">جدولة يومية (Cron + NTP)</span>
              <label class="checkbox-row" style="min-height:36px">
                <input type="checkbox" id="schEn${m.id}">
                <span>تفعيل</span>
              </label>
            </div>
            <div class="schedule-times">
              <div class="field">
                <label class="field-label" for="schOn${m.id}">تشغيل</label>
                <input id="schOn${m.id}" type="time" value="08:00" class="input num">
              </div>
              <div class="field">
                <label class="field-label" for="schOff${m.id}">فصل</label>
                <input id="schOff${m.id}" type="time" value="23:00" class="input num">
              </div>
            </div>
            <button id="btnSaveSch${m.id}" type="button" class="btn btn-ghost btn-sm">حفظ الجدول في السيرفر والـ ESP32</button>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:10px;display:flex;flex-direction:column;gap:8px">
            <div class="section-header" style="font-size:.75rem">
              <span style="color:var(--dim);font-weight:700">مؤقت سريع (عكس الحالة)</span>
              <span id="timerLabel${m.id}" class="num" style="color:var(--accent);font-weight:800">معطّل</span>
            </div>
            <div class="timer-row">
              <select id="timerSel${m.id}" class="select" aria-label="مدة المؤقت لمخرج ${m.id}">
                <option value="10">10 ثوانٍ</option>
                <option value="60">1 دقيقة</option>
                <option value="300">5 دقائق</option>
                <option value="1800">30 دقيقة</option>
                <option value="3600">1 ساعة</option>
              </select>
              <button id="btnTimer${m.id}" type="button" class="btn btn-primary btn-sm" style="flex-shrink:0">ضبط</button>
            </div>
          </div>
        </div>
      </details>
    </article>
  `).join('');

  OUTLET_META.forEach((m) => {
    const id = m.id;
    const sw = document.getElementById(`switchOutlet${id}`);
    sw?.addEventListener('click', () => {
      const isChecked = sw.getAttribute('aria-checked') === 'true';
      controller.setOutlet(id, !isChecked, { shakeTarget: `outlet-${id}` });
    });

    ['schEn', 'schOn', 'schOff', 'metaName', 'metaProt'].forEach((prefix) => {
      const el = document.getElementById(`${prefix}${id}`);
      el?.addEventListener('focus', () => markEditing(id));
      el?.addEventListener('input', () => markEditing(id));
      el?.addEventListener('change', () => markEditing(id));
    });

    document.getElementById(`btnSaveMeta${id}`)?.addEventListener('click', () => {
      editLockUntil[id] = 0;
      const name = document.getElementById(`metaName${id}`).value.trim();
      const isProtected = document.getElementById(`metaProt${id}`).checked;
      controller.updateOutletMeta(id, { name, isProtected });
    });

    document.getElementById(`metaProt${id}`)?.addEventListener('change', (e) => {
      editLockUntil[id] = 0;
      controller.updateOutletMeta(id, { isProtected: e.target.checked });
    });

    document.getElementById(`btnSaveSch${id}`)?.addEventListener('click', () => {
      editLockUntil[id] = 0;
      const enabled = document.getElementById(`schEn${id}`).checked;
      const onTime = document.getElementById(`schOn${id}`).value || '08:00';
      const offTime = document.getElementById(`schOff${id}`).value || '23:00';
      controller.setSchedule(id, enabled, onTime, offTime);
    });

    document.getElementById(`btnTimer${id}`)?.addEventListener('click', () => {
      const sec = parseInt(document.getElementById(`timerSel${id}`).value, 10);
      controller.setTimer(id, sec);
    });
  });
}

export function patchOutletCards(state) {
  const ready = isDeviceReady(state);
  const sensorFault = isSensorFaultLocked(state.safety);
  const overheat = isOverheatLocked(state.safety);
  const latched = isOvercurrentLatched(state.safety);
  const overload = isOverloadLocked(state.safety);
  const now = Date.now();

  state.outlets.forEach((o) => {
    const card = document.getElementById(`cardOutlet${o.id}`);
    const dot = document.getElementById(`dotOutlet${o.id}`);
    const desc = document.getElementById(`descOutlet${o.id}`);
    const protBadge = document.getElementById(`protBadgeOutlet${o.id}`);
    const ampsEl = document.getElementById(`ampsOutlet${o.id}`);
    const wattsEl = document.getElementById(`wattsOutlet${o.id}`);
    const kwhEl = document.getElementById(`kwhOutlet${o.id}`);
    const stateLabel = document.getElementById(`stateLabelOutlet${o.id}`);
    const sw = document.getElementById(`switchOutlet${o.id}`);
    if (!card || !sw) return;

    if (desc && o.name) desc.textContent = o.name;
    if (protBadge) protBadge.classList.toggle('hidden', !o.isProtected);
    ampsEl.textContent = `${Number(o.currentAmps || 0).toFixed(1)} A`;
    ampsEl.style.color = o.currentAmps >= 9.0 ? 'var(--danger)' : o.currentAmps > 7.0 ? 'var(--warn)' : 'var(--accent)';
    wattsEl.textContent = `${Math.round(o.currentWatts || 0)} W`;
    kwhEl.textContent = Number(o.totalKwh || 0).toFixed(3);
    sw.setAttribute('aria-checked', ready && o.state ? 'true' : 'false');

    card.classList.remove('card-on', 'card-locked', 'card-warn', 'card-offline');
    sw.classList.remove('switch-locked', 'switch-offline');

    if (!ready) {
      card.classList.add('card-offline');
      sw.classList.add('switch-offline');
      dot.style.background = 'var(--mute)';
      stateLabel.textContent = '🔌 غير متصل (بانتظار ESP32)';
      stateLabel.style.color = 'var(--mute)';
    } else if (o.state) {
      card.classList.add('card-on');
      dot.style.background = 'var(--accent-2)';
      stateLabel.textContent = STRINGS.onLabel;
      stateLabel.style.color = 'var(--accent-2)';
    } else if (sensorFault) {
      card.classList.add('card-locked');
      sw.classList.add('switch-locked');
      dot.style.background = 'var(--danger)';
      stateLabel.textContent = STRINGS.sensorFaultOutletLabel;
      stateLabel.style.color = 'var(--danger)';
    } else if (overheat) {
      card.classList.add('card-locked');
      sw.classList.add('switch-locked');
      dot.style.background = 'var(--danger)';
      stateLabel.textContent = STRINGS.overheatOutletLabel;
      stateLabel.style.color = 'var(--danger)';
    } else if (latched) {
      card.classList.add('card-locked');
      sw.classList.add('switch-locked');
      dot.style.background = 'var(--danger)';
      stateLabel.textContent = STRINGS.latchedOutletLabel;
      stateLabel.style.color = 'var(--danger)';
    } else if (overload) {
      card.classList.add('card-warn');
      sw.classList.add('switch-locked');
      dot.style.background = 'var(--warn)';
      stateLabel.textContent = STRINGS.overloadOutletLabel;
      stateLabel.style.color = 'var(--warn)';
    } else {
      dot.style.background = 'var(--mute)';
      stateLabel.textContent = STRINGS.offLabel;
      stateLabel.style.color = 'var(--dim)';
    }

    const sch = state.schedules.find((s) => s.outletId === o.id);
    const enEl = document.getElementById(`schEn${o.id}`);
    const onEl = document.getElementById(`schOn${o.id}`);
    const offEl = document.getElementById(`schOff${o.id}`);
    const metaNameEl = document.getElementById(`metaName${o.id}`);
    const metaProtEl = document.getElementById(`metaProt${o.id}`);
    const schBadge = document.getElementById(`schBadgeOutlet${o.id}`);

    const isEditing =
      (editLockUntil[o.id] || 0) > now ||
      document.activeElement === enEl ||
      document.activeElement === onEl ||
      document.activeElement === offEl ||
      document.activeElement === metaNameEl ||
      document.activeElement === metaProtEl;

    if (!isEditing) {
      if (metaNameEl && o.name) metaNameEl.value = o.name;
      if (metaProtEl) metaProtEl.checked = Boolean(o.isProtected);
      if (sch && enEl && onEl && offEl && schBadge) {
        enEl.checked = Boolean(sch.enabled);
        if (sch.onTime) onEl.value = sch.onTime;
        if (sch.offTime) offEl.value = sch.offTime;
        schBadge.textContent = sch.enabled ? `${sch.onTime}–${sch.offTime} ▾` : 'معطّل ▾';
        schBadge.style.color = sch.enabled ? 'var(--accent-2)' : 'var(--mute)';
      }
    }

    const timerEl = document.getElementById(`timerLabel${o.id}`);
    if (timerEl) {
      const rem = state.timers[o.id];
      if (rem > 0) {
        const actionWord = o.state ? 'فصل' : 'تشغيل';
        timerEl.textContent = `${actionWord} بعد ${formatSec(rem)}`;
      } else {
        timerEl.textContent = 'معطّل';
      }
    }
  });
}
