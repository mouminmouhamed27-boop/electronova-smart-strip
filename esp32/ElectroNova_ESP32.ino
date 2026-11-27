/*
 * ============================================================
 *  ElectroNova Smart Power Strip — ESP32 Firmware
 *  Broker  : EMQX Cloud (TLS / mqtts port 8883)
 *  Protocol: matches electronova backend exactly
 *
 *  Topics
 *    CMD   electronova/{deviceId}/cmd      ← receive from backend
 *    STATE electronova/{deviceId}/state    → publish telemetry
 *    LWT   electronova/{deviceId}/status   → "online" / "offline"
 *
 *  Commands received (JSON):
 *    {"type":"outlet","id":1,"state":true}
 *    {"type":"all","state":false}
 *    {"type":"sync"}
 *    {"type":"schedule","id":1,"enabled":true,"on":"08:00","off":"23:00"}
 *    {"type":"timer","id":1,"state":true,"delaySec":60}
 *    {"type":"resetEnergy"}
 *
 *  Telemetry published every TELEMETRY_INTERVAL_MS (JSON):
 *    {"temp":32.0,"volts":220,"amps":2.5,"watts":550,
 *     "outlets":[true,false,false,false],
 *     "outletAmps":[0.9,0,0,0],"alert":"OK"}
 *
 *  Simulation note (Wokwi):
 *    - WiFi SSID = "Wokwi-GUEST", PASS = ""
 *    - No TLS in Wokwi (use port 1883 on a plain broker for sim)
 *    - For real hardware → change WiFi creds + use EMQX TLS creds
 * ============================================================
 */

// ── Libraries ──────────────────────────────────────────────
#include <WiFi.h>
#include <WiFiClientSecure.h>   // TLS – for real hardware
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ── Simulation vs Real Hardware switch ─────────────────────
// Comment out the line below when using REAL ESP32 hardware
#define WOKWI_SIMULATION

// ── GPIO Configuration ──────────────────────────────────────
#define RELAY_PIN_1   16
#define RELAY_PIN_2   17
#define RELAY_PIN_3   18
#define RELAY_PIN_4   19

#define SWITCH_PIN_1  25
#define SWITCH_PIN_2  26
#define SWITCH_PIN_3  27
#define SWITCH_PIN_4  32

#define WIFI_LED_PIN  33

// ACS712 analog pins (simulated in Wokwi with potentiometers)
#define ACS_PIN_1     34
#define ACS_PIN_2     35
#define ACS_PIN_3     36
#define ACS_PIN_4     39

// NTC 10K thermistor (pin + 10kΩ pull-down to GND)
#define TEMP_PIN      33   // ADC1_CH5 — change if clash with LED

// Active-LOW relay (most opto-isolated modules)
// In Wokwi the relay is Active-HIGH → swap if LEDs look inverted
#ifdef WOKWI_SIMULATION
  #define RELAY_ON  HIGH
  #define RELAY_OFF LOW
#else
  #define RELAY_ON  LOW
  #define RELAY_OFF HIGH
#endif

// ── Wi-Fi ───────────────────────────────────────────────────
#ifdef WOKWI_SIMULATION
  const char* WIFI_SSID = "Wokwi-GUEST";
  const char* WIFI_PASS = "";
#else
  const char* WIFI_SSID = "YOUR_HOME_WIFI_SSID";   // ← change
  const char* WIFI_PASS = "YOUR_HOME_WIFI_PASS";   // ← change
#endif

// ── EMQX Cloud MQTT ─────────────────────────────────────────
// These creds MUST match your Railway env vars:
//   MQTT_BROKER_URL, MQTT_USERNAME, MQTT_PASSWORD
//
// Find them in: Railway → electronova service → Variables
#ifdef WOKWI_SIMULATION
  // Plain (non-TLS) broker for simulation testing
  // Use test.mosquitto.org or your own unsecured broker
  const char* MQTT_HOST = "test.mosquitto.org";
  const int   MQTT_PORT = 1883;
  const char* MQTT_USER = "";
  const char* MQTT_PASS_STR = "";
#else
  // ← REAL HARDWARE: paste your EMQX credentials here
  const char* MQTT_HOST = "geeae33e.ala.eu-central-1.emqxsl.com";
  const int   MQTT_PORT = 8883;                    // TLS
  const char* MQTT_USER = "";    // ← from Railway env MQTT_USERNAME
  const char* MQTT_PASS_STR = ""; // ← from Railway env MQTT_PASSWORD
#endif

// ── Device ID ────────────────────────────────────────────────
// MUST match MQTT_DEVICE_ID env var on Railway (default: EN_SIM1)
const char* DEVICE_ID = "EN_SIM1";

