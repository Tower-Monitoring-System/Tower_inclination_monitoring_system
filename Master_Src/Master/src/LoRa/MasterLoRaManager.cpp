#include "MasterLoRaManager.h"

#include <math.h>
#include <string.h>

using namespace TowerLoRaProtocol;

MasterLoRaManager::MasterLoRaManager(HardwareSerial &serial, int8_t rxPin,
                                     int8_t txPin, int8_t auxPin,
                                     int8_t m0Pin, int8_t m1Pin,
                                     uint16_t expectedNodeId)
    : _serial(serial),
      _radio(rxPin, txPin, &serial, auxPin, m0Pin, m1Pin,
             UART_BPS_RATE_9600, SERIAL_8N1),
      _auxPin(auxPin),
      _expectedNodeId(expectedNodeId),
      _ready(false),
      _status(MasterLoRaStatus::DISCONNECTED),
      _statusUntil(0),
      _parser(),
      _recentMessages{},
      _recentMessageIndex(0),
      _knownNodeCount(0),
      _latestTelemetry(),
      _newTelemetry(false),
      _pendingAck{},
      _ackPending(false),
      _ackInProgress(false),
      _ackSawAuxBusy(false),
      _ackQueuedAt(0),
      _ackEarliestAt(0),
      _ackSentAt(0),
      _auxHighSince(0) {}

bool MasterLoRaManager::begin(uint32_t now) {
  _ready = _radio.begin();
  _parser.reset();
  _auxHighSince = 0U;

  if (!_ready) {
    _status = MasterLoRaStatus::DISCONNECTED;
    Serial.println("[LORA] Master module DISCONNECTED");
    return false;
  }

  _status = MasterLoRaStatus::STANDBY;
  _statusUntil = now;
  Serial.println("[LORA] Master STANDBY; receiver active");
  return true;
}

void MasterLoRaManager::update(uint32_t now) {
  if (!_ready) {
    return;
  }

  // Luon doc UART truoc, ke ca khi dang cho/sending ACK. Khong co readBytes,
  // String hay timeout blocking trong receive path.
  processSerial(now);
  monitorAckTransmission(now);
  sendPendingAck(now);

  if (!_ackPending && !_ackInProgress &&
      _status != MasterLoRaStatus::STANDBY &&
      _status != MasterLoRaStatus::DISCONNECTED &&
      timeReached(now, _statusUntil)) {
    _status = MasterLoRaStatus::STANDBY;
  }
}

MasterLoRaStatus MasterLoRaManager::status() const { return _status; }

bool MasterLoRaManager::isReady() const { return _ready; }

uint8_t MasterLoRaManager::knownNodeCount() const { return _knownNodeCount; }

const MasterTelemetry &MasterLoRaManager::latestTelemetry() const {
  return _latestTelemetry;
}

bool MasterLoRaManager::takeNewTelemetry(MasterTelemetry &telemetry) {
  if (!_newTelemetry) {
    return false;
  }
  telemetry = _latestTelemetry;
  _newTelemetry = false;
  return true;
}

