#line 1 "E:\\ALL PROJECTS\\PROJECT FOR CUSTOMER\\Thay_Luat\\Tower_Inclination_Monitoring_System\\Tower_inclination_monitoring_system\\Src\\Master_Src\\Master\\Master.ino"
#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>

#include "src/Wifi_Lora_Connect_Effect.h"

// ============================================================
// WIFI CONFIG
// ============================================================
const char *ssid = "TINIHI";                 // TINIHI / ESP32_Transmit
const char *password = "thanhnguyen201077"; // thanhnguyen201077 / 12345678

// ============================================================
// OLED SH1106 1.3 INCH CONFIG (128x64, I2C)
// ============================================================
const int8_t OLED_SDA = 18;
const int8_t OLED_SCL = 19;
const int8_t OLED_RESET = -1;
const uint8_t OLED_ADDRESS = 0x3C;

Wifi_Lora_Connect_Effect connectEffect(Wire, OLED_RESET);

// ============================================================
// WIFI TIMEOUT CONFIG
// ============================================================
const uint32_t INTERVAL_DISCONNECT = 20000UL;
const uint32_t INTERVAL_RESTART_ESP32 = 50000UL;

volatile uint32_t previousMillisDisconnect = 0;
volatile uint32_t disconnectedSince = 0;
volatile bool outageActive = false;

enum WifiState : uint8_t {
  WS_DISCONNECTED,
  WS_CONNECTING,
  WS_CONNECTED
};

volatile WifiState currentWifiState = WS_CONNECTING;

// ============================================================
// WIFI EVENT CALLBACK
// Chi cap nhat trang thai tai callback; OLED duoc ve trong loop().
// ============================================================
#line 45 "E:\\ALL PROJECTS\\PROJECT FOR CUSTOMER\\Thay_Luat\\Tower_Inclination_Monitoring_System\\Tower_inclination_monitoring_system\\Src\\Master_Src\\Master\\Master.ino"
void WiFiEvent(arduino_event_id_t event);
#line 95 "E:\\ALL PROJECTS\\PROJECT FOR CUSTOMER\\Thay_Luat\\Tower_Inclination_Monitoring_System\\Tower_inclination_monitoring_system\\Src\\Master_Src\\Master\\Master.ino"
void setup();
#line 115 "E:\\ALL PROJECTS\\PROJECT FOR CUSTOMER\\Thay_Luat\\Tower_Inclination_Monitoring_System\\Tower_inclination_monitoring_system\\Src\\Master_Src\\Master\\Master.ino"
void loop();
#line 45 "E:\\ALL PROJECTS\\PROJECT FOR CUSTOMER\\Thay_Luat\\Tower_Inclination_Monitoring_System\\Tower_inclination_monitoring_system\\Src\\Master_Src\\Master\\Master.ino"
void WiFiEvent(WiFiEvent_t event) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
      Serial.println("\n------- BAT DAU KET NOI WIFI -------");
      Serial.print(">> Dang ket noi den: ");
      Serial.println(ssid);
      currentWifiState = WS_CONNECTING;
      break;

    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("[CONNECTING] Da ket noi Access Point. Dang cho IP...");
      currentWifiState = WS_CONNECTING;
      break;

    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.println("[OK] DA NHAN DUOC IP! Internet OK.");
      Serial.print("[CONFIRM] IP Address: ");
      Serial.println(WiFi.localIP());
      Serial.print("[CONFIRM] Dia chi MAC: ");
      Serial.println(WiFi.macAddress());
      Serial.print("[CONFIRM] Cuong do tin hieu (RSSI): ");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm");

      outageActive = false;
      currentWifiState = WS_CONNECTED;
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED: {
      const uint32_t now = millis();
      Serial.println("[FAIL] MAT KET NOI! Dang thu ket noi lai...");

      // Giu moc bat dau mat ket noi qua cac lan retry de timeout 50 giay
      // khong bi tinh lai tu dau.
      if (!outageActive) {
        Serial.println("[FAIL] Bat dau dem gio restart...");
        disconnectedSince = now;
        previousMillisDisconnect = now;
        outageActive = true;
      }

      currentWifiState = WS_DISCONNECTED;
      break;
    }

    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  if (!connectEffect.begin(OLED_SDA, OLED_SCL, OLED_ADDRESS)) {
    Serial.println("[OLED] Khong tim thay OLED SH1106 tai dia chi 0x3C.");
    Serial.println("[OLED] WiFi van tiep tuc hoat dong khong co man hinh.");
  } else {
    Serial.println("[OLED] Khoi tao OLED SH1106 thanh cong.");
  }

  // Master hien tai chi su dung WiFi. API ConnectionType::LORA da co san
  // trong Wifi_Lora_Connect_Effect de tich hop AS32-TTL-100 sau nay.
  connectEffect.ConnectingEffect(ConnectionType::WIFI);

  WiFi.onEvent(WiFiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
}

void loop() {
  switch (currentWifiState) {
    case WS_CONNECTING:
      connectEffect.ConnectingEffect(ConnectionType::WIFI);
      break;

    case WS_CONNECTED:
      connectEffect.ConnectedEffect(ConnectionType::WIFI, WiFi.RSSI());
      break;

    case WS_DISCONNECTED: {
      const uint32_t now = millis();
      connectEffect.LostConnectEffect(ConnectionType::WIFI);

      if (now - previousMillisDisconnect >= INTERVAL_DISCONNECT) {
        Serial.println(">> [TIMEOUT 20s] Reset WiFi va ket noi lai...");
        connectEffect.Disconnect(ConnectionType::WIFI);
        WiFi.disconnect();
        WiFi.begin(ssid, password);
        previousMillisDisconnect = now;
      }

      if (outageActive &&
          now - disconnectedSince >= INTERVAL_RESTART_ESP32) {
        Serial.println(">> [TIMEOUT 50s] KHOI DONG LAI ESP32...");
        connectEffect.RestartESP32(ConnectionType::WIFI);
        delay(700); // Cho phep nguoi dung nhin thay hieu ung cuoi.
        ESP.restart();
      }
      break;
    }
  }
}

