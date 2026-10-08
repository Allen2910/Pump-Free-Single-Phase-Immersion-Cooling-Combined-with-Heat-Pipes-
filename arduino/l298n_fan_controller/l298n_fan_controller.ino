#include <WiFi.h>
#include <WebServer.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>
#include <ThingSpeak.h>
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <math.h>
#include "secrets.h"

// Wi-Fi / ThingSpeak values are stored in the Git-ignored secrets.h file.
WiFiClient client;
WebServer webServer(80);
WiFiUDP discoveryUdp;

const char* DEVICE_HOSTNAME = "therm-core";
const uint16_t DISCOVERY_PORT = 4210;
const char* DISCOVERY_MESSAGE = "THERM_CORE_DISCOVER";
bool networkServicesStarted = false;

// NeoPixel
#define LED_PIN 5
#define NUM_LEDS 57
Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

// Thermistor
#define THERMISTOR_PIN 34
const float BETA = 3950.0;
const float FIXED_RESISTOR = 12000.0;
const float NOMINAL_RESISTANCE = 10000.0;
const float CALIBRATION_OFFSET = 10.2;
const float ADC_MAX = 4095.0;

// Delta FFB1212SH -> L298N -> ESP32
// 拔除 L298N ENA 跳線帽，再把 ENA 接到 GPIO 25。
const uint8_t FAN_ENA_PIN = 25;
const uint8_t FAN_IN1_PIN = 26;
const uint8_t FAN_IN2_PIN = 27;
const uint8_t DEFAULT_FAN_SPEED = 50;
const uint8_t MIN_RUNNING_PWM = 70;

const unsigned long UPLOAD_INTERVAL = 20000;
const unsigned long WIFI_RETRY_INTERVAL = 10000;
unsigned long lastUploadTime = 0;
unsigned long lastWiFiRetryTime = 0;

Preferences preferences;
uint8_t fanSpeedSetting = DEFAULT_FAN_SPEED;
bool fanEnabled = true;
uint8_t currentFanOutput = 0;
bool fanStateDirty = false;
unsigned long fanStateChangedAt = 0;

void applyFanOutput(uint8_t percent) {
  percent = constrain(percent, 0, 100);

  if (percent == 0) {
    analogWrite(FAN_ENA_PIN, 0);
    digitalWrite(FAN_IN1_PIN, LOW);
    digitalWrite(FAN_IN2_PIN, LOW);
    currentFanOutput = 0;
    return;
  }

  digitalWrite(FAN_IN1_PIN, HIGH);
  digitalWrite(FAN_IN2_PIN, LOW);

  // 靜止時先全速助轉，避免大型風扇在低 PWM 下無法起動。
  if (currentFanOutput == 0) {
    analogWrite(FAN_ENA_PIN, 255);
    delay(300);
  }

  const uint8_t pwm = map(percent, 1, 100, MIN_RUNNING_PWM, 255);
  analogWrite(FAN_ENA_PIN, pwm);
  currentFanOutput = percent;
}

void saveFanStateIfNeeded() {
  // 滑桿拖曳時會密集收到命令；停止變更 1 秒後才寫入，減少 NVS 磨耗。
  if (!fanStateDirty || millis() - fanStateChangedAt < 1000) return;

  preferences.putUChar("speed", fanSpeedSetting);
  preferences.putBool("enabled", fanEnabled);
  fanStateDirty = false;
}

void handleFanCommand() {
  if (!Serial.available()) return;

  String command = Serial.readStringUntil('\n');
  command.trim();
  if (!command.startsWith("FAN:")) return;

  const int requestedSpeed = command.substring(4).toInt();
  if (requestedSpeed < 0 || requestedSpeed > 100) {
    Serial.println("ERR:FAN:RANGE");
    return;
  }

  if (requestedSpeed == 0) {
    // 關閉只改變開關，不覆蓋最後一次非零轉速。
    fanEnabled = false;
  } else {
    fanSpeedSetting = requestedSpeed;
    fanEnabled = true;
  }

  applyFanOutput(fanEnabled ? fanSpeedSetting : 0);
  fanStateDirty = true;
  fanStateChangedAt = millis();

  Serial.print("OK:FAN:");
  Serial.print(fanEnabled ? fanSpeedSetting : 0);
  Serial.print(":SAVED:");
  Serial.println(fanSpeedSetting);
}

