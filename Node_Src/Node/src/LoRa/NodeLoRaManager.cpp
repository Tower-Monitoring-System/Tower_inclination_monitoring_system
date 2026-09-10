#include "NodeLoRaManager.h"

#include <esp_system.h>
#include <math.h>
#include <string.h>

using namespace TowerLoRaProtocol;

NodeLoRaManager::NodeLoRaManager(HardwareSerial &serial, int8_t rxPin,
                                 int8_t txPin, int8_t auxPin, int8_t m0Pin,
                                 int8_t m1Pin, uint16_t nodeId)
    : _serial(serial),
      _radio(rxPin, txPin, &serial, auxPin, m0Pin, m1Pin,
             UART_BPS_RATE_9600, SERIAL_8N1),
      _auxPin(auxPin),
      _nodeId(nodeId),
      _state(State::DISCONNECTED_SLEEP),
      _status(NodeLoRaStatus::DISCONNECTED),
      _requestedMode(MODE_INIT),
      _stateStartedAt(0),
      _modeRequestedAt(0),
      _auxHighSince(0),
      _nextSampleAt(0),
      _ackStartedAt(0),
      _retryAt(0),
      _resultVisibleUntil(0),
      _resultHoldActive(false),
      _batteryRequestId(TowerSensors::INVALID_BATTERY_REQUEST_ID),
      _batteryCycleFromDisconnected(false),
      _bootSessionSeed(0),
      _messageSequence(0),
      _attemptCount(0),
      _currentPacket{},
      _parser() {}

bool NodeLoRaManager::begin(uint32_t now) {
  const uint64_t chipId = ESP.getEfuseMac();
  _bootSessionSeed = esp_random() ^ static_cast<uint32_t>(chipId) ^
                     static_cast<uint32_t>(chipId >> 32U) ^ micros();
  if (_bootSessionSeed == 0U) {
    _bootSessionSeed = 0xA53C9E17UL;
  }

  _nextSampleAt = now + SAMPLE_INTERVAL_MS;
  if (!_radio.begin()) {
    enterDisconnectedSleep(now, "INIT");
    return false;
  }

  setStatus(NodeLoRaStatus::SLEEP);
  if (!requestMode(MODE_3_SLEEP, now)) {
    enterDisconnectedSleep(now, "SLEEP MODE");
    return false;
  }

  _state = State::ENTERING_SLEEP;
  _stateStartedAt = now;
  Serial.println("[LORA] Node ready; radio entering SLEEP");
  return true;
}

