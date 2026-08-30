#include "GoogleSheetUploader.h"

#include <WiFi.h>
#include <esp_system.h>
#include <math.h>
#include <stddef.h>
#include <string.h>
#include <time.h>

#include "../ArduinoJson.h"

using namespace TowerLoRaProtocol;

namespace {
constexpr char PREFERENCES_NAMESPACE[] = "gs_queue";
constexpr char SCRIPT_HOST[] = "script.google.com";
constexpr uint16_t SCRIPT_HTTPS_PORT = 443U;
constexpr size_t MAXIMUM_WRITE_CHUNK_BYTES = 512U;
constexpr uint8_t REQUIRED_UPLOAD_FLAGS =
    FLAG_X_VALID | FLAG_Y_VALID | FLAG_Z_VALID | FLAG_BATTERY_VALID;
constexpr uint32_t IDLE_TASK_DELAY_MS = 250UL;
constexpr uint32_t WAITING_TASK_DELAY_MS = 1000UL;
constexpr uint32_t SUCCESS_IDLE_DISPLAY_MS = 150UL;
constexpr uint32_t CONFIG_RECHECK_MS = 10000UL;
constexpr uint32_t MAXIMUM_TIMESTAMP_RECOVERY_AGE_SECONDS =
    7UL * 24UL * 60UL * 60UL;

}  // namespace

GoogleSheetUploader::GoogleSheetUploader(
    const GoogleSheetUploaderConfig &config)
    : _config(config),
      _preferences(),
      _mutex(nullptr),
      _taskHandle(nullptr),
      _records{},
      _nextSequence(1U),
      _bootId(0U),
      _queueGeneration(1U),
      _pendingCount(0U),
      _state(GoogleSheetUploadState::READY),
      _configured(false),
      _started(false) {}

bool GoogleSheetUploader::begin() {
  if (_started) {
    return true;
  }

  _bootId = esp_random();
  if (_bootId == 0U) {
    _bootId = 1U;
  }

  _mutex = xSemaphoreCreateMutex();
  if (_mutex == nullptr) {
    Serial.println("[GSHEET] Khong tao duoc queue mutex");
    _state = GoogleSheetUploadState::CONFIG_ERROR;
    return false;
  }

  if (!_preferences.begin(PREFERENCES_NAMESPACE, false)) {
    Serial.println("[GSHEET] Khong mo duoc NVS persistent queue");
    _state = GoogleSheetUploadState::CONFIG_ERROR;
    return false;
  }

  if (!loadQueue()) {
    Serial.println("[GSHEET] Persistent queue khoi tao that bai");
    _state = GoogleSheetUploadState::CONFIG_ERROR;
    return false;
  }

  _configured = validateConfiguration();
  if (!_configured) {
    Serial.println(
        "[GSHEET] CHUA CAU HINH: cap nhat SCRIPT_URL va SHARED_SECRET");
    _state = GoogleSheetUploadState::CONFIG_ERROR;
  }

  const BaseType_t taskCreated = xTaskCreatePinnedToCore(
      taskEntry, "GoogleSheetUpload", TASK_STACK_SIZE, this, 1, &_taskHandle,
      0);
  if (taskCreated != pdPASS) {
    Serial.println("[GSHEET] Khong tao duoc uploader task");
    _state = GoogleSheetUploadState::CONFIG_ERROR;
    return false;
  }

  _started = true;
  Serial.printf("[GSHEET] Queue san sang, pending=%u/%u\n",
                static_cast<unsigned>(_pendingCount),
                static_cast<unsigned>(MAX_QUEUE_RECORDS));
  return true;
}

