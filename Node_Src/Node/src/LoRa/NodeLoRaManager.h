#ifndef NODE_LORA_MANAGER_H
#define NODE_LORA_MANAGER_H

#include <Arduino.h>

#include "../LoRa_E32/LoRa_E32.h"
#include "../Sensors/Tower_Sensors.h"
#include "LoRaProtocol.h"

enum class NodeLoRaStatus : uint8_t {
  SLEEP,
  READY,
  SENDING,
  SUCCESS,
  RETRY,
  FAILED,
  DISCONNECTED
};

class NodeLoRaManager {
public:
  static constexpr uint32_t SAMPLE_INTERVAL_MS = 60000UL;

  NodeLoRaManager(HardwareSerial &serial, int8_t rxPin, int8_t txPin,
                  int8_t auxPin, int8_t m0Pin, int8_t m1Pin,
                  uint16_t nodeId);

  bool begin(uint32_t now);
  void update(uint32_t now, const TowerSensorData &sensorData);

  NodeLoRaStatus status() const;
  uint32_t currentMessageId() const;

private:
  enum class State : uint8_t {
    ENTERING_SLEEP,
    SLEEPING,
    DISCONNECTED_SLEEP,
    WAKING,
    READY_TO_SNAPSHOT,
    WAITING_SEND_AUX,
    WAITING_ACK,
    RETRY_DELAY,
    WAITING_RESULT_AUX
  };

  static constexpr uint32_t MODE_MIN_SETTLE_MS = 40UL;
  static constexpr uint32_t MODE_TIMEOUT_MS = 2000UL;
  static constexpr uint32_t AUX_STABLE_MS = 3UL;
  static constexpr uint32_t ACK_TIMEOUT_MS = 1500UL;
  static constexpr uint32_t RETRY_DELAY_MS = 250UL;
  static constexpr uint32_t RESULT_DISPLAY_MS = 1200UL;
  static constexpr uint8_t MAX_RETRIES = 3U;
  static constexpr uint8_t MAX_RX_BYTES_PER_UPDATE = 64U;

  HardwareSerial &_serial;
  LoRa_E32 _radio;
  int8_t _auxPin;
  uint16_t _nodeId;

  State _state;
  NodeLoRaStatus _status;
  MODE_TYPE _requestedMode;
  uint32_t _stateStartedAt;
  uint32_t _modeRequestedAt;
  uint32_t _auxHighSince;
  uint32_t _nextSampleAt;
  uint32_t _ackStartedAt;
  uint32_t _retryAt;
  uint32_t _resultVisibleUntil;
  bool _resultHoldActive;

  uint32_t _bootSessionSeed;
  uint32_t _messageSequence;
  uint8_t _attemptCount;
  TowerLoRaProtocol::DataPacket _currentPacket;
  TowerLoRaProtocol::PacketParser _parser;

  static bool timeReached(uint32_t now, uint32_t deadline);
  static int16_t quantizeSigned(float value, float scale, float minimum,
                                float maximum);
  static uint16_t quantizeUnsigned(float value, float scale, float maximum);

  void setStatus(NodeLoRaStatus status);
  bool requestMode(MODE_TYPE mode, uint32_t now);
  bool isAuxStableReady(uint32_t now);
  bool isModeReady(uint32_t now);
  bool modeTimedOut(uint32_t now) const;
  void enterDisconnectedSleep(uint32_t now, const char *reason);

  void prepareSnapshot(const TowerSensorData &sensorData);
  uint32_t nextMessageId();
  bool processIncomingAck(uint32_t now);
  void sendCurrentPacket(uint32_t now);
  void completeSession(uint32_t now, bool success);
  void requestSleepAfterResult(uint32_t now);
  void discardStaleInput();
};

#endif
