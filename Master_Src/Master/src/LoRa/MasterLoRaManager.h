#ifndef MASTER_LORA_MANAGER_H
#define MASTER_LORA_MANAGER_H

#include <Arduino.h>

#include "../LoRa_E32/LoRa_E32.h"
#include "LoRaProtocol.h"

enum class MasterLoRaStatus : uint8_t {
  STANDBY,
  RECEIVING,
  ACKNOWLEDGING,
  ERROR,
  DISCONNECTED
};

struct MasterTelemetry {
  uint16_t nodeId;
  uint32_t messageId;
  float xDegrees;
  float yDegrees;
  float zDegrees;
  float temperatureCelsius;
  float batteryVoltage;
  uint8_t validFlags;

  MasterTelemetry()
      : nodeId(0),
        messageId(0),
        xDegrees(NAN),
        yDegrees(NAN),
        zDegrees(NAN),
        temperatureCelsius(NAN),
        batteryVoltage(NAN),
        validFlags(0) {}
};

class MasterLoRaManager {
public:
  MasterLoRaManager(HardwareSerial &serial, int8_t rxPin, int8_t txPin,
                    int8_t auxPin, int8_t m0Pin, int8_t m1Pin,
                    uint16_t expectedNodeId);

  bool begin(uint32_t now);
  void update(uint32_t now);

  MasterLoRaStatus status() const;
  bool isReady() const;
  uint8_t knownNodeCount() const;
  const MasterTelemetry &latestTelemetry() const;
  bool peekNewTelemetry(MasterTelemetry &telemetry) const;
  bool markTelemetryConsumed(uint16_t nodeId, uint32_t messageId,
                             bool duplicate = false);
  bool takeNewTelemetry(MasterTelemetry &telemetry);

private:
  struct RecentMessage {
    uint16_t nodeId;
    uint32_t messageId;
    bool valid;
  };

  static constexpr uint8_t DEDUP_HISTORY_SIZE = 8U;
  static constexpr uint8_t MAX_RX_BYTES_PER_UPDATE = 64U;
  static constexpr uint32_t AUX_STABLE_MS = 3UL;
  static constexpr uint32_t RX_DISPLAY_MS = 80UL;
  static constexpr uint32_t ACK_DISPLAY_MS = 350UL;
  static constexpr uint32_t ACK_TX_MIN_MS = 30UL;
  static constexpr uint32_t ACK_TX_TIMEOUT_MS = 1500UL;
  static constexpr uint32_t ERROR_DISPLAY_MS = 700UL;

  HardwareSerial &_serial;
  LoRa_E32 _radio;
  int8_t _auxPin;
  uint16_t _expectedNodeId;
  bool _ready;
  MasterLoRaStatus _status;
  uint32_t _statusUntil;

  TowerLoRaProtocol::PacketParser _parser;
  RecentMessage _recentMessages[DEDUP_HISTORY_SIZE];
  uint8_t _recentMessageIndex;
  uint8_t _knownNodeCount;

  MasterTelemetry _latestTelemetry;
  bool _newTelemetry;

  TowerLoRaProtocol::AckPacket _pendingAck;
  bool _ackPending;
  bool _ackInProgress;
  bool _ackSawAuxBusy;
  uint32_t _ackQueuedAt;
  uint32_t _ackEarliestAt;
  uint32_t _ackSentAt;
  uint32_t _auxHighSince;

  static bool timeReached(uint32_t now, uint32_t deadline);
  bool isAuxStableReady(uint32_t now);
  void setTransientStatus(MasterLoRaStatus status, uint32_t until);
  void processSerial(uint32_t now);
  void handleData(const TowerLoRaProtocol::DataPacket &packet,
                  uint32_t now);
  bool isDuplicate(uint16_t nodeId, uint32_t messageId) const;
  void remember(uint16_t nodeId, uint32_t messageId);
  void storeTelemetry(const TowerLoRaProtocol::DataPacket &packet);
  void queueAck(uint16_t nodeId, uint32_t messageId, bool duplicate,
                uint32_t now);
  void sendPendingAck(uint32_t now);
  void monitorAckTransmission(uint32_t now);
};

#endif
