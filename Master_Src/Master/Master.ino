#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <ctype.h>
#include <errno.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "src/GoogleSheetClient.h"
#include "src/OLED/Wifi_Lora_Connect_Effect.h"
#include "src/SensorData.h"
// ============================================================
// WIFI CONFIG
// ============================================================
const char *ssid = "TINIHI";
const char *password = "thanhnguyen201077";

// ============================================================
// GOOGLE APPS SCRIPT CONFIG
// Chi dien Deployment ID, khong dan ca URL /exec.
// Shared secret phai trung voi Script Property SENSOR_DATA_SHARED_SECRET.
// ============================================================
const char *GOOGLE_SCRIPT_DEPLOYMENT_ID = "AKfycbzAeo79y8InJJDrK7MexB9MtD5HChtBBcc50e7NJ-ZyQRGTRgwBBFY4SGou9LFMbF3v";
const char *GOOGLE_SCRIPT_SHARED_SECRET = "ph5CC7YKt8QIZelCsIcAg5TGovQtTtjR/QHboHMF1Os=";
const char *DEFAULT_TOWER_ID = "TWR-01";

GoogleSheetClient googleSheet(GOOGLE_SCRIPT_DEPLOYMENT_ID,
                              GOOGLE_SCRIPT_SHARED_SECRET);

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
// SENSOR DATA QUEUE
// Serial hien tai chi la data source gia lap. Khi co LoRa, chi can thay
// processSerialInput() bang ham nhan LoRa va dua SensorReading vao queue nay.
// ============================================================
const uint8_t READING_QUEUE_CAPACITY = 8;
SensorReading readingQueue[READING_QUEUE_CAPACITY];
uint8_t readingQueueHead = 0;
uint8_t readingQueueCount = 0;

const size_t SERIAL_LINE_CAPACITY = 96;
char serialLine[SERIAL_LINE_CAPACITY];
size_t serialLineLength = 0;
bool serialLineOverflow = false;

uint32_t nextUploadAttemptAt = 0;
uint8_t consecutiveUploadFailures = 0;
uint32_t lastUploadWaitLogAt = 0;

// HTTPS/TLS chay tren task rieng de khong chiem het stack mac dinh cua loopTask.
// Tham so stack cua FreeRTOS tren ESP32 duoc tinh theo byte.
const uint32_t GOOGLE_UPLOAD_TASK_STACK_BYTES = 16384;

enum UploadWorkerState : uint8_t {
  UPLOAD_WORKER_IDLE,
  UPLOAD_WORKER_RUNNING,
  UPLOAD_WORKER_FINISHED
};

portMUX_TYPE uploadWorkerMux = portMUX_INITIALIZER_UNLOCKED;
TaskHandle_t uploadWorkerHandle = nullptr;
UploadWorkerState uploadWorkerState = UPLOAD_WORKER_IDLE;
SensorReading uploadWorkerReading = {};
GoogleSheetSendResult uploadWorkerResult = {};
UBaseType_t uploadWorkerMinimumFreeStack = 0;

// ============================================================
// TLS CLOCK CONFIG
// Dong ho nay chi dung de xac thuc chung chi TLS. Date/Time tren Sheet duoc
// Apps Script tao tai thoi diem ghi du lieu.
// ============================================================
const time_t MINIMUM_VALID_EPOCH = 1704067200; // 2024-01-01 UTC
const uint32_t TIME_SYNC_RETRY_INTERVAL = 60000UL;
bool timeSyncStarted = false;
bool timeSyncAnnounced = false;
uint32_t lastTimeSyncRequestAt = 0;

bool timeReached(uint32_t now, uint32_t target) {
  return static_cast<int32_t>(now - target) >= 0;
}

bool isClockSynchronized() { return time(nullptr) >= MINIMUM_VALID_EPOCH; }

void createRequestId(SensorReading &reading) {
  const uint32_t chipId = static_cast<uint32_t>(ESP.getEfuseMac());
  snprintf(reading.requestId, sizeof(reading.requestId), "%08lX-%08lX-%08lX",
           static_cast<unsigned long>(chipId),
           static_cast<unsigned long>(millis()),
           static_cast<unsigned long>(esp_random()));
}

bool enqueueReading(const SensorReading &reading) {
  if (readingQueueCount >= READING_QUEUE_CAPACITY) {
    return false;
  }

  const uint8_t tail =
      (readingQueueHead + readingQueueCount) % READING_QUEUE_CAPACITY;
  readingQueue[tail] = reading;
  ++readingQueueCount;
  return true;
}