String fanStateJson() {
  String json = "{\"ok\":true,\"speed\":";
  json += String(fanSpeedSetting);
  json += ",\"enabled\":";
  json += fanEnabled ? "true" : "false";
  json += ",\"effective_speed\":";
  json += String(fanEnabled ? fanSpeedSetting : 0);
  json += ",\"ip\":\"";
  json += WiFi.localIP().toString();
  json += "\"}";
  return json;
}

void sendFanState() {
  webServer.sendHeader("Cache-Control", "no-store");
  webServer.send(200, "application/json; charset=utf-8", fanStateJson());
}

void sendApiError(int statusCode, const String &message) {
  String json = "{\"ok\":false,\"message\":\"";
  json += message;
  json += "\"}";
  webServer.send(statusCode, "application/json; charset=utf-8", json);
}

void handleHttpFanControl() {
  if (!webServer.hasArg("speed") && !webServer.hasArg("enabled")) {
    sendApiError(400, "speed or enabled is required");
    return;
  }

  uint8_t nextSpeed = fanSpeedSetting;
  bool nextEnabled = fanEnabled;

  if (webServer.hasArg("speed")) {
    const String rawSpeed = webServer.arg("speed");
    const int requestedSpeed = rawSpeed.toInt();
    if (requestedSpeed < 0 || requestedSpeed > 100) {
      sendApiError(400, "speed must be between 0 and 100");
      return;
    }

    if (requestedSpeed == 0) {
      nextEnabled = false;
    } else {
      nextSpeed = requestedSpeed;
    }
  }

  if (webServer.hasArg("enabled")) {
    const String rawEnabled = webServer.arg("enabled");
    if (rawEnabled == "1" || rawEnabled == "true") {
      nextEnabled = true;
    } else if (rawEnabled == "0" || rawEnabled == "false") {
      nextEnabled = false;
    } else {
      sendApiError(400, "enabled must be 0 or 1");
      return;
    }
  }

  fanSpeedSetting = nextSpeed;
  fanEnabled = nextEnabled;
  applyFanOutput(fanEnabled ? fanSpeedSetting : 0);
  fanStateDirty = true;
  fanStateChangedAt = millis();
  sendFanState();
}

void startNetworkServices() {
  if (networkServicesStarted || WiFi.status() != WL_CONNECTED) return;

  webServer.on("/api/status", HTTP_GET, sendFanState);
  webServer.on("/api/fan", HTTP_POST, handleHttpFanControl);
  webServer.on("/health", HTTP_GET, sendFanState);
  webServer.onNotFound([]() {
    sendApiError(404, "not found");
  });
  webServer.begin();

  discoveryUdp.begin(DISCOVERY_PORT);
  if (MDNS.begin(DEVICE_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("mDNS: http://therm-core.local");
  }

  networkServicesStarted = true;
  Serial.print("Fan HTTP API: http://");
  Serial.print(WiFi.localIP());
  Serial.println("/api/status");
}

void stopNetworkServices() {
  if (!networkServicesStarted) return;
  webServer.stop();
  discoveryUdp.stop();
  MDNS.end();
  networkServicesStarted = false;
}

void handleUdpDiscovery() {
  const int packetSize = discoveryUdp.parsePacket();
  if (packetSize <= 0) return;

  char packet[64];
  const int length = discoveryUdp.read(packet, sizeof(packet) - 1);
  if (length <= 0) return;
  packet[length] = '\0';

  if (String(packet) != DISCOVERY_MESSAGE) return;

  discoveryUdp.beginPacket(discoveryUdp.remoteIP(), discoveryUdp.remotePort());
  discoveryUdp.print("THERM_CORE:");
  discoveryUdp.print(WiFi.localIP());
  discoveryUdp.print(":80");
  discoveryUdp.endPacket();
}

void handleNetworkServices() {
  if (WiFi.status() != WL_CONNECTED || !networkServicesStarted) return;
  webServer.handleClient();
  handleUdpDiscovery();
}

void clearLEDs() {
  strip.clear();
  strip.show();
}

void scanWiFiNetworks() {
  Serial.println("Scanning WiFi networks...");
  WiFi.mode(WIFI_STA);
  const int networkCount = WiFi.scanNetworks();

  if (networkCount <= 0) {
    Serial.println("No WiFi networks found.");
  } else {
    for (int i = 0; i < networkCount; i++) {
      Serial.print(i + 1);
      Serial.print(". ");
      Serial.print(WiFi.SSID(i));
      Serial.print(" | RSSI: ");
      Serial.print(WiFi.RSSI(i));
      Serial.println(" dBm");
      delay(10);
    }
  }

  WiFi.scanDelete();
}

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  stopNetworkServices();
  Serial.println("Restarting WiFi connection...");
  WiFi.disconnect(true, false);
  delay(1000);
  WiFi.mode(WIFI_STA);
  delay(500);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const unsigned long connectionStartTime = millis();
  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - connectionStartTime < 20000
  ) {
    // 即使正在等待 Wi-Fi，也維持 USB Serial 風扇控制可用。
    handleFanCommand();
    delay(100);
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected. IP: ");
    Serial.println(WiFi.localIP());
    startNetworkServices();
    return true;
  }

  Serial.println("WiFi connection failed.");
  WiFi.disconnect(false, false);
  return false;
}

