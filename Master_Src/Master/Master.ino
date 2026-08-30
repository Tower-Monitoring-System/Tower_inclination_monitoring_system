#include <WiFi.h>
#include <time.h>

#include "src/GoogleSheet/GoogleSheetConfig.h"
#include "src/GoogleSheet/GoogleSheetUploader.h"
#include "src/LoRa/MasterLoRaManager.h"
#include "src/OLED/Wifi_Lora_Connect_Effect.h"

const char *ssid = "TINIHI";                 // TINIHI && ESP32_Transmit
const char *password = "thanhnguyen201077";  // thanhnguyen201077 && 12345678

// OLED SH1106 1.3 inch: SDA = 18, SCL = 19, dia chi I2C = 0x3C.
constexpr int8_t OLED_SDA_PIN = 18;
constexpr int8_t OLED_SCL_PIN = 19;
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

// AS32-TTL-100 / UART2. RX/TX theo yeu cau giao tiep; AUX/M0/M1 duoc tach
constexpr int8_t LORA_RX_PIN = 16;
constexpr int8_t LORA_TX_PIN = 17;
constexpr int8_t LORA_AUX_PIN = 34;
constexpr int8_t LORA_M0_PIN = 25;
constexpr int8_t LORA_M1_PIN = 26;
constexpr uint16_t EXPECTED_LORA_NODE_ID = 1U;
static_assert(EXPECTED_LORA_NODE_ID == GoogleSheetConfig::NODE_ID,
              "LoRa Node ID va Google Sheet Node ID phai trung nhau");

constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 20000UL;
constexpr uint32_t ESP32_RESTART_TIMEOUT_MS = 50000UL;
constexpr uint32_t CONNECTED_EFFECT_DURATION_MS = 1400UL;
constexpr uint32_t RECONNECT_EFFECT_DURATION_MS = 900UL;
constexpr uint32_t RESTART_EFFECT_DURATION_MS = 1000UL;
constexpr uint32_t QUEUE_ENQUEUE_RETRY_MS = 5000UL;
constexpr uint8_t QUEUE_CLEAR_BUTTON_PIN = 35U;
constexpr uint32_t QUEUE_CLEAR_DEBOUNCE_MS = 35UL;

constexpr long GMT_OFFSET_SECONDS = 7L * 60L * 60L;
constexpr int DAYLIGHT_OFFSET_SECONDS = 0;
constexpr time_t MINIMUM_VALID_NTP_TIME = 1704067200;  // 01/01/2024 UTC
const char *NTP_SERVER_1 = "pool.ntp.org";
const char *NTP_SERVER_2 = "time.nist.gov";

Wifi_Lora_Connect_Effect connectionDisplay;
HardwareSerial loraSerial(2);
MasterLoRaManager masterLoRa(loraSerial, LORA_RX_PIN, LORA_TX_PIN,
                            LORA_AUX_PIN, LORA_M0_PIN, LORA_M1_PIN,
                            EXPECTED_LORA_NODE_ID);
GoogleSheetUploader googleSheetUploader(GoogleSheetConfig::UPLOADER);

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
volatile uint32_t wifiConnectedAt = 0;

bool reconnectEffectActive = false;
uint32_t reconnectEffectStartedAt = 0;
bool restartPending = false;
uint32_t restartEffectStartedAt = 0;
bool ntpStarted = false;
uint32_t nextQueueEnqueueAttemptAt = 0;
bool queueClearButtonRawState = HIGH;
bool queueClearButtonStableState = HIGH;
bool queueClearButtonPressArmed = false;
uint32_t queueClearButtonLastTransitionAt = 0;

// Trang thai dashboard duoc cap nhat tu LoRa manager va Google Sheet uploader.
MasterDashboardState masterDashboardState = {
    0,
    LoraDisplayState::STANDBY,
    0,
    0,
    SheetDisplayState::READY,
    0,
    false,
};