TelemetryEnqueueResult GoogleSheetUploader::enqueue(
    const MasterTelemetry &telemetry, time_t sampleEpoch) {
  if (!_started || !isTelemetryValid(telemetry, _config.expectedNodeId)) {
    return !_started ? TelemetryEnqueueResult::STORAGE_ERROR
                     : TelemetryEnqueueResult::INVALID;
  }

  if (!lock()) {
    return TelemetryEnqueueResult::STORAGE_ERROR;
  }

  if (containsMessageLocked(telemetry.nodeId, telemetry.messageId)) {
    unlock();
    return TelemetryEnqueueResult::DUPLICATE;
  }

  const int freeSlot = findFreeSlotLocked();
  if (freeSlot < 0) {
    unlock();
    return TelemetryEnqueueResult::FULL;
  }

  StoredTelemetryRecord record{};
  record.magic = RECORD_MAGIC;
  record.version = RECORD_VERSION;
  record.nodeId = telemetry.nodeId;
  record.messageId = telemetry.messageId;
  record.sequence = _nextSequence;
  record.sampleEpoch = static_cast<int64_t>(sampleEpoch);
  record.capturedAtMillis = millis();
  record.bootId = _bootId;
  record.xDegrees = telemetry.xDegrees;
  record.yDegrees = telemetry.yDegrees;
  record.zDegrees = telemetry.zDegrees;
  record.temperatureCelsius = telemetry.temperatureCelsius;
  record.batteryVoltage = telemetry.batteryVoltage;
  record.validFlags = telemetry.validFlags;
  record.checksum = calculateChecksum(record);

  const uint8_t slot = static_cast<uint8_t>(freeSlot);
  if (!persistSlotLocked(slot, record)) {
    unlock();
    return TelemetryEnqueueResult::STORAGE_ERROR;
  }

  _records[slot] = record;
  ++_nextSequence;
  ++_pendingCount;
  unlock();
  notifyTask();
  return TelemetryEnqueueResult::QUEUED;
}

bool GoogleSheetUploader::clearQueue() {
  if (!_started || !lock()) {
    return false;
  }

  if (!_preferences.clear()) {
    unlock();
    Serial.println("[QUEUE] CLEAR FAILED: loi NVS");
    return false;
  }

  memset(_records, 0, sizeof(_records));
  _pendingCount = 0U;
  _nextSequence = 1U;
  ++_queueGeneration;
  if (_queueGeneration == 0U) {
    _queueGeneration = 1U;
  }
  _state = _configured ? GoogleSheetUploadState::READY
                       : GoogleSheetUploadState::CONFIG_ERROR;
  unlock();

  notifyTask();
  return true;
}

uint8_t GoogleSheetUploader::pendingCount() const { return _pendingCount; }

GoogleSheetUploadState GoogleSheetUploader::state() const { return _state; }

bool GoogleSheetUploader::isConfigured() const { return _configured; }

void GoogleSheetUploader::taskEntry(void *context) {
  static_cast<GoogleSheetUploader *>(context)->taskLoop();
}