SensorReading *frontReading() {
  return readingQueueCount > 0 ? &readingQueue[readingQueueHead] : nullptr;
}

void popReading() {
  if (readingQueueCount == 0) {
    return;
  }
  readingQueueHead = (readingQueueHead + 1) % READING_QUEUE_CAPACITY;
  --readingQueueCount;
}

char *trimLine(char *line) {
  while (*line == ' ' || *line == '\t') {
    ++line;
  }

  char *end = line + strlen(line);
  while (end > line && (end[-1] == ' ' || end[-1] == '\t')) {
    --end;
  }
  *end = '\0';
  return line;
}

bool equalsIgnoreCase(const char *left, const char *right) {
  while (*left && *right) {
    if (tolower(static_cast<unsigned char>(*left)) !=
        tolower(static_cast<unsigned char>(*right))) {
      return false;
    }
    ++left;
    ++right;
  }
  return *left == '\0' && *right == '\0';
}

bool parseSerialReading(char *line, SensorReading &reading) {
  float values[4];
  char *cursor = line;

  for (uint8_t index = 0; index < 4; ++index) {
    while (*cursor == ' ' || *cursor == '\t') {
      ++cursor;
    }

    errno = 0;
    char *numberEnd = nullptr;
    values[index] = strtof(cursor, &numberEnd);
    if (numberEnd == cursor || errno == ERANGE || !isfinite(values[index])) {
      return false;
    }

    cursor = numberEnd;
    while (*cursor == ' ' || *cursor == '\t') {
      ++cursor;
    }

    if (index < 3) {
      if (*cursor != ',' && *cursor != ';') {
        return false;
      }
      ++cursor;
    } else if (*cursor != '\0') {
      return false;
    }
  }

  reading.x = values[0];
  reading.y = values[1];
  reading.z = values[2];
  reading.battery = values[3];
  snprintf(reading.towerId, sizeof(reading.towerId), "%s", DEFAULT_TOWER_ID);
  reading.requestId[0] = '\0';
  return isSensorReadingValid(reading);
}

void processCompletedSerialLine() {
  serialLine[serialLineLength] = '\0';
  char *line = trimLine(serialLine);

  if (!line[0]) {
    return;
  }

  SensorReading reading = {};
  if (!parseSerialReading(line, reading)) {
    Serial.println("[DATA][FAIL] Sai dinh dang/gioi han. Vi du: 1.25,-2.50,0.75,12.40");
    return;
  }

  createRequestId(reading);
  if (!enqueueReading(reading)) {
    Serial.println("[DATA][FAIL] Hang doi day (8 mau). Hay doi gui xong roi nhap lai.");
    return;
  }

  Serial.printf("[DATA][OK] Da xep hang #%u: X=%.3f, Y=%.3f, Z=%.3f, Battery=%.3f\n",
                static_cast<unsigned>(readingQueueCount), reading.x, reading.y, reading.z,
                reading.battery);
}

void processSerialInput() {
  while (Serial.available() > 0) {
    const char character = static_cast<char>(Serial.read());

    if (character == '\r') {
      continue;
    }
    if (character == '\n') {
      if (serialLineOverflow) {
        Serial.println("[DATA][FAIL] Dong nhap qua dai, da bo qua.");
      } else {
        processCompletedSerialLine();
      }
      serialLineLength = 0;
      serialLineOverflow = false;
      continue;
    }
    if (character == '\b' || character == 127) {
      if (serialLineLength > 0) {
        --serialLineLength;
      }
      continue;
    }
    if (!isprint(static_cast<unsigned char>(character)) || serialLineOverflow) {
      continue;
    }

    if (serialLineLength + 1 < sizeof(serialLine)) {
      serialLine[serialLineLength++] = character;
    } else {
      serialLineOverflow = true;
    }
  }
}

void maintainTimeSync() {
  if (WiFi.status() != WL_CONNECTED || isClockSynchronized()) {
    if (isClockSynchronized() && !timeSyncAnnounced) {
      Serial.println("[TIME][OK] Da dong bo thoi gian cho TLS.");
      timeSyncAnnounced = true;
    }
    return;
  }

  const uint32_t now = millis();
  if (!timeSyncStarted ||
      now - lastTimeSyncRequestAt >= TIME_SYNC_RETRY_INTERVAL) {
    configTime(0, 0, "time.google.com", "pool.ntp.org");
    lastTimeSyncRequestAt = now;
    timeSyncStarted = true;
    Serial.println("[TIME] Dang dong bo thoi gian NTP cho HTTPS...");
  }
}

