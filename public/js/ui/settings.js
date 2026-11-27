/**
 * Screen 4: Settings View + Glassmorphism Modals (Auth Login/Register, Device ID, Reset Energy)
 */

import { store } from '../core/store.js';

const MQTT_PRESETS = {
  emqx_public: {
    host: 'broker.emqx.io',
    port: 8084,
    ssl: true,
    topicState: 'electronova/smartstrip/status',
    topicCmd: 'electronova/smartstrip/cmd',
    topicLwt: 'electronova/smartstrip/lwt'
  },
  hivemq_public: {
    host: 'broker.hivemq.com',
    port: 8884,
    ssl: true,
    topicState: 'electronova/smartstrip/status',
    topicCmd: 'electronova/smartstrip/cmd',
    topicLwt: 'electronova/smartstrip/lwt'
  },
  custom: {
    host: 'geeae33e.ala.eu-central-1.emqxsl.com',
    port: 8084,
    ssl: true,
    topicState: 'electronova/EN_SIM1/state',
    topicCmd: 'electronova/EN_SIM1/cmd',
    topicLwt: 'electronova/EN_SIM1/status'
  }
};

export function initSettingsAndModals(controller, { showToast }) {
  let authMode = 'login';

  // Elements
  const authModal = document.getElementById('authModal');
  const deviceModal = document.getElementById('deviceModal');
  const resetModal = document.getElementById('resetEnergyModal');

  const closeModal = (el) => el?.classList.add('hidden');
  const closeAllModals = () => [authModal, deviceModal, resetModal].forEach(closeModal);

  [authModal, deviceModal, resetModal].forEach((modal) => {
    modal?.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });

  // ── Auth Modal Logic ──
  function setAuthTab(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    const isReg = authMode === 'register';
    document.getElementById('tabAuthLogin')?.classList.toggle('active', !isReg);
    document.getElementById('tabAuthRegister')?.classList.toggle('active', isReg);
    document.getElementById('authNameWrap')?.classList.toggle('hidden', !isReg);
    const nameInput = document.getElementById('authNameInput');
    if (nameInput) nameInput.required = isReg;
    document.getElementById('authPasswordInput')?.setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
    const titleSpan = document.querySelector('#authModalTitle span');
    if (titleSpan) titleSpan.textContent = isReg ? 'إنشاء حساب جديد' : 'تسجيل الدخول';
    const submitBtn = document.getElementById('btnSubmitAuth');
    if (submitBtn) submitBtn.textContent = isReg ? 'إنشاء حساب' : 'دخول';
    document.getElementById('authFormError')?.classList.add('hidden');
  }

  function openAuthModal(hint = null) {
    const errBox = document.getElementById('authFormError');
    if (hint && errBox) {
      errBox.textContent = hint;
      errBox.classList.remove('hidden');
    } else if (errBox) {
      errBox.classList.add('hidden');
    }
    authModal?.classList.remove('hidden');
    setTimeout(() => document.getElementById('authEmailInput')?.focus(), 40);
  }

  document.getElementById('tabAuthLogin')?.addEventListener('click', () => setAuthTab('login'));
  document.getElementById('tabAuthRegister')?.addEventListener('click', () => setAuthTab('register'));
  document.getElementById('btnCloseAuthModal')?.addEventListener('click', () => closeModal(authModal));
  document.getElementById('btnCancelAuth')?.addEventListener('click', () => closeModal(authModal));

  document.getElementById('authForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('authFormError');
    errBox?.classList.add('hidden');
    const email = document.getElementById('authEmailInput').value.trim();
    const password = document.getElementById('authPasswordInput').value;
    const name = document.getElementById('authNameInput').value.trim();

    try {
      if (authMode === 'register') {
        await controller.register(name, email, password);
      } else {
        await controller.login(email, password);
      }
      document.getElementById('authPasswordInput').value = '';
      closeModal(authModal);
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    }
  });

  // ── Device ID Modal Logic ──
  function openDeviceModal() {
    const errBox = document.getElementById('deviceFormError');
    errBox?.classList.add('hidden');
    const input = document.getElementById('deviceIdModalInput');
    if (input) input.value = store.getState().deviceId || 'EN_SIM1';
    deviceModal?.classList.remove('hidden');
    setTimeout(() => input?.focus(), 40);
  }

  document.getElementById('btnDeviceSwitch')?.addEventListener('click', openDeviceModal);
  document.getElementById('btnCloseDeviceModal')?.addEventListener('click', () => closeModal(deviceModal));
  document.getElementById('btnCancelDevice')?.addEventListener('click', () => closeModal(deviceModal));

  document.getElementById('deviceForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('deviceFormError');
    errBox?.classList.add('hidden');
    const newId = document.getElementById('deviceIdModalInput').value.trim();
    try {
      await controller.switchDevice(newId);
      closeModal(deviceModal);
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      }
    }
  });

  // ── Reset Energy Modal Logic ──
  function openResetModal() {
    const st = store.getState();
    const preview = document.getElementById('resetPreviewVal');
    if (preview) {
      preview.textContent = `${Number(st.safety.totalKwh || 0).toFixed(3)} kWh • ${Number(st.safety.costEgp || 0).toFixed(2)} EGP`;
    }
    resetModal?.classList.remove('hidden');
  }

  document.getElementById('btnResetEnergy')?.addEventListener('click', openResetModal);
  document.getElementById('btnCloseResetModal')?.addEventListener('click', () => closeModal(resetModal));
  document.getElementById('btnCancelReset')?.addEventListener('click', () => closeModal(resetModal));
  document.getElementById('btnConfirmReset')?.addEventListener('click', async () => {
    const ok = await controller.resetEnergy();
    if (ok) closeModal(resetModal);
  });

  // ── Settings Form Sync & Actions ──
  const cfgTransport = document.getElementById('cfgTransport');
  const mqttWrap = document.getElementById('mqttSettingsFields');
  const wsWrap = document.getElementById('wsSettingsFields');

  function syncTransportFieldsVisibility() {
    const val = cfgTransport?.value || 'backend';
    mqttWrap?.classList.toggle('hidden', val !== 'mqtt');
    wsWrap?.classList.toggle('hidden', val !== 'ws');
  }

  function populateSettingsForm() {
    const cfg = controller.getConfig();
    if (cfgTransport) cfgTransport.value = cfg.transport;
    document.getElementById('cfgDeviceId').value = cfg.deviceId || 'EN_SIM1';
    document.getElementById('cfgMqttHost').value = cfg.mqtt.host || '';
    document.getElementById('cfgMqttPort').value = cfg.mqtt.port || 8084;
    document.getElementById('cfgMqttUser').value = cfg.mqtt.username || '';
    document.getElementById('cfgMqttPass').value = cfg.mqtt.password || '';
    document.getElementById('cfgTopicState').value = cfg.mqtt.topicState || '';
    document.getElementById('cfgTopicCmd').value = cfg.mqtt.topicCmd || '';
    document.getElementById('cfgMqttSsl').checked = cfg.mqtt.ssl !== false;
    document.getElementById('cfgWsUrl').value = cfg.ws.url || '';
    document.getElementById('cfgWsToken').value = cfg.ws.token || '';
    document.getElementById('cfgVoiceLang').value = cfg.voiceLang || 'ar-EG';
    document.getElementById('cfgVoiceMode').value = cfg.voiceMode || 'instant';
    document.getElementById('cfgVoiceBeeps').checked = cfg.voiceBeeps !== false;
    syncTransportFieldsVisibility();
  }

  populateSettingsForm();
  cfgTransport?.addEventListener('change', syncTransportFieldsVisibility);

  document.getElementById('cfgMqttPreset')?.addEventListener('change', (e) => {
    const p = MQTT_PRESETS[e.target.value];
    if (!p) return;
    document.getElementById('cfgMqttHost').value = p.host;
    document.getElementById('cfgMqttPort').value = p.port;
    document.getElementById('cfgMqttSsl').checked = p.ssl;
    document.getElementById('cfgTopicState').value = p.topicState;
    document.getElementById('cfgTopicCmd').value = p.topicCmd;
  });

  document.getElementById('btnSaveSettings')?.addEventListener('click', () => {
    const stateTopic = document.getElementById('cfgTopicState').value.trim();
    const lwtTopic = stateTopic.includes('/smartstrip/')
      ? 'electronova/smartstrip/lwt'
      : stateTopic.replace(/\/(state|status)$/, '/status');

    const enteredDeviceId = document.getElementById('cfgDeviceId').value.trim() || 'EN_SIM1';
    controller.updateConfigAndReconnect({
      transport: cfgTransport.value,
      deviceId: enteredDeviceId,
      mqtt: {
        host: document.getElementById('cfgMqttHost').value.trim(),
        port: Number(document.getElementById('cfgMqttPort').value || 8084),
        username: document.getElementById('cfgMqttUser').value.trim(),
        password: document.getElementById('cfgMqttPass').value,
        topicState: stateTopic,
        topicCmd: document.getElementById('cfgTopicCmd').value.trim(),
        topicLwt: lwtTopic,
        ssl: document.getElementById('cfgMqttSsl').checked
      },
      ws: {
        url: document.getElementById('cfgWsUrl').value.trim(),
        token: document.getElementById('cfgWsToken').value.trim()
      },
      voiceLang: document.getElementById('cfgVoiceLang').value,
      voiceMode: document.getElementById('cfgVoiceMode').value,
      voiceBeeps: document.getElementById('cfgVoiceBeeps').checked
    });
    showToast('✅ تم حفظ الإعدادات وإعادة الاتصال', 'ok');
  });

  document.getElementById('btnResetSettings')?.addEventListener('click', () => {
    controller.resetToDefaults();
    populateSettingsForm();
    showToast('🔄 تم استعادة الإعدادات الافتراضية', 'info');
  });

  document.getElementById('btnApplyDevice')?.addEventListener('click', async () => {
    const val = document.getElementById('cfgDeviceId').value.trim();
    try {
      await controller.switchDevice(val);
    } catch (err) {
      showToast(err.message, 'bad');
    }
  });

  document.getElementById('cfgVoiceMode')?.addEventListener('change', (e) => {
    controller.setVoiceConfig({ voiceMode: e.target.value });
  });

  document.getElementById('cfgVoiceBeeps')?.addEventListener('change', (e) => {
    controller.setVoiceConfig({ voiceBeeps: e.target.checked });
  });

  // Theme toggles (Topbar + Settings)
  document.getElementById('btnThemeTopbar')?.addEventListener('click', () => controller.toggleTheme());
  document.getElementById('btnThemeSettings')?.addEventListener('click', () => controller.toggleTheme());

  // Auth triggers (Topbar + Settings)
  const handleAuthBtn = () => {
    if (store.getState().user) {
      controller.logout();
    } else {
      openAuthModal();
    }
  };
  document.getElementById('btnAuthTopbar')?.addEventListener('click', handleAuthBtn);
  document.getElementById('btnAuthSettings')?.addEventListener('click', handleAuthBtn);

  return { openAuthModal };
}
