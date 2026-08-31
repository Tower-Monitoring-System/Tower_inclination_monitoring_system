#include <WiFi.h>
#include <time.h>

#include "src/ESP32WiFiPortal/ESP32WiFiPortal.h"
#include "src/GoogleSheet/GoogleSheetConfig.h"
#include "src/GoogleSheet/GoogleSheetUploader.h"
#include "src/LoRa/MasterLoRaManager.h"
#include "src/OLED/Wifi_Lora_Connect_Effect.h"

constexpr int8_t OLED_SDA_PIN = 18;
constexpr int8_t OLED_SCL_PIN = 19;
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

constexpr int8_t LORA_RX_PIN = 16;
constexpr int8_t LORA_TX_PIN = 17;
constexpr int8_t LORA_AUX_PIN = 34;
constexpr int8_t LORA_M0_PIN = 25;
constexpr int8_t LORA_M1_PIN = 26;
constexpr uint16_t EXPECTED_LORA_NODE_ID = 1U;
static_assert(EXPECTED_LORA_NODE_ID == GoogleSheetConfig::NODE_ID,
              "LoRa Node ID va Google Sheet Node ID phai trung nhau");

constexpr uint32_t CONNECTED_EFFECT_DURATION_MS = 1400UL;
constexpr char WIFI_PORTAL_SSID[] = "Tower-Master-Setup";
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000UL;
constexpr uint8_t WIFI_CONNECTION_RETRY_COUNT = 2U;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 5000UL;
constexpr uint32_t WIFI_MAX_RETRY_INTERVAL_MS = 60000UL;
constexpr uint32_t ON_DEMAND_PORTAL_TIMEOUT_MS = 5UL * 60UL * 1000UL;
constexpr uint32_t QUEUE_ENQUEUE_RETRY_MS = 1000UL;
constexpr uint8_t QUEUE_CLEAR_BUTTON_PIN = 35U;
constexpr uint32_t QUEUE_CLEAR_DEBOUNCE_MS = 35UL;
constexpr uint32_t WIFI_PORTAL_BUTTON_HOLD_MS = 3000UL;

constexpr long GMT_OFFSET_SECONDS = 7L * 60L * 60L;
constexpr int DAYLIGHT_OFFSET_SECONDS = 0;
constexpr time_t MINIMUM_VALID_NTP_TIME = 1704067200;  // 01/01/2024 UTC
const char *NTP_SERVER_1 = "pool.ntp.org";
const char *NTP_SERVER_2 = "time.nist.gov";

Wifi_Lora_Connect_Effect connectionDisplay;
ESP32WiFiPortal wifiPortal;
HardwareSerial loraSerial(2);
MasterLoRaManager masterLoRa(loraSerial, LORA_RX_PIN, LORA_TX_PIN,
                            LORA_AUX_PIN, LORA_M0_PIN, LORA_M1_PIN,
                            EXPECTED_LORA_NODE_ID);
GoogleSheetUploader googleSheetUploader(GoogleSheetConfig::UPLOADER);

bool wifiConnectedCallbackPending = false;
bool wifiWasConnected = false;
bool wifiEverConnected = false;
uint32_t wifiConnectedAt = 0;
bool ntpStarted = false;
uint32_t nextQueueEnqueueAttemptAt = 0;
bool queueClearButtonRawState = HIGH;
bool queueClearButtonStableState = HIGH;
bool queueClearButtonPressArmed = false;
bool queueClearButtonLongPressHandled = false;
uint32_t queueClearButtonLastTransitionAt = 0;
uint32_t queueClearButtonPressedAt = 0;

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

bool startWifiConfigPortal(uint32_t timeoutMs);
void updateWifiStateAndDisplay(uint32_t now);
void startNtpIfNeeded();
bool isNtpTimeSynchronized();
void captureNewTelemetry();
void logInvalidTelemetry(const MasterTelemetry &telemetry);
void handleQueueClearButton(uint32_t now);
void clearTelemetryQueue();
void syncLoRaDashboardState();
void syncGoogleSheetDashboardState();
LoraDisplayState toDisplayState(MasterLoRaStatus status);
SheetDisplayState toDisplayState(GoogleSheetUploadState status);

void setup() {
  Serial.begin(115200);
  pinMode(QUEUE_CLEAR_BUTTON_PIN, INPUT);
  queueClearButtonRawState = digitalRead(QUEUE_CLEAR_BUTTON_PIN);
  queueClearButtonStableState = queueClearButtonRawState;
  if (queueClearButtonStableState == LOW) {
    queueClearButtonPressArmed = true;
    queueClearButtonPressedAt = millis();
  }

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

  wifiPortal.setConnectTimeout(WIFI_CONNECT_TIMEOUT_MS);
  if (!wifiPortal.setConnectionRetryPolicy(
          WIFI_CONNECTION_RETRY_COUNT, WIFI_RETRY_INTERVAL_MS,
          WIFI_MAX_RETRY_INTERVAL_MS)) {
    Serial.print("[WIFI] Cau hinh retry that bai: ");
    Serial.println(wifiPortal.lastError());
  }
  wifiPortal.onConnected([]() { wifiConnectedCallbackPending = true; });

  const bool hasSavedWifi = wifiPortal.hasSavedCredentials();
  wifiPortal.setAutoReconnect(true);
  if (hasSavedWifi) {
    Serial.println(
        "[WIFI] Da co credentials trong NVS; cho ket noi non-blocking...");
  } else {
    Serial.println("[WIFI] Chua co credentials trong NVS.");
    startWifiConfigPortal(0U);
  }
}