uint32_t uploadRetryDelay() {
  const uint8_t failedAttempts =
      consecutiveUploadFailures > 0 ? consecutiveUploadFailures - 1 : 0;
  const uint8_t exponent = failedAttempts > 4 ? 4 : failedAttempts;
  const uint32_t retryDelay = 5000UL << exponent;
  return retryDelay > 60000UL ? 60000UL : retryDelay;
}

void googleSheetUploadTask(void *parameter) {
  (void)parameter;

  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    SensorReading reading = {};
    bool hasWork = false;
    portENTER_CRITICAL(&uploadWorkerMux);
    if (uploadWorkerState == UPLOAD_WORKER_RUNNING) {
      reading = uploadWorkerReading;
      hasWork = true;
    }
    portEXIT_CRITICAL(&uploadWorkerMux);

    if (!hasWork) {
      continue;
    }

    const GoogleSheetSendResult result = googleSheet.send(reading);
    const UBaseType_t minimumFreeStack = uxTaskGetStackHighWaterMark(nullptr);

    portENTER_CRITICAL(&uploadWorkerMux);
    uploadWorkerResult = result;
    uploadWorkerMinimumFreeStack = minimumFreeStack;
    uploadWorkerState = UPLOAD_WORKER_FINISHED;
    portEXIT_CRITICAL(&uploadWorkerMux);
  }
}

bool beginGoogleSheetUploadWorker() {
  if (uploadWorkerHandle) {
    return true;
  }

  const BaseType_t taskResult =
      xTaskCreate(googleSheetUploadTask, "GoogleSheetUpload",
                  GOOGLE_UPLOAD_TASK_STACK_BYTES, nullptr, 1,
                  &uploadWorkerHandle);
  if (taskResult != pdPASS) {
    uploadWorkerHandle = nullptr;
    return false;
  }
  return true;
}

bool isGoogleSheetUploadBusy() {
  bool busy = false;
  portENTER_CRITICAL(&uploadWorkerMux);
  busy = uploadWorkerState != UPLOAD_WORKER_IDLE;
  portEXIT_CRITICAL(&uploadWorkerMux);
  return busy;
}

bool startGoogleSheetUpload(const SensorReading &reading) {
  TaskHandle_t worker = nullptr;

  portENTER_CRITICAL(&uploadWorkerMux);
  if (uploadWorkerHandle && uploadWorkerState == UPLOAD_WORKER_IDLE) {
    uploadWorkerReading = reading;
    uploadWorkerState = UPLOAD_WORKER_RUNNING;
    worker = uploadWorkerHandle;
  }
  portEXIT_CRITICAL(&uploadWorkerMux);

  if (!worker) {
    return false;
  }
  xTaskNotifyGive(worker);
  return true;
}

bool takeGoogleSheetUploadResult(GoogleSheetSendResult &result,
                                 UBaseType_t &minimumFreeStack) {
  bool available = false;

  portENTER_CRITICAL(&uploadWorkerMux);
  if (uploadWorkerState == UPLOAD_WORKER_FINISHED) {
    result = uploadWorkerResult;
    minimumFreeStack = uploadWorkerMinimumFreeStack;
    uploadWorkerState = UPLOAD_WORKER_IDLE;
    available = true;
  }
  portEXIT_CRITICAL(&uploadWorkerMux);
  return available;
}