void GoogleSheetUploader::taskLoop() {
  uint32_t retryDelayMs = _config.initialRetryMs;
  uint32_t retryGeneration = queueGeneration();

  for (;;) {
    const uint32_t currentGeneration = queueGeneration();
    if (currentGeneration != retryGeneration) {
      retryGeneration = currentGeneration;
      retryDelayMs = _config.initialRetryMs;
    }

    StoredTelemetryRecord record{};
    uint8_t slot = 0U;
    uint32_t recordGeneration = 0U;
    if (!peekFront(record, slot, recordGeneration)) {
      _state = _configured ? GoogleSheetUploadState::READY
                           : GoogleSheetUploadState::CONFIG_ERROR;
      waitForTaskSignal(IDLE_TASK_DELAY_MS);
      continue;
    }

    if (!_configured) {
      _state = GoogleSheetUploadState::CONFIG_ERROR;
      waitForTaskSignal(CONFIG_RECHECK_MS);
      continue;
    }

    if (WiFi.status() != WL_CONNECTED) {
      _state = GoogleSheetUploadState::FAILED;
      waitForTaskSignal(WAITING_TASK_DELAY_MS);
      continue;
    }

    if (record.sampleEpoch < MINIMUM_VALID_EPOCH) {
      const time_t synchronizedTime = time(nullptr);
      if (static_cast<int64_t>(synchronizedTime) < MINIMUM_VALID_EPOCH) {
        _state = GoogleSheetUploadState::WAITING;
        waitForTaskSignal(WAITING_TASK_DELAY_MS);
        continue;
      }

      int64_t recoveredSampleTime = static_cast<int64_t>(synchronizedTime);
      if (record.bootId == _bootId) {
        const uint32_t ageSeconds =
            (millis() - record.capturedAtMillis) / 1000UL;
        if (ageSeconds <= MAXIMUM_TIMESTAMP_RECOVERY_AGE_SECONDS &&
            recoveredSampleTime - static_cast<int64_t>(ageSeconds) >=
                MINIMUM_VALID_EPOCH) {
          recoveredSampleTime -= static_cast<int64_t>(ageSeconds);
        }
      }

      if (!setFrontTimestamp(slot, record.sequence, recoveredSampleTime,
                             recordGeneration)) {
        if (queueGeneration() != recordGeneration) {
          retryDelayMs = _config.initialRetryMs;
          continue;
        }
        _state = GoogleSheetUploadState::FAILED;
        waitForTaskSignal(retryDelayMs);
        retryDelayMs =
            retryDelayMs >= _config.maximumRetryMs / 2U
                ? _config.maximumRetryMs
                : retryDelayMs * 2U;
        continue;
      }
      record.sampleEpoch = recoveredSampleTime;
      Serial.printf("[GSHEET] ID=%lu khoi phuc timestamp tu NTP\n",
                    static_cast<unsigned long>(record.messageId));
    }

    _state = GoogleSheetUploadState::SENDING;
    Serial.printf("[GSHEET] ID=%lu Sending, pending=%u\n",
                  static_cast<unsigned long>(record.messageId),
                  static_cast<unsigned>(_pendingCount));

    if (uploadRecord(record, recordGeneration)) {
      const RemoveFrontResult removeResult =
          removeFront(slot, record.sequence, record.messageId,
                      recordGeneration);
      if (removeResult == RemoveFrontResult::REMOVED) {
        Serial.printf("[GSHEET] ID=%lu SENT -> removeFront\n",
                      static_cast<unsigned long>(record.messageId));
        Serial.printf("[GSHEET] pending=%u\n",
                      static_cast<unsigned>(_pendingCount));
        _state = GoogleSheetUploadState::SUCCESS;
        retryDelayMs = _config.initialRetryMs;
        if (_pendingCount == 0U) {
          waitForTaskSignal(SUCCESS_IDLE_DISPLAY_MS);
        }
        continue;
      }
      if (removeResult == RemoveFrontResult::STALE) {
        Serial.printf("[GSHEET] ID=%lu queue da CLEAR sau khi gui\n",
                      static_cast<unsigned long>(record.messageId));
        retryDelayMs = _config.initialRetryMs;
        continue;
      }
      Serial.printf("[GSHEET] ID=%lu NVS dequeue failed; se retry cung ID\n",
                    static_cast<unsigned long>(record.messageId));
    } else if (queueGeneration() != recordGeneration) {
      retryDelayMs = _config.initialRetryMs;
      continue;
    }

    _state = GoogleSheetUploadState::FAILED;
    Serial.printf("[GSHEET] ID=%lu Retry sau %lu ms\n",
                  static_cast<unsigned long>(record.messageId),
                  static_cast<unsigned long>(retryDelayMs));
    waitForTaskSignal(retryDelayMs);
    if (queueGeneration() == recordGeneration) {
      retryDelayMs = retryDelayMs >= _config.maximumRetryMs / 2U
                         ? _config.maximumRetryMs
                         : retryDelayMs * 2U;
    } else {
      retryDelayMs = _config.initialRetryMs;
    }
  }
}

bool GoogleSheetUploader::loadQueue() {
  if (!lock()) {
    return false;
  }

  memset(_records, 0, sizeof(_records));
  _pendingCount = 0U;
  _nextSequence = 1U;

  for (uint8_t slot = 0U; slot < MAX_QUEUE_RECORDS; ++slot) {
    char key[8];
    makeSlotKey(slot, key, sizeof(key));
    const size_t storedSize = _preferences.getBytesLength(key);
    if (storedSize == 0U) {
      continue;
    }

    StoredTelemetryRecord record{};
    const size_t loaded =
        storedSize == sizeof(record)
            ? _preferences.getBytes(key, &record, sizeof(record))
            : 0U;
    if (loaded != sizeof(record) || !isRecordValid(record)) {
      Serial.printf("[GSHEET] Xoa queue slot hong: %s\n", key);
      _preferences.remove(key);
      continue;
    }

    _records[slot] = record;
    ++_pendingCount;
    if (record.sequence >= _nextSequence) {
      _nextSequence = record.sequence + 1U;
    }
  }

  unlock();
  return true;
}

