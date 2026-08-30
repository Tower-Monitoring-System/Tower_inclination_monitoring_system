#ifndef GOOGLE_SHEET_UPLOADER_H
#define GOOGLE_SHEET_UPLOADER_H

#include <Arduino.h>
#include <Preferences.h>
#include <WiFiClientSecure.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <time.h>

#include "../LoRa/MasterLoRaManager.h"

enum class GoogleSheetUploadState : uint8_t {
  READY,
  WAITING,
  SENDING,
  SUCCESS,
  FAILED,
  CONFIG_ERROR
};

enum class TelemetryEnqueueResult : uint8_t {
  QUEUED,
  DUPLICATE,
  FULL,
  INVALID,
  STORAGE_ERROR
};

struct GoogleSheetUploaderConfig {
  const char *scriptUrl;
  const char *sharedSecret;
  const char *towerId;
  uint16_t expectedNodeId;
  const char *rootCertificate;
  bool allowInsecureTls;
  uint32_t connectTimeoutMs;
  uint32_t writeTimeoutMs;
  uint32_t initialRetryMs;
  uint32_t maximumRetryMs;
};

/**
 * Persistent telemetry queue and asynchronous Google Sheet uploader.
 *
 * HTTPS runs only in a dedicated FreeRTOS task. A record is removed as soon
 * as its complete HTTP request has been written to TLS; no response is read.
 * enqueue() writes one compact record to NVS and never overwrites older data.
 */
class GoogleSheetUploader {
public:
  explicit GoogleSheetUploader(const GoogleSheetUploaderConfig &config);

  bool begin();
  TelemetryEnqueueResult enqueue(const MasterTelemetry &telemetry,
                                 time_t sampleEpoch);
  bool clearQueue();

  uint8_t pendingCount() const;
  GoogleSheetUploadState state() const;
  bool isConfigured() const;

private:
  enum class RemoveFrontResult : uint8_t {
    REMOVED,
    STALE,
    STORAGE_ERROR
  };

  static constexpr uint8_t MAX_QUEUE_RECORDS = 32U;
  static constexpr uint32_t RECORD_MAGIC = 0x47535131UL;  // "GSQ1"
  static constexpr uint16_t RECORD_VERSION = 2U;
  static constexpr int64_t MINIMUM_VALID_EPOCH = 1704067200LL;
  static constexpr uint32_t TASK_STACK_SIZE = 9216U;

  struct StoredTelemetryRecord {
    uint32_t magic;
    uint16_t version;
    uint16_t nodeId;
    uint32_t messageId;
    uint64_t sequence;
    int64_t sampleEpoch;
    uint32_t capturedAtMillis;
    uint32_t bootId;
    float xDegrees;
    float yDegrees;
    float zDegrees;
    float temperatureCelsius;
    float batteryVoltage;
    uint8_t validFlags;
    uint8_t reserved[3];
    uint32_t checksum;
  };

  GoogleSheetUploaderConfig _config;
  Preferences _preferences;
  SemaphoreHandle_t _mutex;
  TaskHandle_t _taskHandle;
  StoredTelemetryRecord _records[MAX_QUEUE_RECORDS];
  uint64_t _nextSequence;
  uint32_t _bootId;
  uint32_t _queueGeneration;
  volatile uint8_t _pendingCount;
  volatile GoogleSheetUploadState _state;
  bool _configured;
  bool _started;

  static void taskEntry(void *context);
  void taskLoop();

  bool loadQueue();
  bool validateConfiguration() const;
  bool lock();
  void unlock();
  void makeSlotKey(uint8_t slot, char *key, size_t keySize) const;
  int findFrontSlotLocked() const;
  int findFreeSlotLocked() const;
  bool containsMessageLocked(uint16_t nodeId, uint32_t messageId) const;
  bool peekFront(StoredTelemetryRecord &record, uint8_t &slot,
                 uint32_t &generation);
  RemoveFrontResult removeFront(uint8_t slot, uint64_t sequence,
                                uint32_t messageId, uint32_t generation);
  bool setFrontTimestamp(uint8_t slot, uint64_t sequence,
                         int64_t sampleEpoch, uint32_t generation);
  bool persistSlotLocked(uint8_t slot,
                         const StoredTelemetryRecord &record);
  uint32_t queueGeneration();
  void notifyTask();
  void waitForTaskSignal(uint32_t timeoutMs);

  bool uploadRecord(const StoredTelemetryRecord &record,
                    uint32_t generation);
  size_t writeAll(WiFiClientSecure &client, const uint8_t *data,
                  size_t length, uint32_t timeoutMs,
                  uint32_t generation);
  bool isGenerationCurrent(uint32_t generation);
  bool buildPayload(const StoredTelemetryRecord &record, String &payload);
  bool buildHttpHeader(const String &path, size_t payloadLength,
                       String &header) const;
  bool extractScriptPath(String &path) const;

  static uint32_t calculateChecksum(const StoredTelemetryRecord &record);
  static bool isRecordValid(const StoredTelemetryRecord &record);
  static bool isTelemetryValid(const MasterTelemetry &telemetry,
                               uint16_t expectedNodeId);
};

#endif