void processPendingUploads() {
  GoogleSheetSendResult completedResult = {};
  UBaseType_t minimumFreeStack = 0;
  if (takeGoogleSheetUploadResult(completedResult, minimumFreeStack)) {
    Serial.printf("[GSHEET] HTTP=%d, %s\n", completedResult.httpStatus,
                  completedResult.message);
    Serial.printf("[GSHEET][TASK] Stack trong toi thieu: %u byte.\n",
                  static_cast<unsigned>(minimumFreeStack));

    if (completedResult.success()) {
      popReading();
      consecutiveUploadFailures = 0;
      nextUploadAttemptAt = millis() + 1000UL;
      Serial.printf("[GSHEET][OK] Con %u mau trong hang doi.%s\n",
                    static_cast<unsigned>(readingQueueCount),
                    completedResult.duplicate
                        ? " Server da loai bo ban ghi trung."
                        : "");
    } else {
      if (completedResult.status ==
          GoogleSheetSendStatus::CONFIRMATION_PENDING) {
        nextUploadAttemptAt = millis() + 3000UL;
        Serial.println(
            "[GSHEET][CONFIRM] Se chi doc lai URL xac nhan sau 3 giay; "
            "khong gui lai POST.");
        return;
      }

      if (consecutiveUploadFailures < 10) {
        ++consecutiveUploadFailures;
      }
      const uint32_t retryDelay =
          completedResult.status == GoogleSheetSendStatus::RETRYABLE_ERROR
              ? uploadRetryDelay()
              : 60000UL;
      nextUploadAttemptAt = millis() + retryDelay;
      Serial.printf(
          "[GSHEET][RETRY] Thu lai sau %lu giay. Du lieu van duoc giu.\n",
          static_cast<unsigned long>(retryDelay / 1000UL));
    }
  }

  if (isGoogleSheetUploadBusy()) {
    return;
  }

  SensorReading *reading = frontReading();
  if (!reading) {
    return;
  }

  const uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }
  if (!googleSheet.isConfigured()) {
    if (now - lastUploadWaitLogAt >= 30000UL || lastUploadWaitLogAt == 0) {
      Serial.println("[GSHEET][WAIT] Hay dien Deployment ID va Shared Secret.");
      lastUploadWaitLogAt = now;
    }
    return;
  }
  if (!isClockSynchronized()) {
    if (now - lastUploadWaitLogAt >= 10000UL || lastUploadWaitLogAt == 0) {
      Serial.println("[GSHEET][WAIT] Dang cho dong bo thoi gian TLS...");
      lastUploadWaitLogAt = now;
    }
    return;
  }
  if (!timeReached(now, nextUploadAttemptAt)) {
    return;
  }

  if (!uploadWorkerHandle) {
    if (now - lastUploadWaitLogAt >= 30000UL || lastUploadWaitLogAt == 0) {
      Serial.println(
          "[GSHEET][TASK][FAIL] Khong co task HTTPS; du lieu van duoc giu.");
      lastUploadWaitLogAt = now;
    }
    return;
  }

  if (googleSheet.hasPendingConfirmation(*reading)) {
    Serial.printf(
        "[GSHEET][CONFIRM] Dang doc xac nhan cho %s (khong gui lai POST)...\n",
        reading->requestId);
  } else {
    Serial.printf("[GSHEET] Dang gui %s den sheet %s (%u mau dang cho)...\n",
                  reading->requestId, reading->towerId,
                  static_cast<unsigned>(readingQueueCount));
  }
  if (!startGoogleSheetUpload(*reading)) {
    nextUploadAttemptAt = millis() + 5000UL;
    Serial.println(
        "[GSHEET][TASK][FAIL] Khong khoi dong duoc lan gui; se thu lai.");
  }
}

// ============================================================
// WIFI EVENT CALLBACK
// Chi cap nhat trang thai tai callback; OLED duoc ve trong loop().
// ============================================================
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

  if (!beginGoogleSheetUploadWorker()) {
    Serial.println(
        "[GSHEET][TASK][FAIL] Khong du RAM de tao task HTTPS 16 KB.");
  } else {
    Serial.println("[GSHEET][TASK][OK] Da tao task HTTPS rieng 16 KB.");
  }

  if (!connectEffect.begin(OLED_SDA, OLED_SCL, OLED_ADDRESS)) {
    Serial.println("[OLED] Khong tim thay OLED SH1106 tai dia chi 0x3C.");
    Serial.println("[OLED] WiFi van tiep tuc hoat dong khong co man hinh.");
  } else {
    Serial.println("[OLED] Khoi tao OLED SH1106 thanh cong.");
  }

  connectEffect.ConnectingEffect(ConnectionType::WIFI);

  if (!googleSheet.isConfigured()) {
    Serial.println("[GSHEET][CONFIG] Chua cau hinh Google Apps Script trong Master.ino.");
  }

  WiFi.onEvent(WiFiEvent);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
}

void loop() {
  processSerialInput();

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
        if (connectEffect.isReady()) {
          delay(700);
        }
        ESP.restart();
      }
      break;
    }
  }

  maintainTimeSync();
  processPendingUploads();
}
