/**
 * Express Backend Transport Adapter (WebSocket + Authenticated REST API)
 * Keeps full compatibility with ElectroNova Node.js Backend on Railway/local.
 */

const TOKEN_KEY = 'electronova_token';

export function createBackendTransport(_config, handlers) {
  let ws = null;
  let connected = false;
  let manuallyClosed = false;
  let reconnectTimer = null;
  let keepAliveTimer = null;
  let backoffMs = 3000;

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || null;
    } catch (_) {
      return null;
    }
  }

  function setToken(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  }

  async function api(endpoint, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    const tok = getToken();
    if (tok) headers.Authorization = `Bearer ${tok}`;

    const opts = { method, headers };
    if (body !== null) opts.body = JSON.stringify(body);

    const res = await fetch(`/api${endpoint}`, opts);
    let data = {};
    try {
      data = await res.json();
    } catch (_) {}

    if (!res.ok) {
      if (res.status === 401 && !endpoint.startsWith('/auth/login') && !endpoint.startsWith('/auth/register')) {
        setToken(null);
        handlers.onAuthRequired?.();
      }
      const err = new Error(data.message || `HTTP Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function scheduleReconnect() {
    if (manuallyClosed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(openWs, backoffMs);
    backoffMs = Math.min(15000, backoffMs + 1500);
  }

  function openWs() {
    if (manuallyClosed) return;
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }

    handlers.onStatus?.('connecting');
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/telemetry`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        connected = true;
        backoffMs = 3000;
        handlers.onStatus?.('connected');
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'init' || msg.type === 'telemetry_update') {
            handlers.onMessage?.({ kind: 'telemetry', data: msg.data, retained: msg.type === 'init' });
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        connected = false;
        handlers.onStatus?.('disconnected');
        scheduleReconnect();
      };

      ws.onerror = () => {
        connected = false;
        handlers.onStatus?.('disconnected');
      };
    } catch (_) {
      connected = false;
      handlers.onStatus?.('disconnected');
      scheduleReconnect();
    }
  }

  return {
    type: 'backend',
    isBackend: true,
    connect() {
      manuallyClosed = false;
      openWs();
      clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        fetch('/health', { cache: 'no-store' }).catch(() => {});
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
        }
      }, 240000); // every 4 min while any dashboard tab is open
    },
    disconnect() {
      manuallyClosed = true;
      clearTimeout(reconnectTimer);
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      connected = false;
      if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
      }
    },
    isConnected() {
      return connected;
    },
    async publish(cmdObj) {
      if (cmdObj.type === 'sync' && !getToken()) {
        // Safe public refresh when unauthenticated
        const live = await api('/telemetry/live');
        if (live?.device) {
          handlers.onMessage?.({ kind: 'telemetry', data: live.device, retained: true });
        }
        return true;
      }

      switch (cmdObj.type) {
        case 'outlet':
          await api(`/outlets/${cmdObj.id}`, 'POST', { state: Boolean(cmdObj.state) });
          return true;
        case 'all':
          await api('/outlets/all', 'POST', { state: Boolean(cmdObj.state) });
          return true;
        case 'schedule':
          await api(`/schedules/${cmdObj.id}`, 'POST', {
            enabled: Boolean(cmdObj.enabled),
            onTime: cmdObj.on,
            offTime: cmdObj.off
          });
          return true;
        case 'timer':
          await api(`/outlets/${cmdObj.id}/timer`, 'POST', { delaySec: cmdObj.delaySec });
          return true;
        case 'resetEnergy':
          await api('/telemetry/energy/reset', 'POST');
          return true;
        case 'sync':
          await api('/telemetry/sync', 'POST');
          return true;
        default:
          return false;
      }
    },
    getToken,
    setToken,
    fetchLive: () => api('/telemetry/live'),
    fetchHistory: () => api('/telemetry/history'),
    fetchLogs: () => api('/telemetry/logs'),
    fetchAnalytics: () => api('/analytics/energy'),
    login: (email, password) => api('/auth/login', 'POST', { email, password }),
    register: (name, email, password) => api('/auth/register', 'POST', { name, email, password }),
    getMe: () => api('/auth/me'),
    switchDevice: (deviceId) => api('/telemetry/device', 'POST', { deviceId }),
    unlockSafety: () => api('/safety/unlock', 'POST'),
    sequentialRestore: (delayMs = 3000) => api('/safety/sequential-restore', 'POST', { delayMs })
  };
}