// ── Derived MQTT topics ──────────────────────────────────────
char TOPIC_CMD[64];    // electronova/EN_SIM1/cmd
char TOPIC_STATE[64];  // electronova/EN_SIM1/state
char TOPIC_LWT[64];    // electronova/EN_SIM1/status

// ── Timing ───────────────────────────────────────────────────
#define TELEMETRY_INTERVAL_MS  2000   // publish telemetry every 2s
#define DEBOUNCE_MS            50
#define RECONNECT_DELAY_MS     5000

// ── Outlet state ─────────────────────────────────────────────
struct Outlet {
  uint8_t  relayPin;
  uint8_t  switchPin;
  uint8_t  acsPin;
  bool     state;
  bool     lastSwitch;
  bool     stableSwitch;
  uint32_t lastDebounce;
};

Outlet outlets[4] = {
  {RELAY_PIN_1, SWITCH_PIN_1, ACS_PIN_1, false, HIGH, HIGH, 0},
  {RELAY_PIN_2, SWITCH_PIN_2, ACS_PIN_2, false, HIGH, HIGH, 0},
  {RELAY_PIN_3, SWITCH_PIN_3, ACS_PIN_3, false, HIGH, HIGH, 0},
  {RELAY_PIN_4, SWITCH_PIN_4, ACS_PIN_4, false, HIGH, HIGH, 0},
};

// ── Energy counters ──────────────────────────────────────────
float totalKWh[4] = {0, 0, 0, 0};
uint32_t lastEnergyMs = 0;

// ── Timer tasks ───────────────────────────────────────────────
struct TimerTask {
  bool     active;
  bool     targetState;
  uint32_t fireAtMs;
};
TimerTask timers[4] = {};

// ── MQTT clients ─────────────────────────────────────────────
#ifdef WOKWI_SIMULATION
  WiFiClient     wifiClient;
  PubSubClient   mqtt(wifiClient);
#else
  WiFiClientSecure secureClient;
  PubSubClient     mqtt(secureClient);
#endif

// ── Timing globals ───────────────────────────────────────────
uint32_t lastTelemetryMs = 0;
uint32_t lastReconnectMs = 0;

// ════════════════════════════════════════════════════════════
//  Hardware helpers
// ════════════════════════════════════════════════════════════

void setOutlet(int idx, bool on) {
  if (idx < 0 || idx > 3) return;
  outlets[idx].state = on;
  digitalWrite(outlets[idx].relayPin, on ? RELAY_ON : RELAY_OFF);
  Serial.printf("[Relay] outlet %d → %s\n", idx + 1, on ? "ON" : "OFF");
}

// Read ACS712 (5A model) amps
// In Wokwi: potentiometer 0–3.3V maps to 0–5A for simulation
float readAmps(int acsPin) {
#ifdef WOKWI_SIMULATION
  int raw = analogRead(acsPin);            // 0–4095
  return (raw / 4095.0f) * 5.0f;          // 0–5 A
#else
  // ACS712-5A: sensitivity 185 mV/A, midpoint 2.5V at 0A
  int raw   = analogRead(acsPin);
  float v   = (raw / 4095.0f) * 3.3f;
  float a   = (v - 1.65f) / 0.185f;       // 1.65V = 2.5V ÷ 2 (voltage divider)
  return max(0.0f, a);
#endif
}

// Read NTC 10K thermistor (Steinhart-Hart)
float readTemp() {
#ifdef WOKWI_SIMULATION
  return 32.0f;   // fixed value in simulation
#else
  int   raw  = analogRead(TEMP_PIN);
  float R    = 10000.0f * ((4095.0f / raw) - 1.0f);
  float logR = log(R / 10000.0f);
  // Steinhart-Hart coefficients for NTC 10K B=3950
  float temp = 1.0f / (0.001129148f + 0.000234125f * logR + 0.0000000876741f * logR * logR * logR);
  return temp - 273.15f;
#endif
}

// ════════════════════════════════════════════════════════════
//  Telemetry publish
// ════════════════════════════════════════════════════════════