void NodeLoRaManager::update(uint32_t now, TowerSensors &sensors) {
  if (_state == State::WAITING_SEND_AUX ||
      _state == State::WAITING_ACK || _state == State::RETRY_DELAY) {
    if (processIncomingAck(now)) {
      return;
    }
  }

  switch (_state) {
    case State::ENTERING_SLEEP:
      if (isModeReady(now)) {
        _state = State::SLEEPING;
        _stateStartedAt = now;
      } else if (modeTimedOut(now)) {
        enterDisconnectedSleep(now, "SLEEP AUX");
      }
      break;

    case State::SLEEPING:
      if (_resultHoldActive && timeReached(now, _resultVisibleUntil)) {
        _resultHoldActive = false;
        setStatus(NodeLoRaStatus::SLEEP);
      }

      if (timeReached(now, _nextSampleAt)) {
        startScheduledCycle(now, sensors, false);
      }
      break;

    case State::DISCONNECTED_SLEEP:
      if (timeReached(now, _nextSampleAt)) {
        startScheduledCycle(now, sensors, true);
      }
      break;

    case State::WAITING_BATTERY:
      if (!sensors.isBatteryMeasurementComplete(_batteryRequestId)) {
        break;
      }

      if (!sensors.didBatteryMeasurementSucceed(_batteryRequestId) ||
          !sensors.data().batteryValid ||
          !isfinite(sensors.data().batteryVoltage)) {
        cancelCycleBeforeWake(now, "BATTERY INVALID");
        break;
      }

      if (ACQUISITION_DIAGNOSTICS_ENABLED) {
        Serial.printf(
            "[ACQ] BAT request=%lu ready in %lu ms, %.3f V; BAT_MEAS=LOW\n",
                      static_cast<unsigned long>(_batteryRequestId),
                      static_cast<unsigned long>(now - _stateStartedAt),
                      sensors.data().batteryVoltage);
      }

      // UART va GPIO da duoc khoi tao trong setup(). Chi doi mode/AUX bang
      // state machine; khong goi begin() blocking trong loop().
      if (!requestMode(MODE_0_NORMAL, now)) {
        _batteryRequestId = TowerSensors::INVALID_BATTERY_REQUEST_ID;
        enterDisconnectedSleep(now, _batteryCycleFromDisconnected
                                        ? "RECONNECT"
                                        : "WAKE MODE");
        break;
      }
      _state = State::WAKING;
      _stateStartedAt = now;
      break;

    case State::WAKING:
      if (isModeReady(now)) {
        setStatus(NodeLoRaStatus::READY);
        _state = State::READY_TO_SNAPSHOT;
        _stateStartedAt = now;
      } else if (modeTimedOut(now)) {
        _batteryRequestId = TowerSensors::INVALID_BATTERY_REQUEST_ID;
        enterDisconnectedSleep(now, "WAKE AUX");
      }
      break;

    case State::READY_TO_SNAPSHOT: {
      const TowerSensorData &sensorData = sensors.data();
      if (!sensors.didBatteryMeasurementSucceed(_batteryRequestId) ||
          !sensorData.batteryValid || !isfinite(sensorData.batteryVoltage)) {
        Serial.println(
            "[LORA] BATTERY became invalid; telemetry cycle skipped");
        _batteryRequestId = TowerSensors::INVALID_BATTERY_REQUEST_ID;
        setStatus(NodeLoRaStatus::FAILED);
        _resultVisibleUntil = now + RESULT_DISPLAY_MS;
        _resultHoldActive = true;
        requestSleepAfterResult(now);
        break;
      }

      discardStaleInput();
      prepareSnapshot(sensorData);
      _batteryRequestId = TowerSensors::INVALID_BATTERY_REQUEST_ID;
      _batteryCycleFromDisconnected = false;
      _state = State::WAITING_SEND_AUX;
      _stateStartedAt = now;
      break;
    }

    case State::WAITING_SEND_AUX:
      if (isAuxStableReady(now)) {
        sendCurrentPacket(now);
      } else if (now - _stateStartedAt >= MODE_TIMEOUT_MS) {
        enterDisconnectedSleep(now, "SEND AUX");
      }
      break;

    case State::WAITING_ACK:
      if (now - _ackStartedAt >= ACK_TIMEOUT_MS) {
        if (_attemptCount <= MAX_RETRIES) {
          Serial.printf("[LORA] ID=%lu RETRY %u/%u\n",
                        static_cast<unsigned long>(_currentPacket.messageId),
                        static_cast<unsigned>(_attemptCount),
                        static_cast<unsigned>(MAX_RETRIES));
          setStatus(NodeLoRaStatus::RETRY);
          _retryAt = now + RETRY_DELAY_MS;
          _state = State::RETRY_DELAY;
          _stateStartedAt = now;
        } else {
          completeSession(now, false);
        }
      }
      break;

    case State::RETRY_DELAY:
      if (timeReached(now, _retryAt) && isAuxStableReady(now)) {
        sendCurrentPacket(now);
      }
      break;

    case State::WAITING_RESULT_AUX:
      if (isAuxStableReady(now) ||
          now - _stateStartedAt >= MODE_TIMEOUT_MS) {
        requestSleepAfterResult(now);
      }
      break;
  }
}

NodeLoRaStatus NodeLoRaManager::status() const { return _status; }

uint32_t NodeLoRaManager::currentMessageId() const {
  return _currentPacket.messageId;
}

