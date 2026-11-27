/**
 * ElectroNova Configuration (defaults + URL overrides + localStorage persistence)
 */

const STORAGE_KEY = 'electronova_ui_config_v1';

export const DEFAULT_CONFIG = {
  theme: 'dark',
  transport: 'backend', // 'backend' | 'mock' | 'mqtt' | 'ws'
  deviceId: 'EN_SIM1',
  voiceLang: 'ar-EG',   // Arabic Egypt default as requested
  voiceMode: 'instant', // 'instant' | 'final'
  voiceBeeps: true,
  mqtt: {
    host: 'geeae33e.ala.eu-central-1.emqxsl.com',
    port: 8084,
    ssl: true,
    username: '',
    password: '',
    topicState: 'electronova/EN_SIM1/state',
    topicCmd: 'electronova/EN_SIM1/cmd',
    topicLwt: 'electronova/EN_SIM1/status'
  },
  ws: {
    url: '',
    token: ''
  }
};

export function loadConfig() {
  let saved = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = JSON.parse(raw) || {};
  } catch (_) {
    saved = {};
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...saved,
    mqtt: { ...DEFAULT_CONFIG.mqtt, ...(saved.mqtt || {}) },
    ws: { ...DEFAULT_CONFIG.ws, ...(saved.ws || {}) }
  };

  // URL parameter overrides (?mock=1, ?transport=mock, ?device=EN_SIM1)
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mock') === '1') {
      merged.transport = 'mock';
    } else if (['backend', 'mock', 'mqtt', 'ws'].includes(params.get('transport'))) {
      merged.transport = params.get('transport');
    }
    if (params.get('device')) {
      merged.deviceId = params.get('device').trim();
    }
  } catch (_) {}

  return merged;
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch (_) {}
}

export function resetConfig() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
  return loadConfig();
}