void publishTelemetry() {
  float amps[4], watts[4], totalAmps = 0, totalWatts = 0;
  for (int i = 0; i < 4; i++) {
    amps[i]  = outlets[i].state ? readAmps(outlets[i].acsPin) : 0.0f;
    watts[i] = amps[i] * 220.0f;
    totalAmps  += amps[i];
    totalWatts += watts[i];
  }

  // Energy accumulation (kWh)
  uint32_t now = millis();
  if (lastEnergyMs > 0) {
    float hours = (now - lastEnergyMs) / 3600000.0f;
    for (int i = 0; i < 4; i++) totalKWh[i] += (watts[i] * hours) / 1000.0f;
  }
  lastEnergyMs = now;

  float temp = readTemp();
  bool  overheat = (temp >= 70.0f);
  bool  overload = (totalAmps >= 16.0f);

  // Build JSON — matches backend parseTelemetry() exactly
  StaticJsonDocument<512> doc;
  doc["temp"]   = round(temp * 10) / 10.0f;
  doc["volts"]  = 220;
  doc["amps"]   = round(totalAmps * 100) / 100.0f;
  doc["watts"]  = round(totalWatts * 10) / 10.0f;

  JsonArray outArr = doc.createNestedArray("outlets");
  JsonArray ampArr = doc.createNestedArray("outletAmps");
  for (int i = 0; i < 4; i++) {
    outArr.add(outlets[i].state);
    ampArr.add(round(amps[i] * 100) / 100.0f);
  }

  if (overheat)      doc["alert"] = "OVERHEAT";
  else if (overload) doc["alert"] = "OVERLOAD";
  else               doc["alert"] = "OK";

  char buf[512];
  serializeJson(doc, buf);
  mqtt.publish(TOPIC_STATE, buf, false);  // false = NOT retained

  Serial.printf("[Telemetry] T=%.1f V=220 A=%.2f W=%.1f alert=%s\n",
                temp, totalAmps, totalWatts, doc["alert"].as<const char*>());
}

// ════════════════════════════════════════════════════════════
//  MQTT command handler
// ════════════════════════════════════════════════════════════

void onCommand(char* topic, byte* payload, unsigned int len) {
  Serial.printf("[CMD] topic=%s\n", topic);

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, payload, len);
  if (err) {
    Serial.printf("[CMD] JSON error: %s\n", err.c_str());
    return;
  }

  const char* type = doc["type"] | "";

  // ── outlet ──────────────────────────────────────────────
  if (strcmp(type, "outlet") == 0) {
    int  id    = doc["id"] | 0;          // 1-based from backend
    bool state = doc["state"] | false;
    if (id >= 1 && id <= 4) setOutlet(id - 1, state);
    publishTelemetry();                  // immediate feedback
  }

  // ── all ─────────────────────────────────────────────────
  else if (strcmp(type, "all") == 0) {
    bool state = doc["state"] | false;
    for (int i = 0; i < 4; i++) setOutlet(i, state);
    publishTelemetry();
  }

  // ── sync (backend asks for current state) ───────────────
  else if (strcmp(type, "sync") == 0) {
    publishTelemetry();
  }

  // ── schedule ─────────────────────────────────────────────
  else if (strcmp(type, "schedule") == 0) {
    // Schedule is enforced by the backend cronService.
    // The ESP32 just executes the resulting outlet command.
    // No action needed here.
    Serial.println("[CMD] schedule ack (backend handles cron)");
  }

  // ── timer ────────────────────────────────────────────────
  else if (strcmp(type, "timer") == 0) {
    int      id       = doc["id"] | 0;
    bool     tState   = doc["state"] | false;
    uint32_t delaySec = doc["delaySec"] | 0;
    if (id >= 1 && id <= 4) {
      int idx = id - 1;
      if (delaySec > 0) {
        timers[idx] = {true, tState, millis() + delaySec * 1000UL};
        Serial.printf("[Timer] outlet %d → %s in %us\n", id, tState ? "ON" : "OFF", delaySec);
      } else {
        timers[idx].active = false;
        setOutlet(idx, tState);
        publishTelemetry();
      }
    }
  }

  // ── resetEnergy ──────────────────────────────────────────
  else if (strcmp(type, "resetEnergy") == 0) {
    for (int i = 0; i < 4; i++) totalKWh[i] = 0.0f;
    lastEnergyMs = millis();
    Serial.println("[CMD] energy counters reset");
    publishTelemetry();
  }

  else {
    Serial.printf("[CMD] unknown type: %s\n", type);
  }
}

// ════════════════════════════════════════════════════════════
//  MQTT connection
// ════════════════════════════════════════════════════════════

bool connectMQTT() {
  char clientId[32];
  snprintf(clientId, sizeof(clientId), "EN_ESP_%06lX", (uint32_t)esp_random());

  Serial.printf("[MQTT] connecting to %s:%d as %s ...\n", MQTT_HOST, MQTT_PORT, clientId);

  bool ok;
  if (strlen(MQTT_USER) > 0) {
    ok = mqtt.connect(clientId, MQTT_USER, MQTT_PASS_STR,
                      TOPIC_LWT, 1, false, "offline");
  } else {
    ok = mqtt.connect(clientId, nullptr, nullptr,
                      TOPIC_LWT, 1, false, "offline");
  }

  if (!ok) {
    Serial.printf("[MQTT] failed, rc=%d\n", mqtt.state());
    return false;
  }

  // Announce online (NOT retained — backend guards against retained)
  mqtt.publish(TOPIC_LWT, "online", false);

  // Subscribe to commands
  mqtt.subscribe(TOPIC_CMD);
  Serial.printf("[MQTT] connected. Subscribed: %s\n", TOPIC_CMD);
  return true;
}