void handleWifiReconnect();
void handleEsp32Restart();
void startNtpIfNeeded();
bool isNtpTimeSynchronized();
void captureNewTelemetry();
void logInvalidTelemetry(const MasterTelemetry &telemetry);
void handleQueueClearButton(uint32_t now);
void syncLoRaDashboardState();
void syncGoogleSheetDashboardState();
LoraDisplayState toDisplayState(MasterLoRaStatus status);
SheetDisplayState toDisplayState(GoogleSheetUploadState status);

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
      wifiConnectedAt = now;
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

  // GPIO35 la input-only va khong co pull-up noi. Button active LOW phai co
  // dien tro pull-up ngoai tren phan cung.
  pinMode(QUEUE_CLEAR_BUTTON_PIN, INPUT);
  queueClearButtonRawState = digitalRead(QUEUE_CLEAR_BUTTON_PIN);
  queueClearButtonStableState = queueClearButtonRawState;

  if (!connectionDisplay.begin(OLED_SDA_PIN, OLED_SCL_PIN,
                               OLED_I2C_ADDRESS)) {
    Serial.println("[OLED] Khong tim thay OLED SH1106 tai dia chi 0x3C.");
  } else {
    Serial.println("[OLED] Khoi tao OLED SH1106 thanh cong.");
    connectionDisplay.ConnectingEffect(ConnectionType::WIFI);
  }

  googleSheetUploader.begin();
  masterLoRa.begin(millis());
  syncLoRaDashboardState();
  syncGoogleSheetDashboardState();

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
  // Dat receive path truoc moi nhanh Wi-Fi/OLED de Master van xu ly DATA va
  // ACK trong luc reconnect, chay effect hay cho restart.
  const uint32_t loopNow = millis();
  masterLoRa.update(loopNow);
  captureNewTelemetry();
  handleQueueClearButton(loopNow);
  syncLoRaDashboardState();
  syncGoogleSheetDashboardState();

  if (restartPending) {
    handleEsp32Restart();
    yield();
    return;
  }

  // Lay mot ban sao de trang thai khong thay doi giua luc switch dang xu ly.
  const WifiState state = currentWifiState;

  // Hieu ung reconnect duoc giu trong mot khoang ngan bang state machine,
  // khong chan Wi-Fi hay cac tac vu khac.
  if (reconnectEffectActive && state == WS_DISCONNECTED) {
    const uint32_t now = millis();
    if (now - reconnectEffectStartedAt < RECONNECT_EFFECT_DURATION_MS) {
      connectionDisplay.Disconnect(ConnectionType::WIFI);
      handleEsp32Restart();
      yield();
      return;
    }
    reconnectEffectActive = false;
  }

  switch (state) {
    case WS_CONNECTING:
      reconnectEffectActive = false;
      connectionDisplay.ConnectingEffect(ConnectionType::WIFI);
      // Du phong truong hop Wi-Fi bi ket o trang thai CONNECTING qua lau.
      handleEsp32Restart();
      break;

    case WS_CONNECTED: {
      reconnectEffectActive = false;
      const int16_t wifiRssi = WiFi.RSSI();
      startNtpIfNeeded();

      // Hien thi xac nhan ket noi truoc khi chuyen sang dashboard Master.
      if (millis() - wifiConnectedAt < CONNECTED_EFFECT_DURATION_MS) {
        connectionDisplay.ConnectedEffect(ConnectionType::WIFI, wifiRssi);
      } else {
        masterDashboardState.wifiRssi = wifiRssi;
        masterDashboardState.timeSynchronized = isNtpTimeSynchronized();
        connectionDisplay.MasterDashboard(masterDashboardState);
      }
      break;
    }

    case WS_DISCONNECTED:
      connectionDisplay.LostConnectEffect(ConnectionType::WIFI);
      handleWifiReconnect();
      handleEsp32Restart();
      break;
  }

  // yield() chi nhuong quyen xu ly, khong tao thoi gian cho nhu delay().
  yield();
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
  reconnectEffectStartedAt = now;
  reconnectEffectActive = true;
  WiFi.disconnect();
  WiFi.begin(ssid, password);
}