bool GoogleSheetUploader::validateConfiguration() const {
  if (_config.scriptUrl == nullptr || _config.sharedSecret == nullptr ||
      _config.towerId == nullptr || _config.expectedNodeId == 0U ||
      _config.connectTimeoutMs == 0U || _config.writeTimeoutMs == 0U ||
      _config.initialRetryMs == 0U || _config.maximumRetryMs == 0U ||
      _config.connectTimeoutMs > 60000UL ||
      _config.writeTimeoutMs > 60000UL ||
      _config.initialRetryMs > _config.maximumRetryMs) {
    return false;
  }

  const String url(_config.scriptUrl);
  const String secret(_config.sharedSecret);
  if (!url.startsWith("https://script.google.com/macros/s/") ||
      !url.endsWith("/exec") || url.indexOf("REPLACE_") >= 0 ||
      secret.length() < 16U || secret.indexOf("REPLACE_") >= 0 ||
      strcmp(_config.towerId, "TWR-01") != 0 ||
      _config.expectedNodeId != 1U) {
    return false;
  }

  const bool hasRootCertificate =
      _config.rootCertificate != nullptr && _config.rootCertificate[0] != '\0';
  return hasRootCertificate || _config.allowInsecureTls;
}

bool GoogleSheetUploader::lock() {
  return _mutex != nullptr &&
         xSemaphoreTake(_mutex, portMAX_DELAY) == pdTRUE;
}

void GoogleSheetUploader::unlock() { xSemaphoreGive(_mutex); }

void GoogleSheetUploader::makeSlotKey(uint8_t slot, char *key,
                                      size_t keySize) const {
  snprintf(key, keySize, "q%02u", static_cast<unsigned>(slot));
}

int GoogleSheetUploader::findFrontSlotLocked() const {
  int frontSlot = -1;
  uint64_t lowestSequence = UINT64_MAX;
  for (uint8_t slot = 0U; slot < MAX_QUEUE_RECORDS; ++slot) {
    if (_records[slot].magic == RECORD_MAGIC &&
        (frontSlot < 0 || _records[slot].sequence < lowestSequence)) {
      lowestSequence = _records[slot].sequence;
      frontSlot = slot;
    }
  }
  return frontSlot;
}

int GoogleSheetUploader::findFreeSlotLocked() const {
  for (uint8_t slot = 0U; slot < MAX_QUEUE_RECORDS; ++slot) {
    if (_records[slot].magic != RECORD_MAGIC) {
      return slot;
    }
  }
  return -1;
}

bool GoogleSheetUploader::containsMessageLocked(uint16_t nodeId,
                                                 uint32_t messageId) const {
  for (uint8_t slot = 0U; slot < MAX_QUEUE_RECORDS; ++slot) {
    if (_records[slot].magic == RECORD_MAGIC &&
        _records[slot].nodeId == nodeId &&
        _records[slot].messageId == messageId) {
      return true;
    }
  }
  return false;
}

bool GoogleSheetUploader::peekFront(StoredTelemetryRecord &record,
                                    uint8_t &slot,
                                    uint32_t &generation) {
  if (!lock()) {
    return false;
  }
  const int frontSlot = findFrontSlotLocked();
  if (frontSlot < 0) {
    unlock();
    return false;
  }
  slot = static_cast<uint8_t>(frontSlot);
  record = _records[slot];
  generation = _queueGeneration;
  unlock();
  return true;
}

