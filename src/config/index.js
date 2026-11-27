require('dotenv').config();

const defaultDeviceId = process.env.MQTT_DEVICE_ID || 'EN_SIM1';

function buildTopics(deviceId, useEnvOverrides = false) {
  return {
    cmd: (useEnvOverrides && process.env.MQTT_TOPIC_CMD) || `electronova/${deviceId}/cmd`,
    state: (useEnvOverrides && (process.env.MQTT_TOPIC_STATE || process.env.MQTT_TOPIC_STATUS)) || `electronova/${deviceId}/state`,
    lwt: (useEnvOverrides && process.env.MQTT_TOPIC_LWT) || `electronova/${deviceId}/status`,
  };
}

const initialTopics = buildTopics(defaultDeviceId, true);

const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`
  : '';

const smartnestUser = (process.env.SMARTNEST_USERNAME || '').trim();
const smartnestKey = (process.env.SMARTNEST_API_KEY || '').trim();
const smartnestDeviceIds = (process.env.SMARTNEST_DEVICE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, 4);

const hasSmartnestCreds = Boolean(smartnestUser && smartnestKey && smartnestDeviceIds.length > 0);

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  timezone: process.env.TZ || process.env.APP_TIMEZONE || 'Africa/Cairo',
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_key_123',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  keepAlive: {
    enabled: process.env.KEEPALIVE_ENABLED !== 'false',
    url: process.env.KEEPALIVE_URL || publicDomain || '',
    intervalMs: Math.max(60000, parseInt(process.env.KEEPALIVE_INTERVAL_MS || '300000', 10) || 300000)
  },
  deviceGateway: {
    authToken: (process.env.DEVICE_AUTH_TOKEN || '').trim(),
    firmwareVersion: (process.env.OTA_FIRMWARE_VERSION || '3.0.0').trim(),
    firmwareUrl: (process.env.OTA_FIRMWARE_URL || '').trim()
  },
  smartnest: {
    enabled: process.env.SMARTNEST_ENABLED === 'false' ? false : hasSmartnestCreds,
    host: (process.env.SMARTNEST_HOST || 'smartnest.cz').trim(),
    port: parseInt(process.env.SMARTNEST_PORT || '1883', 10) || 1883,
    username: smartnestUser,
    apiKey: smartnestKey,
    deviceIds: smartnestDeviceIds
  },
  gemini: {
    apiKey: (process.env.GEMINI_API_KEY || '').trim(),
    model: (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim()
  },
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtts://geeae33e.ala.eu-central-1.emqxsl.com:8883',
    clientId: process.env.MQTT_CLIENT_ID || `ElectroNova_Backend_${Math.random().toString(16).slice(2, 8)}`,
    username: process.env.MQTT_USERNAME || '',
    password: process.env.MQTT_PASSWORD || '',
    rejectUnauthorized: process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false',
    deviceId: defaultDeviceId,
    topicCmd: initialTopics.cmd,
    topicState: initialTopics.state,
    topicLwt: initialTopics.lwt,
    buildTopics,
  },
  defaultTariffEgp: parseFloat(process.env.DEFAULT_TARIFF_EGP || '1.25')
};