bool readTemperature(float &temperatureC) {
  const int adc = analogRead(THERMISTOR_PIN);
  if (adc <= 0 || adc >= 4095) {
    Serial.println("Invalid thermistor ADC value.");
    return false;
  }

  const float resistance = FIXED_RESISTOR * (ADC_MAX / (float)adc - 1.0);
  if (resistance <= 0) return false;

  temperatureC = 1.0 / (
    log(resistance / NOMINAL_RESISTANCE) / BETA + 1.0 / 298.15
  ) - 273.15 + CALIBRATION_OFFSET;

  if (isnan(temperatureC) || isinf(temperatureC)) return false;

  Serial.print("Temperature: ");
  Serial.print(temperatureC, 2);
  Serial.println(" C");
  return true;
}

void updateLEDs(float temperatureC) {
  float ratio = constrain((temperatureC - 20.0) / 30.0, 0.0, 1.0);
  const int red = (int)(ratio * 255.0);
  const int blue = (int)((1.0 - ratio) * 255.0);
  const uint32_t color = strip.Color(red, 0, blue);

  for (int i = 0; i < NUM_LEDS; i++) {
    strip.setPixelColor(i, color);
  }
  strip.show();
}

void uploadToThingSpeak(float temperatureC) {
  if (WiFi.status() != WL_CONNECTED) return;

  const int httpCode = ThingSpeak.writeField(
    THINGSPEAK_CHANNEL_ID,
    1,
    temperatureC,
    THINGSPEAK_WRITE_API_KEY
  );
  Serial.print("ThingSpeak result: ");
  Serial.println(httpCode);
}

void setup() {
  Serial.begin(115200);
  Serial.setTimeout(50);
  delay(500);

  pinMode(FAN_ENA_PIN, OUTPUT);
  pinMode(FAN_IN1_PIN, OUTPUT);
  pinMode(FAN_IN2_PIN, OUTPUT);

  // 第一次啟動為 50%；之後重啟會還原最後設定與開關狀態。
  preferences.begin("delta-fan", false);
  fanSpeedSetting = preferences.getUChar("speed", DEFAULT_FAN_SPEED);
  if (fanSpeedSetting < 1 || fanSpeedSetting > 100) {
    fanSpeedSetting = DEFAULT_FAN_SPEED;
  }
  fanEnabled = preferences.getBool("enabled", true);
  applyFanOutput(fanEnabled ? fanSpeedSetting : 0);

  analogReadResolution(12);
  analogSetPinAttenuation(THERMISTOR_PIN, ADC_11db);
  strip.begin();
  strip.setBrightness(50);
  clearLEDs();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);
  scanWiFiNetworks();
  connectWiFi();
  ThingSpeak.begin(client);
  lastUploadTime = millis() - UPLOAD_INTERVAL;

  Serial.print("Fan setting: ");
  Serial.print(fanSpeedSetting);
  Serial.println(fanEnabled ? "% (on)" : "% (off)");
}

void loop() {
  const unsigned long currentTime = millis();

  // 網路是主要控制路徑；USB Serial 僅保留作為除錯備援。
  handleNetworkServices();
  handleFanCommand();
  saveFanStateIfNeeded();

  if (WiFi.status() != WL_CONNECTED) {
    if (currentTime - lastWiFiRetryTime >= WIFI_RETRY_INTERVAL) {
      lastWiFiRetryTime = currentTime;
      connectWiFi();
    }
    delay(20);
    return;
  }

  if (currentTime - lastUploadTime >= UPLOAD_INTERVAL) {
    lastUploadTime = currentTime;
    float temperatureC;
    if (readTemperature(temperatureC)) {
      updateLEDs(temperatureC);
      uploadToThingSpeak(temperatureC);
    }
  }

  delay(20);
}
