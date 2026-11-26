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

module.exports = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  timezone: process.env.TZ || process.env.APP_TIMEZONE || 'Africa/Cairo',
  jwtSecret: process.env.JWT_SECRET || 'dev_secret_key_123',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
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