GoogleSheetUploader::RemoveFrontResult GoogleSheetUploader::removeFront(
    uint8_t slot, uint64_t sequence, uint32_t messageId,
    uint32_t generation) {
  if (!lock()) {
    return RemoveFrontResult::STORAGE_ERROR;
  }

  const int currentFront = findFrontSlotLocked();
  if (_queueGeneration != generation || currentFront != slot ||
      _records[slot].sequence != sequence ||
      _records[slot].messageId != messageId) {
    unlock();
    return RemoveFrontResult::STALE;
  }

  char key[8];
  makeSlotKey(slot, key, sizeof(key));
  if (!_preferences.remove(key)) {
    unlock();
    return RemoveFrontResult::STORAGE_ERROR;
  }

  memset(&_records[slot], 0, sizeof(_records[slot]));
  if (_pendingCount > 0U) {
    --_pendingCount;
  }
  unlock();
  return RemoveFrontResult::REMOVED;
}

bool GoogleSheetUploader::setFrontTimestamp(uint8_t slot, uint64_t sequence,
                                            int64_t sampleEpoch,
                                            uint32_t generation) {
  if (!lock()) {
    return false;
  }

  const int currentFront = findFrontSlotLocked();
  if (_queueGeneration != generation || currentFront != slot ||
      _records[slot].sequence != sequence) {
    unlock();
    return false;
  }

  StoredTelemetryRecord updated = _records[slot];
  updated.sampleEpoch = sampleEpoch;
  updated.checksum = calculateChecksum(updated);
  if (!persistSlotLocked(slot, updated)) {
    unlock();
    return false;
  }
  _records[slot] = updated;
  unlock();
  return true;
}

bool GoogleSheetUploader::persistSlotLocked(
    uint8_t slot, const StoredTelemetryRecord &record) {
  char key[8];
  makeSlotKey(slot, key, sizeof(key));
  return _preferences.putBytes(key, &record, sizeof(record)) == sizeof(record);
}

uint32_t GoogleSheetUploader::queueGeneration() {
  if (!lock()) {
    return 0U;
  }
  const uint32_t generation = _queueGeneration;
  unlock();
  return generation;
}

bool GoogleSheetUploader::isGenerationCurrent(uint32_t generation) {
  return queueGeneration() == generation;
}

size_t GoogleSheetUploader::writeAll(WiFiClientSecure &client,
                                     const uint8_t *data, size_t length,
                                     uint32_t timeoutMs,
                                     uint32_t generation) {
  if (data == nullptr || length == 0U || timeoutMs == 0U) {
    return 0U;
  }

  const uint32_t startedAt = millis();
  size_t totalWritten = 0U;
  while (totalWritten < length && isGenerationCurrent(generation)) {
    if (millis() - startedAt >= timeoutMs) {
      break;
    }

    const size_t remaining = length - totalWritten;
    const size_t chunkLength =
        remaining > MAXIMUM_WRITE_CHUNK_BYTES
            ? MAXIMUM_WRITE_CHUNK_BYTES
            : remaining;
    const size_t written = client.write(data + totalWritten, chunkLength);
    if (written > 0U) {
      totalWritten += written > chunkLength ? chunkLength : written;
      continue;
    }
    vTaskDelay(1);
  }

  return totalWritten;
}

void GoogleSheetUploader::notifyTask() {
  if (_taskHandle != nullptr) {
    xTaskNotifyGive(_taskHandle);
  }
}

void GoogleSheetUploader::waitForTaskSignal(uint32_t timeoutMs) {
  ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(timeoutMs));
}

