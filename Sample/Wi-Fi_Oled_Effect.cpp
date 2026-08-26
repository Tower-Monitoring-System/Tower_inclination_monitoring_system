#include <WiFi.h>

#include "src/OLED/Wifi_Lora_Connect_Effect.h"

const char *ssid = "TINIHI";                 // TINIHI && ESP32_Transmit
const char *password = "thanhnguyen201077";  // thanhnguyen201077 && 12345678

// OLED SH1106 1.3 inch: SDA = 18, SCL = 19, dia chi I2C = 0x3C.
constexpr int8_t OLED_SDA_PIN = 18;
constexpr int8_t OLED_SCL_PIN = 19;
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 20000UL;
constexpr uint32_t ESP32_RESTART_TIMEOUT_MS = 50000UL;

Wifi_Lora_Connect_Effect connectionDisplay;

enum WifiState : uint8_t {
  WS_DISCONNECTED,
  WS_CONNECTING,
  WS_CONNECTED
};

// WiFiEvent duoc goi tu task Wi-Fi, do do cac bien dung chung duoc khai bao
// volatile. Viec ve OLED chi duoc thuc hien trong loop().
volatile WifiState currentWifiState = WS_CONNECTING;
volatile bool wifiOutageActive = true;
volatile uint32_t wifiOutageStartedAt = 0;
volatile uint32_t lastReconnectAttemptAt = 0;

void handleWifiReconnect();
void handleEsp32Restart();

void WiFiEvent(WiFiEvent_t event) {
  const uint32_t now = millis();

  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
      Serial.println("\n------- BAT DAU KET NOI WIFI -------");
      Serial.print(">> Dang ket noi den: ");
      Serial.println(ssid);
      currentWifiState = WS_CONNECTING;
      break;

    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("[CONNECTING] Da ket noi den Access Point. Dang cho IP...");
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

      wifiOutageActive = false;
      currentWifiState = WS_CONNECTED;
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.println("[FAIL] MAT KET NOI! Dang cho thu ket noi lai...");

      // Chi bat dau lai timeout khi day la dau mot dot mat ket noi moi.
      // Cac lan retry sau do khong duoc phep lam moi timeout restart 50 giay.
      if (!wifiOutageActive) {
        wifiOutageActive = true;
        wifiOutageStartedAt = now;
        lastReconnectAttemptAt = now;
        Serial.println("[FAIL] Bat dau dem gio restart...");
      }

      currentWifiState = WS_DISCONNECTED;
      break;

    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);

  if (!connectionDisplay.begin(OLED_SDA_PIN, OLED_SCL_PIN,
                               OLED_I2C_ADDRESS)) {
    Serial.println("[OLED] Khong tim thay OLED SH1106 tai dia chi 0x3C.");
  } else {
    Serial.println("[OLED] Khoi tao OLED SH1106 thanh cong.");
    connectionDisplay.ConnectingEffect(ConnectionType::WIFI);
  }

  const uint32_t now = millis();
  wifiOutageActive = true;
  wifiOutageStartedAt = now;
  lastReconnectAttemptAt = now;
  currentWifiState = WS_CONNECTING;

  WiFi.onEvent(WiFiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid, password);
}

void loop() {
  // Lay mot ban sao de trang thai khong thay doi giua luc switch dang xu ly.
  const WifiState state = currentWifiState;

  switch (state) {
    case WS_CONNECTING:
      connectionDisplay.ConnectingEffect(ConnectionType::WIFI);
      // Du phong truong hop Wi-Fi bi ket o trang thai CONNECTING qua lau.
      handleEsp32Restart();
      break;

    case WS_CONNECTED:
      connectionDisplay.ConnectedEffect(ConnectionType::WIFI, WiFi.RSSI());
      break;

    case WS_DISCONNECTED:
      connectionDisplay.LostConnectEffect(ConnectionType::WIFI);
      handleWifiReconnect();
      handleEsp32Restart();
      break;
  }

  // Nhuong CPU cho Wi-Fi task; cac hieu ung OLED van hoat dong theo millis().
  delay(1);
}

void handleWifiReconnect() {
  if (!wifiOutageActive) {
    return;
  }

  const uint32_t now = millis();
  if (now - lastReconnectAttemptAt < WIFI_RECONNECT_INTERVAL_MS) {
    return;
  }

  Serial.println(">> [TIMEOUT 20s] Reset WiFi va ket noi lai...");
  connectionDisplay.Disconnect(ConnectionType::WIFI);

  lastReconnectAttemptAt = now;
  WiFi.disconnect();
  WiFi.begin(ssid, password);
}

void handleEsp32Restart() {
  if (!wifiOutageActive) {
    return;
  }

  const uint32_t now = millis();
  if (now - wifiOutageStartedAt < ESP32_RESTART_TIMEOUT_MS) {
    return;
  }

  Serial.println(">> [TIMEOUT 50s] KHONG THE KET NOI. KHOI DONG LAI ESP32...");
  connectionDisplay.RestartESP32(ConnectionType::WIFI);
  Serial.flush();

  // Giu man hinh restart du lau de nguoi dung co the nhin thay thong bao.
  delay(1000);
  ESP.restart();
}
