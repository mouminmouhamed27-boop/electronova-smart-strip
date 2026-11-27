/**
 * Generic Raw WebSocket Transport Adapter (for external WS servers)
 */

export function createWsTransport(config, handlers) {
  let ws = null;
  let connected = false;
  let manuallyClosed = false;
  let reconnectTimer = null;
  let backoffMs = 3000;

  function buildUrl() {
    const base = (config.ws?.url || '').trim();
    if (!base) return null;
    const tok = (config.ws?.token || '').trim();
    if (!tok) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}token=${encodeURIComponent(tok)}`;
  }

  function scheduleReconnect() {
    if (manuallyClosed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(openSocket, backoffMs);
    backoffMs = Math.min(15000, backoffMs + 1500);
  }

  function openSocket() {
    if (manuallyClosed) return;
    const url = buildUrl();
    if (!url) {
      handlers.onStatus?.('disconnected');
      return;
    }

    handlers.onStatus?.('connecting');
    try {
      ws = new WebSocket(url);

      ws.onopen = () => {
        connected = true;
        backoffMs = 3000;
        const tok = (config.ws?.token || '').trim();
        if (tok) {
          try { ws.send(JSON.stringify({ auth: tok })); } catch (_) {}
        }
        handlers.onStatus?.('connected');
      };

      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.lwt) {
            handlers.onMessage?.({ kind: 'lwt', text: String(msg.lwt), retained: false });
          } else {
            handlers.onMessage?.({
              kind: 'telemetry',
              data: msg.data || msg,
              retained: Boolean(msg.retained)
            });
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
    type: 'ws',
    connect() {
      manuallyClosed = false;
      openSocket();
    },
    disconnect() {
      manuallyClosed = true;
      clearTimeout(reconnectTimer);
      connected = false;
      if (ws) {
        try { ws.close(); } catch (_) {}
        ws = null;
      }
    },
    isConnected() {
      return connected;
    },
    publish(cmdObj) {
      if (!ws || !connected || ws.readyState !== 1) return false;
      try {
        ws.send(JSON.stringify(cmdObj));
        return true;
      } catch (_) {
        return false;
      }
    }
  };
}