bool MasterLoRaManager::timeReached(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

bool MasterLoRaManager::isAuxStableReady(uint32_t now) {
  if (digitalRead(_auxPin) != HIGH) {
    _auxHighSince = 0U;
    return false;
  }

  if (_auxHighSince == 0U) {
    _auxHighSince = now;
    return false;
  }
  return now - _auxHighSince >= AUX_STABLE_MS;
}

void MasterLoRaManager::setTransientStatus(MasterLoRaStatus status,
                                            uint32_t until) {
  _status = status;
  _statusUntil = until;
}

void MasterLoRaManager::processSerial(uint32_t now) {
  uint8_t processed = 0U;
  while (_serial.available() > 0 && processed < MAX_RX_BYTES_PER_UPDATE) {
    const int value = _serial.read();
    if (value < 0) {
      break;
    }
    ++processed;

    DataPacket data{};
    AckPacket unusedAck{};
    const ParseResult result =
        _parser.push(static_cast<uint8_t>(value), data, unusedAck);
    if (result == ParseResult::DATA) {
      handleData(data, now);
    } else if (result == ParseResult::INVALID) {
      setTransientStatus(MasterLoRaStatus::ERROR,
                         now + ERROR_DISPLAY_MS);
      Serial.println("[LORA] RX invalid packet/CRC");
    }
  }
}

void MasterLoRaManager::handleData(const DataPacket &packet, uint32_t now) {
  constexpr uint8_t KNOWN_FLAGS =
      FLAG_X_VALID | FLAG_Y_VALID | FLAG_Z_VALID |
      FLAG_TEMPERATURE_VALID | FLAG_BATTERY_VALID;

  if (packet.nodeId != _expectedNodeId || packet.messageId == 0U) {
    setTransientStatus(MasterLoRaStatus::ERROR, now + ERROR_DISPLAY_MS);
    Serial.printf("[LORA] RX rejected Node=%u ID=%lu\n",
                  static_cast<unsigned>(packet.nodeId),
                  static_cast<unsigned long>(packet.messageId));
    return;
  }
  if ((packet.validFlags & static_cast<uint8_t>(~KNOWN_FLAGS)) != 0U) {
    setTransientStatus(MasterLoRaStatus::ERROR, now + ERROR_DISPLAY_MS);
    Serial.printf("[LORA] ID=%lu invalid flags\n",
                  static_cast<unsigned long>(packet.messageId));
    return;
  }

  const bool duplicate = isDuplicate(packet.nodeId, packet.messageId);
  if (duplicate) {
    Serial.printf("[LORA] ID=%lu DUPLICATE\n",
                  static_cast<unsigned long>(packet.messageId));
  } else {
    remember(packet.nodeId, packet.messageId);
    storeTelemetry(packet);
    _knownNodeCount = 1U;
    Serial.printf("[LORA] ID=%lu RX DATA\n",
                  static_cast<unsigned long>(packet.messageId));
  }

  setTransientStatus(MasterLoRaStatus::RECEIVING, now + RX_DISPLAY_MS);
  queueAck(packet, duplicate, now);
}

bool MasterLoRaManager::isDuplicate(uint16_t nodeId,
                                    uint32_t messageId) const {
  for (uint8_t index = 0; index < DEDUP_HISTORY_SIZE; ++index) {
    if (_recentMessages[index].valid &&
        _recentMessages[index].nodeId == nodeId &&
        _recentMessages[index].messageId == messageId) {
      return true;
    }
  }
  return false;
}

void MasterLoRaManager::remember(uint16_t nodeId, uint32_t messageId) {
  RecentMessage &record = _recentMessages[_recentMessageIndex];
  record.nodeId = nodeId;
  record.messageId = messageId;
  record.valid = true;
  _recentMessageIndex =
      static_cast<uint8_t>((_recentMessageIndex + 1U) % DEDUP_HISTORY_SIZE);
}

void MasterLoRaManager::storeTelemetry(const DataPacket &packet) {
  _latestTelemetry.nodeId = packet.nodeId;
  _latestTelemetry.messageId = packet.messageId;
  _latestTelemetry.validFlags = packet.validFlags;
  _latestTelemetry.xDegrees =
      (packet.validFlags & FLAG_X_VALID) != 0U
          ? static_cast<float>(packet.xCentidegrees) / 100.0F
          : NAN;
  _latestTelemetry.yDegrees =
      (packet.validFlags & FLAG_Y_VALID) != 0U
          ? static_cast<float>(packet.yCentidegrees) / 100.0F
          : NAN;
  _latestTelemetry.zDegrees =
      (packet.validFlags & FLAG_Z_VALID) != 0U
          ? static_cast<float>(packet.zCentidegrees) / 100.0F
          : NAN;
  _latestTelemetry.temperatureCelsius =
      (packet.validFlags & FLAG_TEMPERATURE_VALID) != 0U
          ? static_cast<float>(packet.temperatureCentidegreesC) / 100.0F
          : NAN;
  _latestTelemetry.batteryVoltage =
      (packet.validFlags & FLAG_BATTERY_VALID) != 0U
          ? static_cast<float>(packet.batteryMillivolts) / 1000.0F
          : NAN;
  _newTelemetry = true;
}

void MasterLoRaManager::queueAck(const DataPacket &packet, bool duplicate,
                                 uint32_t now) {
  memset(&_pendingAck, 0, sizeof(_pendingAck));
  _pendingAck.nodeId = packet.nodeId;
  _pendingAck.messageId = packet.messageId;
  _pendingAck.status = duplicate ? ACK_DUPLICATE : ACK_ACCEPTED;
  finalize(_pendingAck);

  _ackPending = true;
  _ackQueuedAt = now;
  _ackEarliestAt = now + RX_DISPLAY_MS;
}

void MasterLoRaManager::sendPendingAck(uint32_t now) {
  if (!_ackPending || _ackInProgress ||
      !timeReached(now, _ackEarliestAt)) {
    return;
  }

  if (!isAuxStableReady(now)) {
    if (now - _ackQueuedAt >= ACK_TX_TIMEOUT_MS) {
      _ackPending = false;
      setTransientStatus(MasterLoRaStatus::ERROR,
                         now + ERROR_DISPLAY_MS);
      Serial.printf("[LORA] ID=%lu ACK FAILED (AUX)\n",
                    static_cast<unsigned long>(_pendingAck.messageId));
    }
    return;
  }

  const size_t written = _serial.write(
      reinterpret_cast<const uint8_t *>(&_pendingAck), sizeof(_pendingAck));
  if (written != sizeof(_pendingAck)) {
    _ackPending = false;
    setTransientStatus(MasterLoRaStatus::ERROR, now + ERROR_DISPLAY_MS);
    Serial.printf("[LORA] ID=%lu ACK FAILED (%u/%u bytes)\n",
                  static_cast<unsigned long>(_pendingAck.messageId),
                  static_cast<unsigned>(written),
                  static_cast<unsigned>(sizeof(_pendingAck)));
    return;
  }

  Serial.printf("[LORA] ID=%lu ACK%s\n",
                static_cast<unsigned long>(_pendingAck.messageId),
                _pendingAck.status == ACK_DUPLICATE ? " DUPLICATE" : "");
  _ackPending = false;
  _ackInProgress = true;
  _ackSawAuxBusy = false;
  _ackSentAt = now;
  _auxHighSince = 0U;
  setTransientStatus(MasterLoRaStatus::ACKNOWLEDGING,
                     now + ACK_DISPLAY_MS);
}

void MasterLoRaManager::monitorAckTransmission(uint32_t now) {
  if (!_ackInProgress) {
    return;
  }

  if (digitalRead(_auxPin) == LOW) {
    _ackSawAuxBusy = true;
    _auxHighSince = 0U;
  }

  const bool ready = isAuxStableReady(now);
  if (ready && (_ackSawAuxBusy || now - _ackSentAt >= ACK_TX_MIN_MS)) {
    _ackInProgress = false;
    _statusUntil = now + ACK_DISPLAY_MS;
    return;
  }

  if (now - _ackSentAt >= ACK_TX_TIMEOUT_MS) {
    _ackInProgress = false;
    setTransientStatus(MasterLoRaStatus::ERROR, now + ERROR_DISPLAY_MS);
    Serial.printf("[LORA] ID=%lu ACK FAILED (TX timeout)\n",
                  static_cast<unsigned long>(_pendingAck.messageId));
  }
}