bool GoogleSheetUploader::uploadRecord(
    const StoredTelemetryRecord &record, uint32_t generation) {
  if (!isGenerationCurrent(generation)) {
    return false;
  }

  String path;
  if (!extractScriptPath(path)) {
    Serial.println("[GSHEET] SCRIPT_URL khong hop le");
    return false;
  }

  WiFiClientSecure secureClient;
  if (_config.rootCertificate != nullptr &&
      _config.rootCertificate[0] != '\0') {
    secureClient.setCACert(_config.rootCertificate);
  } else if (_config.allowInsecureTls) {
    secureClient.setInsecure();
  } else {
    Serial.println("[GSHEET] TLS root certificate chua duoc cau hinh");
    return false;
  }

  secureClient.setTimeout(_config.writeTimeoutMs);
  const uint32_t handshakeTimeoutSeconds =
      (_config.connectTimeoutMs + 999UL) / 1000UL;
  secureClient.setHandshakeTimeout(handshakeTimeoutSeconds == 0U
                                       ? 1UL
                                       : handshakeTimeoutSeconds);

  Serial.printf("[GSHEET] ID=%lu TLS CONNECT\n",
                static_cast<unsigned long>(record.messageId));
  if (!secureClient.connect(SCRIPT_HOST, SCRIPT_HTTPS_PORT,
                            static_cast<int32_t>(_config.connectTimeoutMs))) {
    secureClient.stop();
    Serial.printf("[GSHEET] ID=%lu TLS CONNECT FAILED -> keep queue\n",
                  static_cast<unsigned long>(record.messageId));
    return false;
  }

  if (!isGenerationCurrent(generation)) {
    secureClient.stop();
    Serial.printf("[GSHEET] ID=%lu CANCELLED BY CLEAR\n",
                  static_cast<unsigned long>(record.messageId));
    return false;
  }

  String payload;
  String header;
  if (!buildPayload(record, payload) ||
      !buildHttpHeader(path, payload.length(), header)) {
    secureClient.stop();
    Serial.printf("[GSHEET] ID=%lu BUILD FAILED -> keep queue\n",
                  static_cast<unsigned long>(record.messageId));
    return false;
  }

  if (!isGenerationCurrent(generation)) {
    secureClient.stop();
    Serial.printf("[GSHEET] ID=%lu CANCELLED BY CLEAR\n",
                  static_cast<unsigned long>(record.messageId));
    return false;
  }

  const size_t headerLength = header.length();
  const size_t headerWritten = writeAll(
      secureClient, reinterpret_cast<const uint8_t *>(header.c_str()),
      headerLength, _config.writeTimeoutMs, generation);
  Serial.printf("[GSHEET] ID=%lu HEADER %u/%u\n",
                static_cast<unsigned long>(record.messageId),
                static_cast<unsigned>(headerWritten),
                static_cast<unsigned>(headerLength));

  if (headerWritten != headerLength ||
      !isGenerationCurrent(generation)) {
    secureClient.stop();
    if (isGenerationCurrent(generation)) {
      Serial.printf("[GSHEET] ID=%lu TLS/WRITE FAILED -> keep queue\n",
                    static_cast<unsigned long>(record.messageId));
    } else {
      Serial.printf("[GSHEET] ID=%lu CANCELLED BY CLEAR\n",
                    static_cast<unsigned long>(record.messageId));
    }
    return false;
  }

  const size_t payloadLength = payload.length();
  const size_t payloadWritten = writeAll(
      secureClient, reinterpret_cast<const uint8_t *>(payload.c_str()),
      payloadLength, _config.writeTimeoutMs, generation);
  Serial.printf("[GSHEET] ID=%lu PAYLOAD %u/%u\n",
                static_cast<unsigned long>(record.messageId),
                static_cast<unsigned>(payloadWritten),
                static_cast<unsigned>(payloadLength));

  if (payloadWritten != payloadLength ||
      !isGenerationCurrent(generation)) {
    secureClient.stop();
    if (isGenerationCurrent(generation)) {
      Serial.printf("[GSHEET] ID=%lu TLS/WRITE FAILED -> keep queue\n",
                    static_cast<unsigned long>(record.messageId));
    } else {
      Serial.printf("[GSHEET] ID=%lu CANCELLED BY CLEAR\n",
                    static_cast<unsigned long>(record.messageId));
    }
    return false;
  }

  // Fire-and-forget: flush() va dong TLS ngay sau khi write du request.
  // Tuyet doi khong available(), read(), HTTP status hay parse JSON response.
  secureClient.flush();
  secureClient.stop();
  return true;
}