bool NodeLoRaManager::timeReached(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

int16_t NodeLoRaManager::quantizeSigned(float value, float scale,
                                        float minimum, float maximum) {
  if (value < minimum) {
    value = minimum;
  } else if (value > maximum) {
    value = maximum;
  }
  return static_cast<int16_t>(lroundf(value * scale));
}

uint16_t NodeLoRaManager::quantizeUnsigned(float value, float scale,
                                           float maximum) {
  if (value < 0.0F) {
    value = 0.0F;
  } else if (value > maximum) {
    value = maximum;
  }
  return static_cast<uint16_t>(lroundf(value * scale));
}

void NodeLoRaManager::setStatus(NodeLoRaStatus status) { _status = status; }

void NodeLoRaManager::advanceSampleDeadline(uint32_t now) {
  static_assert(SAMPLE_INTERVAL_MS > 0U,
                "LoRa sample interval must be greater than zero");
  // Cong tu deadline cu thay vi now + interval de khong tich luy drift. Phep
  // tru uint32_t giu dung hanh vi khi millis() rollover.
  const uint32_t elapsedIntervals =
      (now - _nextSampleAt) / SAMPLE_INTERVAL_MS;
  _nextSampleAt += (elapsedIntervals + 1U) * SAMPLE_INTERVAL_MS;
}

void NodeLoRaManager::startScheduledCycle(uint32_t now, TowerSensors &sensors,
                                          bool fromDisconnected) {
  advanceSampleDeadline(now);
  _batteryCycleFromDisconnected = fromDisconnected;
  _batteryRequestId = sensors.requestBatteryMeasurement(now);

  if (_batteryRequestId == TowerSensors::INVALID_BATTERY_REQUEST_ID) {
    cancelCycleBeforeWake(now, "BATTERY BUSY");
    return;
  }

  if (ACQUISITION_DIAGNOSTICS_ENABLED) {
    Serial.printf(
        "[ACQ] due t=%lu, BAT request=%lu, next=%lu; BAT_MEAS=HIGH\n",
        static_cast<unsigned long>(now),
        static_cast<unsigned long>(_batteryRequestId),
        static_cast<unsigned long>(_nextSampleAt));
  }
  _state = State::WAITING_BATTERY;
  _stateStartedAt = now;
}

void NodeLoRaManager::cancelCycleBeforeWake(uint32_t now,
                                            const char *reason) {
  Serial.printf("[LORA] %s; telemetry cycle skipped\n", reason);
  _batteryRequestId = TowerSensors::INVALID_BATTERY_REQUEST_ID;
  _stateStartedAt = now;

  if (_batteryCycleFromDisconnected) {
    setStatus(NodeLoRaStatus::DISCONNECTED);
    _state = State::DISCONNECTED_SLEEP;
  } else {
    setStatus(NodeLoRaStatus::FAILED);
    _resultVisibleUntil = now + RESULT_DISPLAY_MS;
    _resultHoldActive = true;
    _state = State::SLEEPING;
  }
  _batteryCycleFromDisconnected = false;
}

bool NodeLoRaManager::requestMode(MODE_TYPE mode, uint32_t now) {
  if (_radio.setModePinsNoWait(mode) != E32_SUCCESS) {
    return false;
  }

  _requestedMode = mode;
  _modeRequestedAt = now;
  _auxHighSince = digitalRead(_auxPin) == HIGH ? now : 0U;
  return true;
}

bool NodeLoRaManager::isAuxStableReady(uint32_t now) {
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

bool NodeLoRaManager::isModeReady(uint32_t now) {
  return now - _modeRequestedAt >= MODE_MIN_SETTLE_MS &&
         isAuxStableReady(now);
}

bool NodeLoRaManager::modeTimedOut(uint32_t now) const {
  return now - _modeRequestedAt >= MODE_TIMEOUT_MS;
}

void NodeLoRaManager::enterDisconnectedSleep(uint32_t now,
                                              const char *reason) {
  Serial.printf("[LORA] DISCONNECTED (%s)\n", reason);
  setStatus(NodeLoRaStatus::DISCONNECTED);
  _radio.setModePinsNoWait(MODE_3_SLEEP);
  _batteryRequestId = TowerSensors::INVALID_BATTERY_REQUEST_ID;
  _batteryCycleFromDisconnected = false;
  _state = State::DISCONNECTED_SLEEP;
  _stateStartedAt = now;
  _auxHighSince = 0U;
}

void NodeLoRaManager::prepareSnapshot(const TowerSensorData &sensorData) {
  memset(&_currentPacket, 0, sizeof(_currentPacket));
  _currentPacket.nodeId = _nodeId;
  _currentPacket.messageId = nextMessageId();
  const char *orientationSource = "NONE";

  const bool orientationValid =
      sensorData.orientationValid && isfinite(sensorData.angleXDegrees) &&
      isfinite(sensorData.angleYDegrees) &&
      isfinite(sensorData.angleZDegrees);
  if (orientationValid) {
    // Lay cung mot bo gia tri ma OLED Node dang hien thi de khong tron hai
    // he quy chieu: X=Roll, Y=Pitch, Z=Yaw cua MPU6050 da qua fast filter.
    // Structural Tilt van duoc TowerSensors su dung rieng cho canh bao Tower.
    _currentPacket.xCentidegrees =
        quantizeSigned(sensorData.angleXDegrees, 100.0F, -180.0F, 180.0F);
    _currentPacket.yCentidegrees =
        quantizeSigned(sensorData.angleYDegrees, 100.0F, -180.0F, 180.0F);
    _currentPacket.zCentidegrees =
        quantizeSigned(sensorData.angleZDegrees, 100.0F, -180.0F, 180.0F);
    _currentPacket.validFlags |= FLAG_X_VALID | FLAG_Y_VALID | FLAG_Z_VALID |
                                 FLAG_FAST_ORIENTATION;
    orientationSource = "FAST_MPU6050";
  }

  if (sensorData.temperatureValid &&
      isfinite(sensorData.temperatureCelsius)) {
    _currentPacket.temperatureCentidegreesC =
        quantizeSigned(sensorData.temperatureCelsius, 100.0F, -100.0F,
                       200.0F);
    _currentPacket.validFlags |= FLAG_TEMPERATURE_VALID;
  }

  if (sensorData.batteryValid && isfinite(sensorData.batteryVoltage)) {
    _currentPacket.batteryMillivolts =
        quantizeUnsigned(sensorData.batteryVoltage, 1000.0F, 65.535F);
    _currentPacket.validFlags |= FLAG_BATTERY_VALID;
  }

  finalize(_currentPacket);
  Serial.printf(
      "[LORA] ID=%lu SNAP flags=0x%02X XYZ=%s X=%.2f Y=%.2f Z=%.2f "
      "TEMP=%s BAT=%s\n",
      static_cast<unsigned long>(_currentPacket.messageId),
      static_cast<unsigned>(_currentPacket.validFlags), orientationSource,
      static_cast<float>(_currentPacket.xCentidegrees) / 100.0F,
      static_cast<float>(_currentPacket.yCentidegrees) / 100.0F,
      static_cast<float>(_currentPacket.zCentidegrees) / 100.0F,
      (_currentPacket.validFlags & FLAG_TEMPERATURE_VALID) != 0U ? "OK"
                                                                 : "MISSING",
      (_currentPacket.validFlags & FLAG_BATTERY_VALID) != 0U ? "OK"
                                                             : "MISSING");
  _attemptCount = 0U;
  _parser.reset();
}

uint32_t NodeLoRaManager::nextMessageId() {
  ++_messageSequence;
  uint32_t messageId = _bootSessionSeed + _messageSequence;
  if (messageId == 0U) {
    ++_messageSequence;
    messageId = _bootSessionSeed + _messageSequence;
  }
  return messageId;
}

bool NodeLoRaManager::processIncomingAck(uint32_t now) {
  uint8_t processed = 0U;
  while (_serial.available() > 0 && processed < MAX_RX_BYTES_PER_UPDATE) {
    const int value = _serial.read();
    if (value < 0) {
      break;
    }
    ++processed;

    DataPacket unusedData{};
    AckPacket ack{};
    const ParseResult result =
        _parser.push(static_cast<uint8_t>(value), unusedData, ack);
    if (result != ParseResult::ACK) {
      continue;
    }

    if (ack.nodeId != _nodeId ||
        ack.messageId != _currentPacket.messageId ||
        (ack.status != ACK_ACCEPTED && ack.status != ACK_DUPLICATE)) {
      continue;
    }

    Serial.printf("[LORA] ID=%lu ACK%s\n",
                  static_cast<unsigned long>(ack.messageId),
                  ack.status == ACK_DUPLICATE ? " DUPLICATE" : "");
    completeSession(now, true);
    return true;
  }
  return false;
}

void NodeLoRaManager::sendCurrentPacket(uint32_t now) {
  ++_attemptCount;
  const size_t written = _serial.write(
      reinterpret_cast<const uint8_t *>(&_currentPacket),
      sizeof(_currentPacket));

  if (written != sizeof(_currentPacket)) {
    Serial.printf("[LORA] ID=%lu SEND FAILED (%u/%u bytes)\n",
                  static_cast<unsigned long>(_currentPacket.messageId),
                  static_cast<unsigned>(written),
                  static_cast<unsigned>(sizeof(_currentPacket)));
    if (_attemptCount <= MAX_RETRIES) {
      setStatus(NodeLoRaStatus::RETRY);
      _retryAt = now + RETRY_DELAY_MS;
      _state = State::RETRY_DELAY;
      _stateStartedAt = now;
    } else {
      completeSession(now, false);
    }
    return;
  }

  Serial.printf("[LORA] ID=%lu SEND attempt=%u\n",
                static_cast<unsigned long>(_currentPacket.messageId),
                static_cast<unsigned>(_attemptCount));
  setStatus(NodeLoRaStatus::SENDING);
  _ackStartedAt = now;
  _state = State::WAITING_ACK;
  _stateStartedAt = now;
  _auxHighSince = 0U;
}

void NodeLoRaManager::completeSession(uint32_t now, bool success) {
  if (success) {
    setStatus(NodeLoRaStatus::SUCCESS);
  } else {
    Serial.printf("[LORA] ID=%lu FAILED\n",
                  static_cast<unsigned long>(_currentPacket.messageId));
    setStatus(NodeLoRaStatus::FAILED);
  }

  _resultVisibleUntil = now + RESULT_DISPLAY_MS;
  _resultHoldActive = true;
  _state = State::WAITING_RESULT_AUX;
  _stateStartedAt = now;
}

void NodeLoRaManager::requestSleepAfterResult(uint32_t now) {
  if (!requestMode(MODE_3_SLEEP, now)) {
    enterDisconnectedSleep(now, "RESULT SLEEP");
    return;
  }
  _state = State::ENTERING_SLEEP;
  _stateStartedAt = now;
}

void NodeLoRaManager::discardStaleInput() {
  uint16_t discarded = 0U;
  while (_serial.available() > 0 && discarded < 256U) {
    _serial.read();
    ++discarded;
  }
  _parser.reset();
}
