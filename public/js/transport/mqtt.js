/**
 * Paho MQTT over WebSocket Transport Adapter (with CDN fallback & backoff)
 */

const PAHO_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/paho-mqtt/1.0.1/mqttws31.min.js',
  'https://cdn.jsdelivr.net/npm/paho-mqtt@1.0.4/mqttws31.min.js'
];

let pahoPromise = null;

function loadPahoScript() {
  if (window.Paho?.MQTT?.Client) return Promise.resolve();
  if (pahoPromise) return pahoPromise;

  pahoPromise = new Promise((resolve, reject) => {
    const tryNext = (idx) => {
      if (idx >= PAHO_URLS.length) {
        reject(new Error('Failed to load Paho MQTT client library'));
        return;
      }
      const script = document.createElement('script');
      script.src = PAHO_URLS[idx];
      script.async = true;
      script.onload = () => (window.Paho?.MQTT?.Client ? resolve() : tryNext(idx + 1));
      script.onerror = () => tryNext(idx + 1);
      document.head.appendChild(script);
    };
    tryNext(0);
  });
  return pahoPromise;
}

export function createMqttTransport(config, handlers) {
  let client = null;
  let connected = false;
  let manuallyClosed = false;
  let reconnectTimer = null;
  let backoffMs = 3000;

  const mqttCfg = config.mqtt || {};
  const deviceId = config.deviceId || 'EN_SIM1';
  const topicState = mqttCfg.topicState || `electronova/${deviceId}/state`;
  const topicCmd = mqttCfg.topicCmd || `electronova/${deviceId}/cmd`;
  const topicLwt = mqttCfg.topicLwt || `electronova/${deviceId}/status`;

  function scheduleReconnect() {
    if (manuallyClosed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(startConnect, backoffMs);
    backoffMs = Math.min(15000, backoffMs + 1500);
  }

  async function startConnect() {
    if (manuallyClosed) return;
    handlers.onStatus?.('connecting');

    try {
      await loadPahoScript();
      const clientId = `ElectroNova_Web_${Math.random().toString(16).slice(2, 8)}`;
      const host = mqttCfg.host || 'geeae33e.ala.eu-central-1.emqxsl.com';
      const port = Number(mqttCfg.port || 8084);
      const ssl = mqttCfg.ssl !== false;

      client = new window.Paho.MQTT.Client(host, port, '/mqtt', clientId);

      client.onConnectionLost = () => {
        connected = false;
        handlers.onStatus?.('disconnected');
        scheduleReconnect();
      };

      client.onMessageArrived = (msg) => {
        const retained = Boolean(msg.retained);
        const dest = msg.destinationName;
        const payloadText = msg.payloadString || '';

        if (dest === topicLwt) {
          handlers.onMessage?.({ kind: 'lwt', text: payloadText, retained });
          return;
        }
        if (dest === topicState) {
          try {
            const parsed = JSON.parse(payloadText);
            handlers.onMessage?.({ kind: 'telemetry', data: parsed, retained });
          } catch (_) {}
        }
      };

      const connectOpts = {
        useSSL: ssl,
        cleanSession: true,
        keepAliveInterval: 45,
        timeout: 8,
        onSuccess: () => {
          connected = true;
          backoffMs = 3000;
          client.subscribe(topicState);
          client.subscribe(topicLwt);
          handlers.onStatus?.('connected');
        },
        onFailure: () => {
          connected = false;
          handlers.onStatus?.('disconnected');
          scheduleReconnect();
        }
      };

      if (mqttCfg.username) connectOpts.userName = mqttCfg.username;
      if (mqttCfg.password) connectOpts.password = mqttCfg.password;

      client.connect(connectOpts);
    } catch (_) {
      connected = false;
      handlers.onStatus?.('disconnected');
      scheduleReconnect();
    }
  }

  return {
    type: 'mqtt',
    connect() {
      manuallyClosed = false;
      startConnect();
    },
    disconnect() {
      manuallyClosed = true;
      clearTimeout(reconnectTimer);
      connected = false;
      if (client) {
        try {
          if (client.isConnected()) client.disconnect();
        } catch (_) {}
        client = null;
      }
    },
    isConnected() {
      return connected;
    },
    publish(cmdObj) {
      if (!client || !connected) return false;
      try {
        const msg = new window.Paho.MQTT.Message(JSON.stringify(cmdObj));
        msg.destinationName = topicCmd;
        msg.qos = 1;
        client.send(msg);
        return true;
      } catch (_) {
        return false;
      }
    }
  };
}