void handleEsp32Restart() {
  const uint32_t now = millis();

  if (restartPending) {
    connectionDisplay.RestartESP32(ConnectionType::WIFI);
    if (now - restartEffectStartedAt >= RESTART_EFFECT_DURATION_MS) {
      Serial.flush();
      ESP.restart();
    }
    return;
  }

  if (!wifiOutageActive) {
    return;
  }

  if (now - wifiOutageStartedAt < ESP32_RESTART_TIMEOUT_MS) {
    return;
  }

  Serial.println(">> [TIMEOUT 50s] KHONG THE KET NOI. KHOI DONG LAI ESP32...");
  restartPending = true;
  restartEffectStartedAt = now;
  connectionDisplay.RestartESP32(ConnectionType::WIFI);
}

void startNtpIfNeeded() {
  if (ntpStarted) {
    return;
  }

  configTime(GMT_OFFSET_SECONDS, DAYLIGHT_OFFSET_SECONDS, NTP_SERVER_1,
             NTP_SERVER_2);
  ntpStarted = true;
  Serial.println("[NTP] Da bat dau dong bo thoi gian UTC+7.");
}

bool isNtpTimeSynchronized() {
  return time(nullptr) >= MINIMUM_VALID_NTP_TIME;
}

void captureNewTelemetry() {
  const uint32_t now = millis();
  if (static_cast<int32_t>(now - nextQueueEnqueueAttemptAt) < 0) {
    return;
  }

  MasterTelemetry telemetry;
  if (!masterLoRa.peekNewTelemetry(telemetry)) {
    return;
  }

  const time_t sampleTime =
      isNtpTimeSynchronized() ? time(nullptr) : static_cast<time_t>(0);
  const TelemetryEnqueueResult result =
      googleSheetUploader.enqueue(telemetry, sampleTime);
  bool consumeTelemetry = false;

  switch (result) {
    case TelemetryEnqueueResult::QUEUED:
      Serial.printf("[QUEUE] LoRa RX ID=%lu -> queued, pending=%u\n",
                    static_cast<unsigned long>(telemetry.messageId),
                    static_cast<unsigned>(googleSheetUploader.pendingCount()));
      consumeTelemetry = true;
      break;
    case TelemetryEnqueueResult::DUPLICATE:
      Serial.printf("[QUEUE] ID=%lu da ton tai, khong enqueue trung\n",
                    static_cast<unsigned long>(telemetry.messageId));
      consumeTelemetry = true;
      break;
    case TelemetryEnqueueResult::FULL:
      Serial.printf("[QUEUE] ID=%lu FAILED: queue day, giu nguyen %u mau cu\n",
                    static_cast<unsigned long>(telemetry.messageId),
                    static_cast<unsigned>(googleSheetUploader.pendingCount()));
      nextQueueEnqueueAttemptAt = now + QUEUE_ENQUEUE_RETRY_MS;
      break;
    case TelemetryEnqueueResult::INVALID:
      logInvalidTelemetry(telemetry);
      consumeTelemetry = true;
      break;
    case TelemetryEnqueueResult::STORAGE_ERROR:
    default:
      Serial.printf("[QUEUE] ID=%lu FAILED: loi NVS\n",
                    static_cast<unsigned long>(telemetry.messageId));
      nextQueueEnqueueAttemptAt = now + QUEUE_ENQUEUE_RETRY_MS;
      break;
  }

  if (consumeTelemetry) {
    (void)masterLoRa.markTelemetryConsumed(telemetry.nodeId,
                                           telemetry.messageId);
    nextQueueEnqueueAttemptAt = 0U;
  }
}