bool GoogleSheetUploader::buildPayload(
    const StoredTelemetryRecord &record, String &payload) {
  const time_t sampleTime = static_cast<time_t>(record.sampleEpoch);
  struct tm localTime = {};
  if (!localtime_r(&sampleTime, &localTime)) {
    return false;
  }

  char dateText[11];
  char timeText[9];
  if (strftime(dateText, sizeof(dateText), "%Y-%m-%d", &localTime) == 0U ||
      strftime(timeText, sizeof(timeText), "%H:%M:%S", &localTime) == 0U) {
    return false;
  }

  char messageIdText[11];
  snprintf(messageIdText, sizeof(messageIdText), "%lu",
           static_cast<unsigned long>(record.messageId));

  JsonDocument document;
  document["action"] = "appendTelemetry";
  document["token"] = _config.sharedSecret;
  document["towerId"] = _config.towerId;
  document["nodeId"] = record.nodeId;
  document["messageId"] = messageIdText;
  document["sampleTimestamp"] = record.sampleEpoch;
  document["date"] = dateText;
  document["time"] = timeText;
  document["x"] = record.xDegrees;
  document["y"] = record.yDegrees;
  document["z"] = record.zDegrees;
  document["battery"] = record.batteryVoltage;
  if ((record.validFlags & FLAG_TEMPERATURE_VALID) != 0U &&
      isfinite(record.temperatureCelsius)) {
    document["temp"] = record.temperatureCelsius;
  } else {
    document["temp"] = nullptr;
  }
  document["validFlags"] = record.validFlags;

  payload.reserve(384U);
  return serializeJson(document, payload) > 0U;
}

bool GoogleSheetUploader::buildHttpHeader(const String &path,
                                          size_t payloadLength,
                                          String &header) const {
  if (path.length() == 0U || payloadLength == 0U ||
      path.indexOf('\r') >= 0 || path.indexOf('\n') >= 0) {
    return false;
  }

  if (!header.reserve(path.length() + 160U)) {
    return false;
  }

  header = "POST ";
  header += path;
  header += " HTTP/1.1\r\n";
  header += "Host: ";
  header += SCRIPT_HOST;
  header += "\r\n";
  header += "Content-Type: application/json\r\n";
  header += "Content-Length: ";
  header += String(static_cast<unsigned long>(payloadLength));
  header += "\r\n";
  header += "Connection: close\r\n\r\n";
  return header.length() > 0U;
}

bool GoogleSheetUploader::extractScriptPath(String &path) const {
  constexpr char URL_PREFIX[] = "https://script.google.com";
  const String url(_config.scriptUrl);
  if (!url.startsWith(URL_PREFIX)) {
    return false;
  }

  path = url.substring(strlen(URL_PREFIX));
  return path.startsWith("/macros/s/") && path.endsWith("/exec") &&
         path.indexOf(' ') < 0 && path.indexOf('\r') < 0 &&
         path.indexOf('\n') < 0;
}

uint32_t GoogleSheetUploader::calculateChecksum(
    const StoredTelemetryRecord &record) {
  const uint8_t *bytes = reinterpret_cast<const uint8_t *>(&record);
  const size_t length = offsetof(StoredTelemetryRecord, checksum);
  uint32_t hash = 2166136261UL;
  for (size_t index = 0U; index < length; ++index) {
    hash ^= bytes[index];
    hash *= 16777619UL;
  }
  return hash;
}

bool GoogleSheetUploader::isRecordValid(
    const StoredTelemetryRecord &record) {
  return record.magic == RECORD_MAGIC && record.version == RECORD_VERSION &&
         record.nodeId != 0U && record.messageId != 0U &&
         record.sequence != 0U &&
         calculateChecksum(record) == record.checksum;
}

bool GoogleSheetUploader::isTelemetryValid(
    const MasterTelemetry &telemetry, uint16_t expectedNodeId) {
  if (telemetry.nodeId != expectedNodeId || telemetry.messageId == 0U ||
      (telemetry.validFlags & REQUIRED_UPLOAD_FLAGS) != REQUIRED_UPLOAD_FLAGS) {
    return false;
  }

  return isfinite(telemetry.xDegrees) && isfinite(telemetry.yDegrees) &&
         isfinite(telemetry.zDegrees) && isfinite(telemetry.batteryVoltage) &&
         telemetry.xDegrees >= -180.0F && telemetry.xDegrees <= 180.0F &&
         telemetry.yDegrees >= -180.0F && telemetry.yDegrees <= 180.0F &&
         telemetry.zDegrees >= -180.0F && telemetry.zDegrees <= 180.0F &&
         telemetry.batteryVoltage >= 0.0F &&
         telemetry.batteryVoltage <= 24.0F;
}
