/*
 * ============================================================================
 *  ElectroNova Smart Power Strip — Unified Production Firmware v3.0.0
 * ============================================================================
 *  Architecture (Single Source of Truth = Railway Node.js Backend):
 *    - Transport  : Secure WebSocket (WSS Port 443) to /ws/device
 *                   (Never blocked by WE / University / Home Wi-Fi routers!)
 *    - Zero Secrets: No Smartnest credentials or API keys inside firmware!
 *                    Backend securely bridges Google Assistant, Alexa & Mobile App.
 *    - Sensors    : 4x ACS712-20A Current Sensors (1 per outlet, ADC1 GPIO 34/35/36/39)
 *                   with 10k/20k voltage divider correction (ADC_DIVIDER_RATIO = 0.6667)
 *                 : 1x DS18B20 Temperature Sensor (GPIO 4 + 4.7k pull-up)
 *    - Switches   : 4x TTP223 Touch Sensors (GPIO 25, 26, 27, 32)
 *    - Relays     : 4x Relays (GPIO 13, 21, 19, 22)
 *    - Local Alert: Red Fault LED (GPIO 23) + Buzzer (GPIO 18) + WiFi LED (GPIO 33)
 *    - Safety     : 16A Total Limit | 10A Max Per-Relay | 65C Thermal Trip (<58C Reset)
 *                   3-Trip Overcurrent Latch | Disconnected Sensor Fault Trip
 *                   Boot Sensor Self-Test | Staged Power Restore (500ms step)
 *                   Task Watchdog (10s) | Password-Protected SoftAP (192.168.4.1)
 *                   Last Trip Reason & kWh Saved in NVS | NTP Clock | HTTPS OTA
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebSocketsClient.h>
#include <WebServer.h>
#include <HTTPUpdate.h>
#include <ArduinoOTA.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <time.h>
#include <esp_task_wdt.h>
#include <math.h>

// ── Simulation vs Real Hardware Toggle ──────────────────────────────────────
// 0 = Real ESP32 Hardware | 1 = Wokwi Simulation (potentiometers + simulated temp)
#define WOKWI_SIMULATION 0

// ── Hardware Pin Map (ESP32 DevKit 30/38-pin, zero ADC2/strapping clashes) ──
const uint8_t RELAY_PINS[4]  = { 13, 21, 19, 22 }; // Clean outputs
const uint8_t SWITCH_PINS[4] = { 25, 26, 27, 32 }; // 4x TTP223 Touch (Active-HIGH in real HW)
const uint8_t ACS_PINS[4]    = { 34, 35, 36, 39 }; // 4x Pure ADC1 inputs (safe during Wi-Fi!)

#define TEMP_SENSOR_PIN 4   // DS18B20 Data (requires 4.7k pull-up resistor to 3.3V)
#define WIFI_LED_PIN    33  // Blue status LED (solid=connected, blink=connecting, fast=SoftAP)
#define FAULT_LED_PIN   23  // Red Fault LED (ON whenever thermal/overload/sensor lock active)
#define BUZZER_PIN      18  // Local audible alert buzzer
#define RESET_BTN_PIN   0   // Onboard BOOT button: hold 5s for factory reset / re-provision

// ── Relay Polarity ──────────────────────────────────────────────────────────
#if WOKWI_SIMULATION
  #define RELAY_ON  HIGH
  #define RELAY_OFF LOW
  #define SWITCH_ACTIVE_LEVEL LOW
#else
  #define RELAY_ON  LOW     // Opto-isolated 4-Channel Relay Modules are Active-LOW
  #define RELAY_OFF HIGH
  #define SWITCH_ACTIVE_LEVEL HIGH // TTP223 outputs HIGH when touched
#endif

// ── Protection & Measurement Thresholds ─────────────────────────────────────
#define MAX_TOTAL_AMPS         16.0f   // Total power strip cutoff (16A)
#define MAX_OUTLET_AMPS        10.0f   // Single SRD-05VDC-SL-C relay max limit (10A)
#define ACS712_SENSITIVITY     0.100f  // 0.100 V/A for ACS712-20A (use 0.066f for 30A, 0.185f for 5A)
#define ADC_DIVIDER_RATIO      0.6667f // 10k / 20k voltage divider: V_adc = V_sensor * 20 / (10 + 20)
#define LINE_VOLTAGE_V         220.0f
#define OVERCURRENT_STREAK_REQ 2
#define OVERCURRENT_COOLDOWN   5000UL
#define MAX_OVERCURRENT_TRIPS  3
#define TRIP_WINDOW_MS         600000UL // Reset trip counter after 10 stable minutes
#define SENSOR_FAULT_LIMIT     3

#define TEMP_WARN_C            58.0f   // Release thermal lockout below 58C
#define TEMP_DANGER_C          65.0f   // Shutdown all relays >= 65C
#define TEMP_OVERHEAT_STREAK   3

#define DEBOUNCE_MS            45UL
#define SENSOR_SAMPLE_MS       1000UL
#define TELEMETRY_INTERVAL_MS  2000UL
#define ENERGY_SAVE_INTERVAL   60000UL // Persist kWh every 60s to protect Flash wear
#define RESTORE_STEP_MS        500UL
#define WIFI_WATCHDOG_MS       30000UL
#define RESET_HOLD_MS          5000UL
#define WDT_TIMEOUT_SEC        10

// ── Backend Server Connection (Port 443 WSS — never blocked!) ───────────────
const char* FIRMWARE_VERSION = "3.0.0-unified";
const char* WS_HOST          = "electronova-smart-strip.up.railway.app";
const uint16_t WS_PORT       = 443;
const char* DEFAULT_DEVICE_ID = "EN_SIM1";

// Set DEVICE_AUTH_TOKEN to match Railway env var if enabled (empty = open registration)
const char* DEFAULT_DEVICE_TOKEN = "";

// Default Wi-Fi (used in Wokwi or fallback; overridden by SoftAP / NVS on real ESP32)
#if WOKWI_SIMULATION
  const char* DEFAULT_WIFI_SSID = "Wokwi-GUEST";
  const char* DEFAULT_WIFI_PASS = "";
#else
  const char* DEFAULT_WIFI_SSID = "";
  const char* DEFAULT_WIFI_PASS = "";
#endif

// Secured SoftAP password (Critical #7 fixed: provisioning AP is WPA2-protected!)
const char* SOFTAP_PASSWORD = "ElectroNova@2026";

// NTP Cairo (UTC+2)
const long  GMT_OFFSET_SEC = 2 * 3600;
const int   DST_OFFSET_SEC = 0;

// ── Runtime Config (Loaded from NVS Preferences) ────────────────────────────
Preferences prefs;
char cfgWifiSsid[64]    = "";
char cfgWifiPass[64]    = "";
char cfgDeviceId[65]    = "EN_SIM1";
char cfgDeviceToken[96] = "";
char apSsid[32]         = "ElectroNova-Setup";

// ── State Structures ────────────────────────────────────────────────────────
struct OutletState {
  bool     on;
  float    amps;
  float    kwh;
  bool     lastSwitch;
  bool     stableSwitch;
  uint32_t lastDebounceMs;
};

struct TimerTask {
  bool     active;
  bool     targetState;
  uint32_t executeAtMs;
};

struct ScheduleRule {
  bool    enabled;
  uint8_t onHour;
  uint8_t onMin;
  uint8_t offHour;
  uint8_t offMin;
  int32_t lastOnBucket;
  int32_t lastOffBucket;
};

OutletState  outlets[4];
TimerTask    timers[4];
ScheduleRule schedules[4];
bool         pendingRestore[4] = { false, false, false, false };

float totalAmps          = 0.0f;
float totalWatts         = 0.0f;
float totalKwh           = 0.0f;
float currentTempC       = 25.0f;
bool  tempInitialized    = false;

bool  bootChecksPassed   = false;
bool  thermalCutActive   = false;
bool  overcurrentActive  = false;
bool  overcurrentLatched = false;
bool  tempSensorFault    = false;
bool  currentSensorFault = false;

uint8_t  overcurrentTrips   = 0;
uint8_t  overheatStreak     = 0;
uint8_t  overcurrentStreak  = 0;
uint8_t  tempFaultStreak    = 0;
uint8_t  tempGoodStreak     = 0;
uint8_t  currFaultStreak    = 0;
uint8_t  currGoodStreak     = 0;
uint32_t overcurrentTripMs  = 0;
uint32_t lastTripEpochMs    = 0;
char     lastTripReason[32] = "NONE";

// ── Networking & Sensors ────────────────────────────────────────────────────
WebSocketsClient webSocket;
WebServer        provisionServer(80);
OneWire          oneWire(TEMP_SENSOR_PIN);
DallasTemperature tempSensor(&oneWire);

bool     wsConnected       = false;
bool     provisioningMode  = false;
bool     shouldReboot      = false;
bool     telemetryDirty    = false;
uint32_t rebootAtMs        = 0;
uint32_t resetPressStartMs = 0;
uint32_t lastSampleMs      = 0;
uint32_t lastTelemetryMs   = 0;
uint32_t lastRestoreMs     = 0;
uint32_t lastEnergySaveMs  = 0;
uint32_t lastWifiRetryMs   = 0;
uint32_t lastLedToggleMs   = 0;
bool     wifiLedState      = false;

char pendingSrc[16]        = "hb";
char pendingOtaUrl[256]    = "";
bool pendingOtaRequested   = false;

// ════════════════════════════════════════════════════════════════════════════
//  Hardware Alerts (Buzzer & Fault LED)
// ════════════════════════════════════════════════════════════
void beepAlert(int count, int onMs, int offMs) {
  for (int i = 0; i < count; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(onMs);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < count - 1) delay(offMs);
  }
}

bool isSystemLocked() {
  return thermalCutActive || overcurrentActive || overcurrentLatched ||
         tempSensorFault || currentSensorFault;
}

void updateFaultIndicators() {
  digitalWrite(FAULT_LED_PIN, isSystemLocked() ? HIGH : LOW);
}

void updateStatusLed() {
  uint32_t now = millis();
  if (provisioningMode) {
    if (now - lastLedToggleMs >= 180) {
      lastLedToggleMs = now;
      wifiLedState = !wifiLedState;
      digitalWrite(WIFI_LED_PIN, wifiLedState);
    }
    return;
  }
  if (WiFi.status() == WL_CONNECTED && wsConnected) {
    digitalWrite(WIFI_LED_PIN, HIGH);
    return;
  }
  if (now - lastLedToggleMs >= 500) {
    lastLedToggleMs = now;
    wifiLedState = !wifiLedState;
    digitalWrite(WIFI_LED_PIN, wifiLedState);
  }
}

// ════════════════════════════════════════════════════════════
//  NVS Persistence (Zero heap fragmentation)
// ════════════════════════════════════════════════════════════
void loadNVS() {
  prefs.begin("electronova", true);

  String s = prefs.getString("ssid", DEFAULT_WIFI_SSID);
  String p = prefs.getString("pass", DEFAULT_WIFI_PASS);
  String d = prefs.getString("devId", DEFAULT_DEVICE_ID);
  String t = prefs.getString("devTok", DEFAULT_DEVICE_TOKEN);
  String tr = prefs.getString("trip", "NONE");

  strlcpy(cfgWifiSsid, s.c_str(), sizeof(cfgWifiSsid));
  strlcpy(cfgWifiPass, p.c_str(), sizeof(cfgWifiPass));
  strlcpy(cfgDeviceId, d.length() ? d.c_str() : DEFAULT_DEVICE_ID, sizeof(cfgDeviceId));
  strlcpy(cfgDeviceToken, t.c_str(), sizeof(cfgDeviceToken));
  strlcpy(lastTripReason, tr.c_str(), sizeof(lastTripReason));

  for (int i = 0; i < 4; i++) {
    char keyR[8], keyK[8], keySch[8];
    snprintf(keyR, sizeof(keyR), "r%d", i);
    snprintf(keyK, sizeof(keyK), "k%d", i);
    snprintf(keySch, sizeof(keySch), "s%d", i);

    outlets[i].on  = prefs.getBool(keyR, false);
    outlets[i].kwh = prefs.getFloat(keyK, 0.0f);
    totalKwh += outlets[i].kwh;

    String schStr = prefs.getString(keySch, "0,08:00,23:00");
    int en = 0, onH = 8, onM = 0, offH = 23, offM = 0;
    sscanf(schStr.c_str(), "%d,%d:%d,%d:%d", &en, &onH, &onM, &offH, &offM);
    schedules[i] = { en != 0, (uint8_t)onH, (uint8_t)onM, (uint8_t)offH, (uint8_t)offM, -1, -1 };
  }
  prefs.end();
}

void saveRelayNVS(int idx, bool state) {
  char key[8];
  snprintf(key, sizeof(key), "r%d", idx);
  prefs.begin("electronova", false);
  prefs.putBool(key, state);
  prefs.end();
}

void saveTripReasonNVS(const char* reason) {
  strlcpy(lastTripReason, reason, sizeof(lastTripReason));
  prefs.begin("electronova", false);
  prefs.putString("trip", lastTripReason);
  prefs.end();
}

void saveEnergyNVS() {
  prefs.begin("electronova", false);
  for (int i = 0; i < 4; i++) {
    char keyK[8];
    snprintf(keyK, sizeof(keyK), "k%d", i);
    prefs.putFloat(keyK, outlets[i].kwh);
  }
  prefs.end();
}

void saveScheduleNVS(int idx) {
  char keySch[8], buf[24];
  snprintf(keySch, sizeof(keySch), "s%d", idx);
  snprintf(buf, sizeof(buf), "%d,%02u:%02u,%02u:%02u",
           schedules[idx].enabled ? 1 : 0,
           schedules[idx].onHour, schedules[idx].onMin,
           schedules[idx].offHour, schedules[idx].offMin);
  prefs.begin("electronova", false);
  prefs.putString(keySch, buf);
  prefs.end();
}

// ════════════════════════════════════════════════════════════
//  Relay Control
// ════════════════════════════════════════════════════════════
void setRelayState(int idx, bool state, const char* src, bool persist = true) {
  if (idx < 0 || idx >= 4) return;
  pendingRestore[idx] = false;

  if (state && isSystemLocked()) {
    Serial.printf("[SAFETY] Blocked Outlet %d ON (trip=%s)\n", idx + 1, lastTripReason);
    beepAlert(2, 60, 60);
    strlcpy(pendingSrc, "prot", sizeof(pendingSrc));
    telemetryDirty = true;
    return;
  }

  outlets[idx].on = state;
  digitalWrite(RELAY_PINS[idx], state ? RELAY_ON : RELAY_OFF);
  if (!state) outlets[idx].amps = 0.0f;
  if (persist) saveRelayNVS(idx, state);

  strlcpy(pendingSrc, src, sizeof(pendingSrc));
  telemetryDirty = true;
  Serial.printf("[RELAY] Outlet %d -> %s (%s)\n", idx + 1, state ? "ON" : "OFF", src);
}

void cutAllRelays(const char* src, const char* tripReason = nullptr) {
  for (int i = 0; i < 4; i++) {
    pendingRestore[i] = false;
    outlets[i].on = false;
    outlets[i].amps = 0.0f;
    digitalWrite(RELAY_PINS[i], RELAY_OFF);
    saveRelayNVS(i, false);
  }
  if (tripReason) saveTripReasonNVS(tripReason);
  strlcpy(pendingSrc, src, sizeof(pendingSrc));
  telemetryDirty = true;
  updateFaultIndicators();
}

// ════════════════════════════════════════════════════════════
//  Sensors: 4x ACS712 True RMS + 1x DS18B20 (Fail-Safe!)
// ════════════════════════════════════════════════════════════
float readDS18B20TempC() {
#if WOKWI_SIMULATION
  int onCount = 0;
  for (int i = 0; i < 4; i++) if (outlets[i].on) onCount++;
  return 27.5f + onCount * 2.5f;
#else
  float t = tempSensor.getTempCByIndex(0);
  tempSensor.requestTemperatures(); // Non-blocking async trigger for next cycle
  if (t == DEVICE_DISCONNECTED_C) return NAN;
  if (t < -20.0f || t > 125.0f) return NAN;
  if (fabsf(t - 85.0f) < 0.01f) return NAN; // Ignore DS18B20 85C power-on default (Medium #6)
  return t;
#endif
}

// Returns >= 0.0f on valid sensor reading, or -1.0f on disconnected/faulty ACS712
float readACS712OutletAmps(int idx) {
  uint8_t pin = ACS_PINS[idx];
#if WOKWI_SIMULATION
  int raw = analogRead(pin);
  return outlets[idx].on ? (raw / 4095.0f) * 6.0f : 0.0f;
#else
  const int maxSamples = 250; // ~2 cycles (40ms at 50Hz)
  static float vBuf[maxSamples];
  uint32_t startMs = millis();
  int count = 0;
  double sumV = 0.0;

  while (millis() - startMs < 40 && count < maxSamples) {
    float v = analogReadMilliVolts(pin) / 1000.0f;
    vBuf[count++] = v;
    sumV += v;
    delayMicroseconds(140);
  }
  if (count < 20) return -1.0f;

  // Midpoint after 10k/20k divider should be ~1.67V (half of 5V * 2/3)
  float vMean = (float)(sumV / count);
  if (vMean < 1.10f || vMean > 2.20f) {
    return -1.0f; // Critical #5: Missing 5V or unplugged ACS712 -> Sensor Fault!
  }

  double sumSq = 0.0;
  for (int i = 0; i < count; i++) {
    float diff = vBuf[i] - vMean;
    sumSq += (double)(diff * diff);
  }
  float vRmsPin    = sqrt(sumSq / count);
  float vRmsSensor = vRmsPin / ADC_DIVIDER_RATIO; // Critical #2 fix
  float amps       = vRmsSensor / ACS712_SENSITIVITY;
  return (amps < 0.12f) ? 0.0f : amps;
#endif
}

bool runBootSelfTest() {
  Serial.println("[BOOT] Running sensor self-test...");
  delay(200);
#if !WOKWI_SIMULATION
  tempSensor.requestTemperatures();
  delay(800);
#endif
  float t = readDS18B20TempC();
  bool tempOk = !isnan(t);
  bool currOk = true;
  for (int i = 0; i < 4; i++) {
    if (readACS712OutletAmps(i) < 0.0f) {
      currOk = false;
      Serial.printf("[BOOT] ACS712 #%d check failed!\n", i + 1);
    }
  }
  if (!tempOk) {
    tempSensorFault = true;
    Serial.println("[BOOT] DS18B20 temp sensor missing/fault!");
  }
  if (!currOk) {
    currentSensorFault = true;
    Serial.println("[BOOT] One or more ACS712 sensors missing/fault!");
  }
  if (tempOk && currOk) {
    currentTempC = t;
    tempInitialized = true;
    bootChecksPassed = true;
    Serial.println("[BOOT] Sensor self-test PASSED.");
    beepAlert(1, 80, 0);
    return true;
  }
  saveTripReasonNVS("SENSOR_FAULT");
  updateFaultIndicators();
  beepAlert(3, 120, 80);
  return false;
}

void evaluateSensorsAndProtection() {
  uint32_t now = millis();
  if (now - lastSampleMs < SENSOR_SAMPLE_MS) return;
  float dtHours = (now - lastSampleMs) / 3600000.0f;
  lastSampleMs = now;

  // 1) Read all 4 ACS712 Current Sensors
  float sumA = 0.0f;
  bool allCurrValid = true;
  float newAmps[4] = { 0, 0, 0, 0 };

  for (int i = 0; i < 4; i++) {
    float a = readACS712OutletAmps(i);
    if (a < 0.0f) {
      allCurrValid = false;
    } else {
      newAmps[i] = outlets[i].on ? a : 0.0f;
      sumA += newAmps[i];
    }
  }

  if (!allCurrValid) {
    currGoodStreak = 0;
    if (currFaultStreak < 100) currFaultStreak++;
    if (currFaultStreak >= SENSOR_FAULT_LIMIT && !currentSensorFault) {
      currentSensorFault = true;
      Serial.println("[FAULT] Current sensor disconnected! Cutting all relays.");
      cutAllRelays("prot", "SENSOR_FAULT");
      beepAlert(3, 180, 100);
    }
  } else {
    currFaultStreak = 0;
    if (currentSensorFault) {
      if (++currGoodStreak >= SENSOR_FAULT_LIMIT) {
        currentSensorFault = false;
        currGoodStreak = 0;
        Serial.println("[OK] All 4 ACS712 sensors recovered.");
        telemetryDirty = true;
        updateFaultIndicators();
      }
    }

    for (int i = 0; i < 4; i++) {
      outlets[i].amps = newAmps[i];
      if (outlets[i].on && outlets[i].amps > MAX_OUTLET_AMPS) {
        Serial.printf("[SAFETY] Outlet %d exceeded 10A relay limit (%.2fA)! Cutting outlet.\n", i + 1, outlets[i].amps);
        setRelayState(i, false, "prot", true);
        saveTripReasonNVS("OUTLET_OVERCURRENT");
        beepAlert(2, 150, 80);
      }
      if (outlets[i].on && outlets[i].amps > 0.0f && dtHours > 0.0f && dtHours < 0.05f) {
        outlets[i].kwh += ((outlets[i].amps * LINE_VOLTAGE_V) * dtHours) / 1000.0f;
      }
    }

    totalAmps = sumA;
    totalWatts = totalAmps * LINE_VOLTAGE_V;
    totalKwh = outlets[0].kwh + outlets[1].kwh + outlets[2].kwh + outlets[3].kwh;

    // Total 16A protection with 3-trip Latch Lockout (Critical #3 fix)
    if (totalAmps > MAX_TOTAL_AMPS) {
      if (overcurrentStreak < 100) overcurrentStreak++;
      if (overcurrentStreak >= OVERCURRENT_STREAK_REQ && !overcurrentActive && !overcurrentLatched) {
        if (overcurrentTrips > 0 && now - lastTripEpochMs > TRIP_WINDOW_MS) {
          overcurrentTrips = 0;
        }
        overcurrentTrips++;
        lastTripEpochMs = now;
        overcurrentActive = true;
        overcurrentTripMs = now;
        if (overcurrentTrips >= MAX_OVERCURRENT_TRIPS) {
          overcurrentLatched = true;
        }
        Serial.printf("[OVERCURRENT TRIP %d/%d] %.2fA > %.1fA!\n", overcurrentTrips, MAX_OVERCURRENT_TRIPS, totalAmps, MAX_TOTAL_AMPS);
        cutAllRelays("prot", overcurrentLatched ? "OVERCURRENT_LATCHED" : "OVERLOAD");
        totalAmps = 0.0f;
        totalWatts = 0.0f;
        beepAlert(overcurrentLatched ? 5 : 3, 200, 100);
      }
    } else {
      overcurrentStreak = 0;
    }

    if (overcurrentActive && !overcurrentLatched && (now - overcurrentTripMs >= OVERCURRENT_COOLDOWN)) {
      overcurrentActive = false;
      telemetryDirty = true;
      updateFaultIndicators();
      Serial.println("[OVERCURRENT] Cooldown elapsed.");
    }
  }

  // 2) Read DS18B20 Temperature Sensor
  float measuredTemp = readDS18B20TempC();
  if (isnan(measuredTemp)) {
    tempGoodStreak = 0;
    if (tempFaultStreak < 100) tempFaultStreak++;
    if (tempFaultStreak >= SENSOR_FAULT_LIMIT && !tempSensorFault) {
      tempSensorFault = true;
      Serial.println("[FAULT] DS18B20 temperature sensor disconnected! Cutting all relays.");
      cutAllRelays("prot", "SENSOR_FAULT");
      beepAlert(3, 180, 100);
    }
  } else {
    tempFaultStreak = 0;
    if (tempSensorFault) {
      if (++tempGoodStreak >= SENSOR_FAULT_LIMIT) {
        tempSensorFault = false;
        tempGoodStreak = 0;
        tempInitialized = false;
        telemetryDirty = true;
        updateFaultIndicators();
      }
    }

    if (!tempInitialized) {
      currentTempC = measuredTemp;
      tempInitialized = true;
    } else {
      currentTempC = (currentTempC * 0.6f) + (measuredTemp * 0.4f);
    }

    if (currentTempC >= TEMP_DANGER_C) {
      if (++overheatStreak >= TEMP_OVERHEAT_STREAK && !thermalCutActive) {
        thermalCutActive = true;
        Serial.printf("[THERMAL TRIP] %.1fC >= %.1fC! Emergency shutdown.\n", currentTempC, TEMP_DANGER_C);
        cutAllRelays("prot", "OVERHEAT");
        beepAlert(4, 250, 100);
      }
    } else {
      overheatStreak = 0;
      if (thermalCutActive && currentTempC < TEMP_WARN_C) {
        thermalCutActive = false;
        telemetryDirty = true;
        updateFaultIndicators();
        Serial.println("[THERMAL] Cooled down below 58C; lock released.");
      }
    }
  }

  if (!bootChecksPassed && allCurrValid && !isnan(measuredTemp) && !currentSensorFault && !tempSensorFault) {
    bootChecksPassed = true;
  }

  if (now - lastEnergySaveMs >= ENERGY_SAVE_INTERVAL) {
    lastEnergySaveMs = now;
    saveEnergyNVS();
  }
}

// ════════════════════════════════════════════════════════════
//  NTP Time + Local Schedules + Non-Blocking Timers
// ════════════════════════════════════════════════════════════
bool getCairoClock(char* outBuf, size_t outLen, int32_t& bucketOut, uint8_t& hourOut, uint8_t& minOut) {
  struct tm ti;
  if (!getLocalTime(&ti, 5)) {
    strlcpy(outBuf, "--:--:--", outLen);
    bucketOut = -1;
    return false;
  }
  snprintf(outBuf, outLen, "%02d:%02d:%02d", ti.tm_hour, ti.tm_min, ti.tm_sec);
  hourOut = (uint8_t)ti.tm_hour;
  minOut  = (uint8_t)ti.tm_min;
  bucketOut = ((ti.tm_year + 1900) * 1000000L) + ((ti.tm_mon + 1) * 10000L) + (ti.tm_mday * 100L) + ti.tm_hour;
  bucketOut = bucketOut * 60L + ti.tm_min;
  return true;
}

void processLocalSchedulesAndTimers() {
  uint32_t now = millis();
  for (int i = 0; i < 4; i++) {
    if (timers[i].active && (int32_t)(now - timers[i].executeAtMs) >= 0) {
      timers[i].active = false;
      setRelayState(i, timers[i].targetState, "timer", true);
    }
  }

  char clk[12];
  int32_t bucket = -1;
  uint8_t h = 0, m = 0;
  if (!getCairoClock(clk, sizeof(clk), bucket, h, m) || bucket < 0) return;

  for (int i = 0; i < 4; i++) {
    if (!schedules[i].enabled) continue;
    if (h == schedules[i].onHour && m == schedules[i].onMin && schedules[i].lastOnBucket != bucket) {
      schedules[i].lastOnBucket = bucket;
      if (!outlets[i].on && !isSystemLocked()) setRelayState(i, true, "sch", true);
    }
    if (h == schedules[i].offHour && m == schedules[i].offMin && schedules[i].lastOffBucket != bucket) {
      schedules[i].lastOffBucket = bucket;
      if (outlets[i].on) setRelayState(i, false, "sch", true);
    }
  }
}

void processStagedRestore() {
  if (!bootChecksPassed || isSystemLocked()) return;
  if (millis() - lastRestoreMs < RESTORE_STEP_MS) return;
  for (int i = 0; i < 4; i++) {
    if (pendingRestore[i]) {
      lastRestoreMs = millis();
      setRelayState(i, true, "boot", false);
      return;
    }
  }
}

void handleTouchSwitches() {
  uint32_t now = millis();
  for (int i = 0; i < 4; i++) {
    bool reading = digitalRead(SWITCH_PINS[i]);
    if (reading != outlets[i].lastSwitch) {
      outlets[i].lastDebounceMs = now;
      outlets[i].lastSwitch = reading;
    }
    if ((now - outlets[i].lastDebounceMs) >= DEBOUNCE_MS && reading != outlets[i].stableSwitch) {
      outlets[i].stableSwitch = reading;
      if (reading == SWITCH_ACTIVE_LEVEL) {
        setRelayState(i, !outlets[i].on, "btn", true);
      }
    }
  }
}

// ════════════════════════════════════════════════════════════
//  Telemetry JSON Push over WebSocket Port 443
// ════════════════════════════════════════════════════════════
void sendTelemetry() {
  if (!wsConnected) return;

  char clk[12];
  int32_t dummyBucket;
  uint8_t dh, dm;
  bool ntpOk = getCairoClock(clk, sizeof(clk), dummyBucket, dh, dm);

  JsonDocument doc;
  doc["type"]               = "telemetry";
  doc["src"]                = pendingSrc;
  doc["tm"]                 = clk;
  doc["ntp"]                = ntpOk;
  doc["temp"]               = roundf(currentTempC * 10.0f) / 10.0f;
  doc["volts"]              = (int)LINE_VOLTAGE_V;
  doc["amps"]               = roundf(totalAmps * 100.0f) / 100.0f;
  doc["watts"]              = (int)roundf(totalWatts);
  doc["kwh"]                = roundf(totalKwh * 1000.0f) / 1000.0f;
  doc["rssi"]               = WiFi.RSSI();
  doc["ip"]                 = WiFi.localIP().toString();
  doc["firmwareVersion"]    = FIRMWARE_VERSION;
  doc["bootSelfTest"]       = bootChecksPassed;
  doc["sensorFault"]        = (tempSensorFault || currentSensorFault);
  doc["tempSensorFault"]    = tempSensorFault;
  doc["currentSensorFault"] = currentSensorFault;
  doc["thermalCut"]         = thermalCutActive;
  doc["overcurrentLatched"] = overcurrentLatched;
  doc["overcurrentTrips"]   = overcurrentTrips;
  doc["lastTripReason"]     = strcmp(lastTripReason, "NONE") == 0 ? nullptr : lastTripReason;

  if (tempSensorFault || currentSensorFault) doc["alert"] = "SENSOR_FAULT";
  else if (overcurrentLatched)               doc["alert"] = "OVERCURRENT_LATCHED";
  else if (thermalCutActive)                 doc["alert"] = "OVERHEAT";
  else if (overcurrentActive || totalAmps > MAX_TOTAL_AMPS) doc["alert"] = "OVERLOAD";
  else                                       doc["alert"] = "OK";

  JsonArray outArr = doc["outlets"].to<JsonArray>();
  JsonArray ampArr = doc["outletAmps"].to<JsonArray>();
  JsonArray kwhArr = doc["outletKwh"].to<JsonArray>();
  for (int i = 0; i < 4; i++) {
    outArr.add(outlets[i].on);
    ampArr.add(roundf(outlets[i].amps * 100.0f) / 100.0f);
    kwhArr.add(roundf(outlets[i].kwh * 1000.0f) / 1000.0f);
  }

  char jsonBuf[1024];
  size_t len = serializeJson(doc, jsonBuf, sizeof(jsonBuf));
  webSocket.sendTXT(jsonBuf, len);
  strlcpy(pendingSrc, "hb", sizeof(pendingSrc));
  telemetryDirty = false;
}

// ════════════════════════════════════════════════════════════
//  HTTPS OTA Update (Port 443 — Missing Feature #4)
// ════════════════════════════════════════════════════════════
void performHttpsOta() {
  if (!pendingOtaRequested || strlen(pendingOtaUrl) < 10) return;
  pendingOtaRequested = false;

  Serial.printf("[OTA] Starting HTTPS firmware pull: %s\n", pendingOtaUrl);
  cutAllRelays("prot", nullptr);
  saveEnergyNVS();

  WiFiClientSecure otaClient;
  otaClient.setInsecure();
  esp_task_wdt_reset();

  t_httpUpdate_return ret = httpUpdate.update(otaClient, pendingOtaUrl);
  if (ret == HTTP_UPDATE_FAILED) {
    Serial.printf("[OTA] Failed (%d): %s\n", httpUpdate.getLastError(), httpUpdate.getLastErrorString().c_str());
  }
}

// ════════════════════════════════════════════════════════════
//  Incoming Backend Commands over /ws/device
// ════════════════════════════════════════════════════════════
void handleBackendCommand(uint8_t* payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;

  const char* type = doc["type"] | "";

  if (strcmp(type, "outlet") == 0) {
    int id = doc["id"] | 0;
    bool state = doc["state"] | false;
    setRelayState(id - 1, state, "cmd", true);
  }
  else if (strcmp(type, "all") == 0) {
    bool state = doc["state"] | false;
    for (int i = 0; i < 4; i++) setRelayState(i, state, "cmd", true);
  }
  else if (strcmp(type, "sync") == 0) {
    strlcpy(pendingSrc, "sync", sizeof(pendingSrc));
    telemetryDirty = true;
  }
  else if (strcmp(type, "timer") == 0) {
    int id = doc["id"] | 0;
    bool state = doc["state"] | false;
    uint32_t delaySec = doc["delaySec"] | 0;
    if (id >= 1 && id <= 4) {
      if (delaySec > 0) {
        timers[id - 1] = { true, state, millis() + delaySec * 1000UL };
      } else {
        timers[id - 1].active = false;
        setRelayState(id - 1, state, "timer", true);
      }
    }
  }
  else if (strcmp(type, "schedule") == 0) {
    int id = doc["id"] | 0;
    if (id >= 1 && id <= 4) {
      int idx = id - 1;
      int onH = 8, onM = 0, offH = 23, offM = 0;
      sscanf(doc["on"] | "08:00", "%d:%d", &onH, &onM);
      sscanf(doc["off"] | "23:00", "%d:%d", &offH, &offM);
      schedules[idx].enabled = doc["enabled"] | false;
      schedules[idx].onHour = (uint8_t)onH;
      schedules[idx].onMin  = (uint8_t)onM;
      schedules[idx].offHour = (uint8_t)offH;
      schedules[idx].offMin  = (uint8_t)offM;
      saveScheduleNVS(idx);
      strlcpy(pendingSrc, "sch", sizeof(pendingSrc));
      telemetryDirty = true;
    }
  }
  else if (strcmp(type, "config") == 0 && doc["schedules"].is<JsonArray>()) {
    JsonArray arr = doc["schedules"];
    for (size_t i = 0; i < arr.size() && i < 4; i++) {
      int onH = 8, onM = 0, offH = 23, offM = 0;
      sscanf(arr[i]["onTime"] | "08:00", "%d:%d", &onH, &onM);
      sscanf(arr[i]["offTime"] | "23:00", "%d:%d", &offH, &offM);
      schedules[i].enabled = arr[i]["enabled"] | false;
      schedules[i].onHour = (uint8_t)onH;
      schedules[i].onMin  = (uint8_t)onM;
      schedules[i].offHour = (uint8_t)offH;
      schedules[i].offMin  = (uint8_t)offM;
    }
  }
  else if (strcmp(type, "resetEnergy") == 0) {
    for (int i = 0; i < 4; i++) outlets[i].kwh = 0.0f;
    totalKwh = 0.0f;
    saveEnergyNVS();
    telemetryDirty = true;
  }
  else if (strcmp(type, "unlock") == 0) {
    if (!tempSensorFault && !currentSensorFault && currentTempC < TEMP_WARN_C && totalAmps < MAX_TOTAL_AMPS) {
      overcurrentLatched = false;
      overcurrentActive  = false;
      thermalCutActive   = false;
      overcurrentTrips   = 0;
      saveTripReasonNVS("NONE");
      updateFaultIndicators();
      telemetryDirty = true;
      beepAlert(1, 70, 0);
      Serial.println("[SAFETY] Admin unlock accepted.");
    }
  }
  else if (strcmp(type, "ota") == 0) {
    const char* url = doc["url"] | "";
    if (strlen(url) > 10) {
      strlcpy(pendingOtaUrl, url, sizeof(pendingOtaUrl));
      pendingOtaRequested = true;
    }
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      if (wsConnected) Serial.println("[WSS] Disconnected from Railway backend.");
      wsConnected = false;
      break;
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.printf("[WSS] Connected to %s:%u/ws/device\n", WS_HOST, WS_PORT);
      strlcpy(pendingSrc, "boot", sizeof(pendingSrc));
      sendTelemetry();
      break;
    case WStype_TEXT:
      handleBackendCommand(payload, length);
      break;
    default:
      break;
  }
}

// ════════════════════════════════════════════════════════════
//  Secured SoftAP Provisioning (WPA2 protected!)
// ════════════════════════════════════════════════════════════
void startProvisioningMode() {
  provisioningMode = true;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apSsid, SOFTAP_PASSWORD);
  Serial.printf("[AP] Provisioning active: SSID=%s PASS=%s IP=%s\n",
                apSsid, SOFTAP_PASSWORD, WiFi.softAPIP().toString().c_str());

  provisionServer.on("/info", HTTP_GET, []() {
    JsonDocument doc;
    doc["deviceId"]        = cfgDeviceId;
    doc["firmwareVersion"] = FIRMWARE_VERSION;
    doc["channels"]        = 4;
    doc["apSsid"]          = apSsid;
    doc["isClaimed"]       = strlen(cfgWifiSsid) > 0;
    String out; serializeJson(doc, out);
    provisionServer.sendHeader("Access-Control-Allow-Origin", "*");
    provisionServer.send(200, "application/json", out);
  });

  provisionServer.on("/scan", HTTP_GET, []() {
    int n = WiFi.scanNetworks();
    JsonDocument doc;
    JsonArray arr = doc["networks"].to<JsonArray>();
    for (int i = 0; i < n; i++) {
      String s = WiFi.SSID(i);
      if (s.isEmpty()) continue;
      JsonObject net = arr.add<JsonObject>();
      net["ssid"]   = s;
      net["rssi"]   = WiFi.RSSI(i);
      net["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    }
    WiFi.scanDelete();
    String out; serializeJson(doc, out);
    provisionServer.sendHeader("Access-Control-Allow-Origin", "*");
    provisionServer.send(200, "application/json", out);
  });

  provisionServer.on("/provision", HTTP_POST, []() {
    JsonDocument doc;
    if (!provisionServer.hasArg("plain") || deserializeJson(doc, provisionServer.arg("plain"))) {
      provisionServer.send(400, "application/json", "{\"error\":\"bad_json\"}");
      return;
    }
    const char* s = doc["ssid"] | "";
    const char* p = doc["password"] | "";
    const char* dev = doc["deviceId"] | cfgDeviceId;
    const char* tok = doc["deviceToken"] | cfgDeviceToken;
    if (strlen(s) == 0) {
      provisionServer.send(400, "application/json", "{\"error\":\"ssid_required\"}");
      return;
    }

    WiFi.disconnect(false);
    delay(100);
    WiFi.begin(s, p);
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 12000) {
      esp_task_wdt_reset();
      delay(250);
    }
    if (WiFi.status() != WL_CONNECTED) {
      WiFi.disconnect(false);
      provisionServer.sendHeader("Access-Control-Allow-Origin", "*");
      provisionServer.send(400, "application/json", "{\"error\":\"wifi_auth_failed\"}");
      return;
    }

    prefs.begin("electronova", false);
    prefs.putString("ssid", s);
    prefs.putString("pass", p);
    prefs.putString("devId", dev);
    prefs.putString("devTok", tok);
    prefs.end();

    provisionServer.sendHeader("Access-Control-Allow-Origin", "*");
    provisionServer.send(200, "application/json", "{\"ok\":true}");
    shouldReboot = true;
    rebootAtMs = millis() + 1200;
  });

  provisionServer.begin();
}

void handleResetButton() {
  if (digitalRead(RESET_BTN_PIN) == LOW) {
    if (resetPressStartMs == 0) resetPressStartMs = millis();
    else if (millis() - resetPressStartMs >= RESET_HOLD_MS) {
      Serial.println("[RESET] Factory reset triggered!");
      saveEnergyNVS();
      prefs.begin("electronova", false);
      prefs.clear();
      prefs.end();
      beepAlert(2, 200, 100);
      ESP.restart();
    }
  } else {
    resetPressStartMs = 0;
  }
}

void initTaskWatchdog() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_deinit();
  esp_task_wdt_config_t wdtCfg = {
    .timeout_ms     = WDT_TIMEOUT_SEC * 1000,
    .idle_core_mask = 1 << 0,
    .trigger_panic  = true
  };
  esp_task_wdt_init(&wdtCfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif
  esp_task_wdt_add(NULL);
}

// ════════════════════════════════════════════════════════════
//  setup() & loop()
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.printf("\n=== ElectroNova Unified Firmware %s ===\n", FIRMWARE_VERSION);

  uint64_t mac = ESP.getEfuseMac();
  snprintf(apSsid, sizeof(apSsid), "ElectroNova-%04X", (uint16_t)(mac >> 32));

  pinMode(WIFI_LED_PIN, OUTPUT);
  pinMode(FAULT_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RESET_BTN_PIN, INPUT_PULLUP);
  digitalWrite(WIFI_LED_PIN, LOW);
  digitalWrite(FAULT_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  analogReadResolution(12);
  loadNVS();

  // Hold all relays OFF safely until sensor self-test passes
  for (int i = 0; i < 4; i++) {
    pendingRestore[i] = outlets[i].on;
    outlets[i].on = false;
    digitalWrite(RELAY_PINS[i], RELAY_OFF);
    pinMode(RELAY_PINS[i], OUTPUT);
#if WOKWI_SIMULATION
    pinMode(SWITCH_PINS[i], INPUT_PULLUP);
#else
    pinMode(SWITCH_PINS[i], INPUT_PULLDOWN);
#endif
    outlets[i].lastSwitch = digitalRead(SWITCH_PINS[i]);
    outlets[i].stableSwitch = outlets[i].lastSwitch;
  }

  tempSensor.begin();
  tempSensor.setWaitForConversion(false);
  runBootSelfTest();
  initTaskWatchdog();

  if (strlen(cfgWifiSsid) == 0) {
    startProvisioningMode();
    return;
  }

  WiFi.mode(WIFI_STA);
#if WOKWI_SIMULATION
  WiFi.begin(cfgWifiSsid, cfgWifiPass, 6);
#else
  WiFi.setAutoReconnect(true);
  WiFi.begin(cfgWifiSsid, cfgWifiPass);
#endif

  configTime(GMT_OFFSET_SEC, DST_OFFSET_SEC, "pool.ntp.org", "time.nist.gov");

  char wsPath[192];
  if (strlen(cfgDeviceToken) > 0) {
    snprintf(wsPath, sizeof(wsPath), "/ws/device?deviceId=%s&token=%s", cfgDeviceId, cfgDeviceToken);
  } else {
    snprintf(wsPath, sizeof(wsPath), "/ws/device?deviceId=%s", cfgDeviceId);
  }

  // WSS Port 443 connection to Railway Backend (/ws/device)
  webSocket.beginSSL(WS_HOST, WS_PORT, wsPath);
  webSocket.setInsecure();
  webSocket.onEvent(onWsEvent);
  webSocket.setReconnectInterval(4000);
  webSocket.enableHeartbeat(15000, 4000, 2);

  ArduinoOTA.setHostname(cfgDeviceId);
  ArduinoOTA.begin();
}

void loop() {
  esp_task_wdt_reset();

  handleResetButton();
  handleTouchSwitches();
  evaluateSensorsAndProtection();
  processStagedRestore();
  processLocalSchedulesAndTimers();
  updateStatusLed();

  if (shouldReboot && millis() >= rebootAtMs) ESP.restart();

  if (provisioningMode) {
    provisionServer.handleClient();
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    wsConnected = false;
    uint32_t now = millis();
    if (now - lastWifiRetryMs >= WIFI_WATCHDOG_MS) {
      lastWifiRetryMs = now;
      WiFi.disconnect(false);
      WiFi.begin(cfgWifiSsid, cfgWifiPass);
    }
    return;
  }

  ArduinoOTA.handle();
  webSocket.loop();

  if (pendingOtaRequested) {
    performHttpsOta();
  }

  uint32_t now = millis();
  if (wsConnected && (telemetryDirty || (now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS))) {
    lastTelemetryMs = now;
    sendTelemetry();
  }
}