void logInvalidTelemetry(const MasterTelemetry &telemetry) {
  using namespace TowerLoRaProtocol;
  constexpr uint8_t REQUIRED_FLAGS =
      FLAG_X_VALID | FLAG_Y_VALID | FLAG_Z_VALID | FLAG_BATTERY_VALID;
  const uint8_t missing =
      static_cast<uint8_t>(REQUIRED_FLAGS & ~telemetry.validFlags);

  Serial.printf("[QUEUE] ID=%lu INVALID flags=0x%02X missing=",
                static_cast<unsigned long>(telemetry.messageId),
                static_cast<unsigned>(telemetry.validFlags));
  if (missing == 0U) {
    Serial.print("VALUE_OR_RANGE");
  } else {
    if ((missing & FLAG_X_VALID) != 0U) Serial.print("X,");
    if ((missing & FLAG_Y_VALID) != 0U) Serial.print("Y,");
    if ((missing & FLAG_Z_VALID) != 0U) Serial.print("Z,");
    if ((missing & FLAG_BATTERY_VALID) != 0U) Serial.print("BAT,");
  }
  Serial.printf(" X=%.2f Y=%.2f Z=%.2f BAT=%.3f quality=%s\n",
                telemetry.xDegrees, telemetry.yDegrees, telemetry.zDegrees,
                telemetry.batteryVoltage,
                (telemetry.validFlags & FLAG_ORIENTATION_FALLBACK) != 0U
                    ? "FAST_FALLBACK"
                    : "STRUCT");
}

void handleQueueClearButton(uint32_t now) {
  const bool rawState = digitalRead(QUEUE_CLEAR_BUTTON_PIN);
  if (rawState != queueClearButtonRawState) {
    queueClearButtonRawState = rawState;
    queueClearButtonLastTransitionAt = now;
  }

  if (rawState == queueClearButtonStableState ||
      now - queueClearButtonLastTransitionAt < QUEUE_CLEAR_DEBOUNCE_MS) {
    return;
  }

  queueClearButtonStableState = rawState;
  if (queueClearButtonStableState == LOW) {
    queueClearButtonPressArmed = true;
    return;
  }

  if (!queueClearButtonPressArmed) {
    return;
  }
  queueClearButtonPressArmed = false;

  if (googleSheetUploader.clearQueue()) {
    nextQueueEnqueueAttemptAt = 0U;
    Serial.println("[QUEUE] CLEAR -> pending=0");
  } else {
    Serial.println("[QUEUE] CLEAR FAILED -> queue unchanged");
  }
}

void syncLoRaDashboardState() {
  masterDashboardState.loraState = toDisplayState(masterLoRa.status());
  masterDashboardState.nodeCount = masterLoRa.knownNodeCount();
}

void syncGoogleSheetDashboardState() {
  masterDashboardState.sheetState =
      toDisplayState(googleSheetUploader.state());
  masterDashboardState.pendingUploads = googleSheetUploader.pendingCount();
}

LoraDisplayState toDisplayState(MasterLoRaStatus status) {
  switch (status) {
    case MasterLoRaStatus::STANDBY:
      return LoraDisplayState::STANDBY;
    case MasterLoRaStatus::RECEIVING:
      return LoraDisplayState::RECEIVING;
    case MasterLoRaStatus::ACKNOWLEDGING:
      return LoraDisplayState::ACKNOWLEDGING;
    case MasterLoRaStatus::ERROR:
      return LoraDisplayState::ERROR;
    case MasterLoRaStatus::DISCONNECTED:
    default:
      return LoraDisplayState::LOST;
  }
}

SheetDisplayState toDisplayState(GoogleSheetUploadState status) {
  switch (status) {
    case GoogleSheetUploadState::WAITING:
      return SheetDisplayState::SYNCING;
    case GoogleSheetUploadState::SENDING:
      return SheetDisplayState::SENDING;
    case GoogleSheetUploadState::SUCCESS:
      return SheetDisplayState::SUCCESS;
    case GoogleSheetUploadState::FAILED:
    case GoogleSheetUploadState::CONFIG_ERROR:
      return SheetDisplayState::ERROR;
    case GoogleSheetUploadState::READY:
    default:
      return SheetDisplayState::READY;
  }
}
