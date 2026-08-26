#include <WiFi.h>
const char *ssid = "TINIHI"; // TINIHI&&ESP32_Transmit
const char *password = "thanhnguyen201077";   // thanhnguyen201077&&12345678

// --- KHAI BAO BIEN THOI GIAN ---
unsigned long previousMillis_Disconnect = 0; 
unsigned long previousMillis_Restart = 0; 
const uint16_t interval_disconnect = 20000;
const uint16_t interval_restartEsp32 = 50000;

enum WifiState {
  WS_DISCONNECTED, 
  WS_CONNECTING,   
  WS_CONNECTED   
};
volatile WifiState currentWifiState = WS_DISCONNECTED;

// --- Prototype ---
void ConnectingEffect();
void LostConnectEffect();
void Disconnect();
void RestartESP32();

// --- HAM XU LY SU KIEN WIFI (CALLBACK) ---
void WiFiEvent(WiFiEvent_t event) {
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
      currentWifiState = WS_CONNECTED;
      break;

    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.println("[FAIL] MAT KET NOI! Dang thu ket noi lai...");
      if (currentWifiState != WS_DISCONNECTED) {
        Serial.println("[FAIL] Bat dau dem gio restart...");
        previousMillis_Disconnect = millis();
        previousMillis_Restart = millis();
        currentWifiState = WS_DISCONNECTED;
      }
      break;
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.onEvent(WiFiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
}

void loop() {
  switch (currentWifiState) {
    case WS_CONNECTING:
      ConnectingEffect();
      break;

    case WS_CONNECTED: {
      break;
    }

    case WS_DISCONNECTED:
      LostConnectEffect();
      Disconnect();
      RestartESP32();
      break;
  }
}

void Disconnect() {
  unsigned long currentMillis = millis();
  if(currentMillis - previousMillis_Disconnect >= interval_disconnect) {
    Serial.println(">> [TIMEOUT 20s] Thu Reset WiFi va Ket noi lai...");
    WiFi.disconnect();
    WiFi.begin(ssid, password);
    previousMillis_Disconnect = currentMillis;
  }
}

void RestartESP32() {
  unsigned long currentMillis = millis();
  if(currentMillis - previousMillis_Restart >= interval_restartEsp32) {
    Serial.println(">> [TIMEOUT 50s] KHONG THE KET NOI. KHOI DONG LAI ESP32...");
    ESP.restart();
  }
}

// --- HIEU UNG LED "LOADING" ---
void ConnectingEffect() {

}

// --- HIEU UNG MAT KET NOI ---
void LostConnectEffect() {

}