// ════════════════════════════════════════════════════════════
//  Manual switch debounce loop
// ════════════════════════════════════════════════════════════

void checkSwitches() {
  for (int i = 0; i < 4; i++) {
    bool reading = digitalRead(outlets[i].switchPin);
    if (reading != outlets[i].lastSwitch) {
      outlets[i].lastDebounce = millis();
    }
    outlets[i].lastSwitch = reading;

    if ((millis() - outlets[i].lastDebounce) > DEBOUNCE_MS) {
      if (reading != outlets[i].stableSwitch) {
        outlets[i].stableSwitch = reading;
        // LOW = button pressed (pull-up)
        if (reading == LOW) {
          setOutlet(i, !outlets[i].state);
          publishTelemetry();
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
//  Timer task checker
// ════════════════════════════════════════════════════════════

void checkTimers() {
  for (int i = 0; i < 4; i++) {
    if (timers[i].active && millis() >= timers[i].fireAtMs) {
      timers[i].active = false;
      setOutlet(i, timers[i].targetState);
      publishTelemetry();
    }
  }
}

// ════════════════════════════════════════════════════════════
//  setup()
// ════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== ElectroNova ESP32 Firmware ===");

  // Build topic strings from DEVICE_ID
  snprintf(TOPIC_CMD,   sizeof(TOPIC_CMD),   "electronova/%s/cmd",    DEVICE_ID);
  snprintf(TOPIC_STATE, sizeof(TOPIC_STATE), "electronova/%s/state",  DEVICE_ID);
  snprintf(TOPIC_LWT,   sizeof(TOPIC_LWT),   "electronova/%s/status", DEVICE_ID);

  // GPIO setup
  pinMode(WIFI_LED_PIN, OUTPUT);
  digitalWrite(WIFI_LED_PIN, LOW);

  for (int i = 0; i < 4; i++) {
    // Write level BEFORE setting mode to avoid boot glitch
    digitalWrite(outlets[i].relayPin, RELAY_OFF);
    pinMode(outlets[i].relayPin,  OUTPUT);
    pinMode(outlets[i].switchPin, INPUT_PULLUP);
  }

  // Wi-Fi
  Serial.printf("[WiFi] connecting to %s ...\n", WIFI_SSID);
#ifdef WOKWI_SIMULATION
  WiFi.begin(WIFI_SSID, WIFI_PASS, 6);   // channel 6 speeds Wokwi
#else
  WiFi.begin(WIFI_SSID, WIFI_PASS);
#endif

  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 15000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] connected. IP: %s\n", WiFi.localIP().toString().c_str());
    digitalWrite(WIFI_LED_PIN, HIGH);
  } else {
    Serial.println("\n[WiFi] FAILED — will retry in loop");
  }

#ifndef WOKWI_SIMULATION
  // TLS: skip certificate verification (acceptable for a lab project)
  // For production: load the EMQX CA cert with secureClient.setCACert(...)
  secureClient.setInsecure();
#endif

  // MQTT setup
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(10);
  mqtt.setBufferSize(512);
  mqtt.setCallback(onCommand);

  connectMQTT();
}

// ════════════════════════════════════════════════════════════
//  loop()
// ════════════════════════════════════════════════════════════

void loop() {
  // ── Wi-Fi watchdog ──────────────────────────────────────
  if (WiFi.status() != WL_CONNECTED) {
    digitalWrite(WIFI_LED_PIN, LOW);
    Serial.println("[WiFi] reconnecting ...");
    WiFi.reconnect();
    delay(5000);
    return;
  }

  // ── MQTT reconnect (non-blocking) ───────────────────────
  if (!mqtt.connected()) {
    uint32_t now = millis();
    if (now - lastReconnectMs >= RECONNECT_DELAY_MS) {
      lastReconnectMs = now;
      connectMQTT();
    }
  } else {
    mqtt.loop();   // process incoming messages
  }

  // ── Periodic telemetry ──────────────────────────────────
  if (millis() - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = millis();
    if (mqtt.connected()) publishTelemetry();
  }

  // ── Manual switches ─────────────────────────────────────
  checkSwitches();

  // ── Timers ──────────────────────────────────────────────
  checkTimers();
}