void loop() {
  // Luon phuc vu LoRa truoc, ke ca khi mat Wi-Fi hoac Config Portal dang mo.
  const uint32_t loopNow = millis();
  masterLoRa.update(loopNow);
  captureNewTelemetry();
  handleQueueClearButton(loopNow);

  // ESP32WiFiPortal la noi duy nhat quan ly WiFiEvent, ket noi va reconnect.
  wifiPortal.process();

  syncLoRaDashboardState();
  syncGoogleSheetDashboardState();
  updateWifiStateAndDisplay(millis());

  // yield() chi nhuong quyen xu ly, khong tao thoi gian cho nhu delay().
  yield();
}

bool startWifiConfigPortal(uint32_t timeoutMs) {
  if (wifiPortal.isPortalActive()) {
    return true;
  }

  if (!wifiPortal.startConfigPortalAsync(WIFI_PORTAL_SSID, nullptr,
                                          timeoutMs)) {
    Serial.print("[WIFI] Khong the mo Config Portal: ");
    Serial.println(wifiPortal.lastError());
    return false;
  }

  Serial.print("[WIFI] Config Portal san sang: ");
  Serial.print(wifiPortal.portalSSID());
  Serial.print(" tai http://");
  Serial.println(wifiPortal.portalIP());
  return true;
}

void updateWifiStateAndDisplay(uint32_t now) {
  const bool connected = wifiPortal.isConnected();
  const bool callbackReportedConnection = wifiConnectedCallbackPending;
  wifiConnectedCallbackPending = false;

  if (connected && (!wifiWasConnected || callbackReportedConnection)) {
    wifiEverConnected = true;
    wifiConnectedAt = now;
    Serial.println("[WIFI] Da ket noi va nhan IP.");
    Serial.print("[WIFI] IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("[WIFI] MAC: ");
    Serial.println(WiFi.macAddress());
    Serial.print("[WIFI] RSSI: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
  } else if (!connected && wifiWasConnected) {
    Serial.println("[WIFI] Mat ket noi; portal se tu reconnect non-blocking.");
  }
  wifiWasConnected = connected;

  if (connected) {
    startNtpIfNeeded();
  }

  // Portal van active trong luc thu candidate; candidate phai uu tien hieu
  // ung Connecting, con luc cho user thi hien thi AP Config Portal rieng.
  if (wifiPortal.isPortalActive()) {
    if (wifiPortal.isPortalConnectionAttemptActive()) {
      connectionDisplay.ConnectingEffect(ConnectionType::WIFI);
    } else {
      connectionDisplay.ConfigPortalEffect(ConnectionType::WIFI);
    }
    return;
  }

  if (!connected) {
    if (wifiEverConnected) {
      connectionDisplay.LostConnectEffect(ConnectionType::WIFI);
    } else {
      connectionDisplay.ConnectingEffect(ConnectionType::WIFI);
    }
    return;
  }

  const int16_t wifiRssi = WiFi.RSSI();
  if (now - wifiConnectedAt < CONNECTED_EFFECT_DURATION_MS) {
    connectionDisplay.ConnectedEffect(ConnectionType::WIFI, wifiRssi);
    return;
  }

  masterDashboardState.wifiRssi = wifiRssi;
  masterDashboardState.timeSynchronized = isNtpTimeSynchronized();
  connectionDisplay.MasterDashboard(masterDashboardState);
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
    const bool duplicate = result == TelemetryEnqueueResult::DUPLICATE;
    if (!masterLoRa.markTelemetryConsumed(telemetry.nodeId,
                                          telemetry.messageId, duplicate)) {
      Serial.printf("[LORA] ID=%lu WARN: telemetry state changed before ACK\n",
                    static_cast<unsigned long>(telemetry.messageId));
    }
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

  if (rawState != queueClearButtonStableState &&
      now - queueClearButtonLastTransitionAt >= QUEUE_CLEAR_DEBOUNCE_MS) {
    queueClearButtonStableState = rawState;
    if (queueClearButtonStableState == LOW) {
      queueClearButtonPressArmed = true;
      queueClearButtonLongPressHandled = false;
      queueClearButtonPressedAt = now;
    } else {
      const bool shouldClearQueue =
          queueClearButtonPressArmed && !queueClearButtonLongPressHandled;
      queueClearButtonPressArmed = false;
      queueClearButtonLongPressHandled = false;
      if (shouldClearQueue) {
        clearTelemetryQueue();
      }
    }
  }

  if (queueClearButtonStableState == LOW && queueClearButtonPressArmed &&
      !queueClearButtonLongPressHandled &&
      now - queueClearButtonPressedAt >= WIFI_PORTAL_BUTTON_HOLD_MS) {
    queueClearButtonLongPressHandled = true;
    Serial.println("[BUTTON] Giu 3 giay -> mo Config Portal.");
    startWifiConfigPortal(ON_DEMAND_PORTAL_TIMEOUT_MS);
  }
}

void clearTelemetryQueue() {
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
