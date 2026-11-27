/**
 * Reactive Central State Store (zero DOM dependencies)
 */

function createInitialState() {
  return {
    route: 'home',
    theme: 'dark',
    transportType: 'backend',
    cloudStatus: 'connecting', // 'connecting' | 'connected' | 'disconnected'
    deviceId: 'EN_SIM1',
    isOnline: false,
    connectionMode: 'offline', // 'ws' | 'mqtt' | 'offline'
    lastHeartbeatMs: 0,
    espTime: '--:--:--',
    ntpSynced: true,
    tariffEgp: 1.25,
    user: null,
    token: null,
    diagnostics: {
      ip: null,
      rssi: null,
      firmwareVersion: null,
      bootSelfTest: null,
      lastTripReason: null,
      overcurrentTrips: 0
    },
    assistants: {
      enabled: false,
      connected: false,
      host: null,
      username: null,
      linkedChannels: 0
    },
    outlets: [
      { id: 1, name: 'راوتر / جهاز أساسي', priority: 1, isProtected: true, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.0 },
      { id: 2, name: 'كمبيوتر / محطة عمل', priority: 2, isProtected: false, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.0 },
      { id: 3, name: 'إضاءة المعمل / طرفيات', priority: 3, isProtected: false, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.0 },
      { id: 4, name: 'أحمال غير حرجة / شواحن', priority: 4, isProtected: false, state: false, currentAmps: 0.0, currentWatts: 0, totalKwh: 0.0 }
    ],
    schedules: [
      { outletId: 1, enabled: false, onTime: '08:00', offTime: '23:00' },
      { outletId: 2, enabled: false, onTime: '08:00', offTime: '23:00' },
      { outletId: 3, enabled: false, onTime: '08:00', offTime: '23:00' },
      { outletId: 4, enabled: false, onTime: '08:00', offTime: '23:00' }
    ],
    safety: {
      temperatureC: 25.0,
      volts: 220.0,
      totalAmps: 0.0,
      totalWatts: 0,
      totalKwh: 0.0,
      costEgp: 0.0,
      isOverheatLocked: false,
      isOverloadBlocked: false,
      isOvercurrentLatched: false,
      isSensorFault: false,
      isTempSensorFault: false,
      isCurrentSensorFault: false,
      overcurrentTrips: 0,
      lastTripReason: null,
      isContinuousWarning: false,
      isVoltageFault: false,
      alert: 'OK'
    },
    analytics: null,
    timers: {},        // { [outletId]: remainingSec }
    pendingUntil: {},  // { [outletId]: timestampMs }
    pendingState: {},  // { [outletId]: boolean }
    history: [],       // [{ timestamp, watts }] max 30
    logs: [],          // [{ text, level, time }] max 100
    assistantBar: {
      busy: false,
      statusText: 'تحدث لـ Google Assistant / Alexa أو اكتب أمرك الذكي هنا (مثال: شغل الراوتر)',
      statusMode: 'idle' // 'idle' | 'working' | 'ok' | 'bad'
    }
  };
}

class Store {
  constructor() {
    this.state = createInitialState();
    this.listeners = new Set();
  }

  getState() {
    return this.state;
  }

  setState(updater) {
    const next = typeof updater === 'function' ? updater(this.state) : { ...this.state, ...updater };
    this.state = next;
    this.listeners.forEach((fn) => fn(this.state));
  }

  patch(partial) {
    this.setState((prev) => ({ ...prev, ...partial }));
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const store = new Store();
export { createInitialState };
