#include "Tower_Sensors.h"

#include <math.h>
#include <string.h>

namespace {
constexpr uint32_t MPU_I2C_CLOCK_HZ = 400000UL;
constexpr uint16_t MPU_I2C_TIMEOUT_MS = 20U;
constexpr uint32_t MPU_RETRY_INTERVAL_MS = 5000UL;
constexpr uint32_t MPU_PACKET_TIMEOUT_MS = 1500UL;
constexpr uint16_t MPU_FIFO_CAPACITY = 1024U;
constexpr uint16_t FIFO_DISCARD_BUDGET_BYTES = 192U;

constexpr float RADIANS_TO_DEGREES = 180.0F / PI;
constexpr float DMP_ACCEL_LSB_PER_G = 8192.0F;
constexpr float DMP_GYRO_LSB_PER_DPS = 16.4F;  // DMP dung +/-2000 dps.
constexpr float QUATERNION_MIN_NORM = 0.85F;
constexpr float QUATERNION_MAX_NORM = 1.15F;
}  // namespace

TowerSensors::TowerSensors(TwoWire &mpuWire, uint8_t mpuAddress)
    : _wire(&mpuWire),
      _mpu(mpuAddress, &mpuWire),
      _mpuAddress(mpuAddress),
      _lm35Pin(0),
      _batteryMeasurePin(0),
      _batteryAdcPin(0),
      _mpuReady(false),
      _dmpPacketSize(0),
      _fifoBuffer{},
      _data(),
      _angleHistory{},
      _lastUnwrappedAngle{},
      _fastFilteredAngle{},
      _angleHistoryIndex(0),
      _angleHistoryCount(0),
      _angleFilterInitialized(false),
      _vibrationScore(0.0F),
      _structuralRollWindow{},
      _structuralPitchWindow{},
      _structuralWindowIndex(0),
      _structuralWindowCount(0),
      _structuralBinRollSum(0.0F),
      _structuralBinPitchSum(0.0F),
      _structuralBinSampleCount(0),
      _structuralCandidateActive(false),
      _candidateRollDegrees(0.0F),
      _candidatePitchDegrees(0.0F),
      _structuralCandidateSince(0),
      _alarmTransitionPending(false),
      _pendingAlarmState(false),
      _alarmConditionSince(0),
      _lm35RawSamples{},
      _lm35MilliVoltSamples{},
      _lm35SampleCount(0),
      _lm35WarmupSamplesRemaining(0),
      _temperatureFilterInitialized(false),
      _batteryState(BatteryState::IDLE),
      _activeAdcProfile(AdcProfile::LM35_0_DB),
      _batteryRawSamples{},
      _batteryMilliVoltSamples{},
      _batterySampleCount(0),
      _batteryAttemptCount(0),
      _batteryWarmupSamplesRemaining(0),
      _batteryFailedCycles(0),
      _batteryLastAdcMilliVolts(0),
      _batteryFilterInitialized(false),
      _lastMpuInitAttemptAt(0),
      _lastMpuPacketAt(0),
      _lastAngleFilterAt(0),
      _lastStructuralBinAt(0),
      _lastLm35SampleAt(0),
      _lastLm35ValidAt(0),
      _lastLm35DiagnosticAt(0),
      _lastBatteryMeasurementAt(0),
      _batteryStateStartedAt(0),
      _lastBatteryDiagnosticAt(0) {}

bool TowerSensors::begin(int8_t mpuSdaPin, int8_t mpuSclPin,
                         uint8_t lm35Pin, uint8_t batteryMeasurePin,
                         uint8_t batteryAdcPin) {
  _lm35Pin = lm35Pin;
  _batteryMeasurePin = batteryMeasurePin;
  _batteryAdcPin = batteryAdcPin;

  // Fail-safe: cau phan ap Battery phai OFF truoc moi thao tac khoi tao khac.
  pinMode(_batteryMeasurePin, OUTPUT);
  digitalWrite(_batteryMeasurePin, LOW);
  pinMode(_batteryAdcPin, INPUT);

  pinMode(_lm35Pin, INPUT);
  analogReadResolution(12);

  // GPIO4 va GPIO27 cung thuoc ADC2. Arduino-ESP32 3.x dung chung mot
  // calibration handle cho moi ADC unit, vi vay hai profile attenuation phai
  // duoc dung tuan tu. Attach ca hai channel o 0 dB truoc, sau do moi chuyen
  // toan ADC2 sang 11 dB trong cua so do Battery.
  analogSetAttenuation(ADC_0db);
  (void)analogRead(_lm35Pin);
  (void)analogRead(_batteryAdcPin);
  analogSetAttenuation(ADC_0db);
  _activeAdcProfile = AdcProfile::LM35_0_DB;
  _lm35WarmupSamplesRemaining =
      TowerSensorConfig::LM35_WARMUP_SAMPLE_COUNT;

  _wire->begin(mpuSdaPin, mpuSclPin, MPU_I2C_CLOCK_HZ);
  _wire->setTimeOut(MPU_I2C_TIMEOUT_MS);
  I2Cdev::readTimeout = MPU_I2C_TIMEOUT_MS;

  const uint32_t now = millis();
  _lastLm35SampleAt = now;
  _lastLm35ValidAt = now;
  _lastLm35DiagnosticAt = now;
  _lastBatteryDiagnosticAt = now;
  _lastBatteryMeasurementAt =
      now - TowerSensorConfig::BATTERY_MEASUREMENT_INTERVAL_MS;
  return initializeMpu(now);
}

void TowerSensors::update(uint32_t now) {
  updateMpu(now);
  updateBattery(now);
  if (_batteryState == BatteryState::IDLE) {
    updateLm35(now);
  }
}

const TowerSensorData &TowerSensors::data() const { return _data; }

bool TowerSensors::isMpuReady() const { return _mpuReady; }

bool TowerSensors::initializeMpu(uint32_t now) {
  _lastMpuInitAttemptAt = now;
  _mpuReady = false;
  _data.orientationValid = false;

  if (!probeMpuAddress()) {
    Serial.print("[MPU6050] Khong tim thay thiet bi tren I2C1 tai 0x");
    Serial.println(_mpuAddress, HEX);
    return false;
  }

  _mpu.initialize();
  if (!_mpu.testConnection()) {
    Serial.println("[MPU6050] WHO_AM_I khong hop le.");
    return false;
  }

  const uint8_t dmpStatus = _mpu.dmpInitialize();
  if (dmpStatus != 0U) {
    Serial.print("[MPU6050] Khoi tao DMP that bai, ma loi: ");
    Serial.println(dmpStatus);
    return false;
  }

  applyConfiguredOffsets();

  // Tower nghieng thay doi cham. DLPF 10 Hz loai bot rung co hoc tan so cao
  // truoc khi du lieu vao DMP, trong khi van du bang thong cho chuyen dong that.
  _mpu.setDLPFMode(MPU6050_DLPF_BW_10);
  _dmpPacketSize = _mpu.dmpGetFIFOPacketSize();
  if (_dmpPacketSize == 0U || _dmpPacketSize > DMP_PACKET_BUFFER_SIZE) {
    Serial.println("[MPU6050] Kich thuoc DMP packet khong hop le.");
    return false;
  }

  _mpu.setDMPEnabled(true);
  _mpu.resetFIFO();
  _mpu.getIntStatus();

  resetOrientationFilter();
  _mpuReady = true;
  _lastMpuPacketAt = now;
  Serial.println("[MPU6050] DMP san sang tren I2C1 GPIO18/GPIO19.");
  return true;
}

bool TowerSensors::probeMpuAddress() {
  _wire->beginTransmission(_mpuAddress);
  return _wire->endTransmission() == 0U;
}

void TowerSensors::applyConfiguredOffsets() {
  if (!TowerSensorConfig::APPLY_MPU_OFFSETS) {
    Serial.println("[MPU6050] Dang dung offset mac dinh cua cam bien.");
    return;
  }

  _mpu.setXAccelOffset(TowerSensorConfig::ACCEL_OFFSET_X);
  _mpu.setYAccelOffset(TowerSensorConfig::ACCEL_OFFSET_Y);
  _mpu.setZAccelOffset(TowerSensorConfig::ACCEL_OFFSET_Z);
  _mpu.setXGyroOffset(TowerSensorConfig::GYRO_OFFSET_X);
  _mpu.setYGyroOffset(TowerSensorConfig::GYRO_OFFSET_Y);
  _mpu.setZGyroOffset(TowerSensorConfig::GYRO_OFFSET_Z);
  Serial.println("[MPU6050] Da ap dung offset calibration cau hinh.");
}

void TowerSensors::updateMpu(uint32_t now) {
  if (!_mpuReady) {
    if (now - _lastMpuInitAttemptAt >= MPU_RETRY_INTERVAL_MS) {
      initializeMpu(now);
    }
    return;
  }

  const uint16_t fifoCount = _mpu.getFIFOCount();
  if (fifoCount >= MPU_FIFO_CAPACITY) {
    _mpu.resetFIFO();
    Serial.println("[MPU6050] FIFO overflow, da reset an toan.");
    return;
  }

  if (fifoCount < _dmpPacketSize) {
    if (now - _lastMpuPacketAt >= MPU_PACKET_TIMEOUT_MS) {
      markMpuUnavailable(now, "DMP packet timeout");
    }
    return;
  }

  const uint16_t packetCount = fifoCount / _dmpPacketSize;
  const uint16_t stalePacketCount = packetCount - 1U;
  const uint16_t maxDiscardPackets =
      FIFO_DISCARD_BUDGET_BYTES / _dmpPacketSize;
  const uint16_t discardPacketCount =
      min(stalePacketCount, maxDiscardPackets);

  // Drain packet cu theo ngan sach co dinh va luon theo boi so packet de giu
  // dung alignment FIFO. Khong reset chi vi OLED/LoRa lam loop cham tam thoi.
  for (uint16_t index = 0; index < discardPacketCount; ++index) {
    _mpu.getFIFOBytes(_fifoBuffer, static_cast<uint8_t>(_dmpPacketSize));
  }
  if (discardPacketCount < stalePacketCount) {
    return;
  }

  memset(_fifoBuffer, 0xA5, _dmpPacketSize);
  _mpu.getFIFOBytes(_fifoBuffer, static_cast<uint8_t>(_dmpPacketSize));
  processDmpPacket(now);
}

void TowerSensors::processDmpPacket(uint32_t now) {
  Quaternion quaternion;
  VectorFloat gravity;
  VectorInt16 acceleration;
  VectorInt16 linearAcceleration;
  VectorInt16 gyro;
  float yawPitchRoll[3];

  _mpu.dmpGetQuaternion(&quaternion, _fifoBuffer);
  const float quaternionNorm =
      sqrtf((quaternion.w * quaternion.w) + (quaternion.x * quaternion.x) +
            (quaternion.y * quaternion.y) + (quaternion.z * quaternion.z));
  if (!isfinite(quaternionNorm) || quaternionNorm < QUATERNION_MIN_NORM ||
      quaternionNorm > QUATERNION_MAX_NORM) {
    return;
  }

  _mpu.dmpGetGravity(&gravity, &quaternion);
  _mpu.dmpGetYawPitchRoll(yawPitchRoll, &quaternion, &gravity);
  if (!isfinite(yawPitchRoll[0]) || !isfinite(yawPitchRoll[1]) ||
      !isfinite(yawPitchRoll[2])) {
    return;
  }

  _mpu.dmpGetAccel(&acceleration, _fifoBuffer);
  _mpu.dmpGetLinearAccel(&linearAcceleration, &acceleration, &gravity);
  _mpu.dmpGetGyro(&gyro, _fifoBuffer);

  _data.accelerationXG = linearAcceleration.x / DMP_ACCEL_LSB_PER_G;
  _data.accelerationYG = linearAcceleration.y / DMP_ACCEL_LSB_PER_G;
  _data.accelerationZG = linearAcceleration.z / DMP_ACCEL_LSB_PER_G;
  updateVibration(linearAcceleration, gyro);

  const float rawDegrees[ANGLE_AXIS_COUNT] = {
      (yawPitchRoll[2] * RADIANS_TO_DEGREES) +
          TowerSensorConfig::ROLL_TRIM_DEGREES,
      (yawPitchRoll[1] * RADIANS_TO_DEGREES) +
          TowerSensorConfig::PITCH_TRIM_DEGREES,
      (yawPitchRoll[0] * RADIANS_TO_DEGREES) +
          TowerSensorConfig::YAW_TRIM_DEGREES,
  };
  updateFastAngles(rawDegrees, now);
  _lastMpuPacketAt = now;
}

void TowerSensors::updateVibration(const VectorInt16 &linearAcceleration,
                                   const VectorInt16 &gyro) {
  const float accelerationMagnitudeG =
      sqrtf(static_cast<float>(linearAcceleration.x) * linearAcceleration.x +
            static_cast<float>(linearAcceleration.y) * linearAcceleration.y +
            static_cast<float>(linearAcceleration.z) * linearAcceleration.z) /
      DMP_ACCEL_LSB_PER_G;
  const float gyroMagnitudeDps =
      sqrtf(static_cast<float>(gyro.x) * gyro.x +
            static_cast<float>(gyro.y) * gyro.y +
            static_cast<float>(gyro.z) * gyro.z) /
      DMP_GYRO_LSB_PER_DPS;

  const float accelerationScore =
      accelerationMagnitudeG /
      TowerSensorConfig::VIBRATION_ACCEL_REFERENCE_G;
  const float gyroScore =
      gyroMagnitudeDps / TowerSensorConfig::VIBRATION_GYRO_REFERENCE_DPS;
  const float instantScore =
      clampFloat(max(accelerationScore, gyroScore), 0.0F, 4.0F);
  _vibrationScore +=
      TowerSensorConfig::VIBRATION_SCORE_ALPHA *
      (instantScore - _vibrationScore);

  if (!_data.vibrating &&
      _vibrationScore >= TowerSensorConfig::VIBRATION_ENTER_SCORE) {
    _data.vibrating = true;
  } else if (_data.vibrating &&
             _vibrationScore <= TowerSensorConfig::VIBRATION_EXIT_SCORE) {
    _data.vibrating = false;
  }

  _data.vibrationG += 0.10F * (accelerationMagnitudeG - _data.vibrationG);
}

void TowerSensors::updateFastAngles(
    const float rawDegrees[ANGLE_AXIS_COUNT], uint32_t now) {
  if (!_angleFilterInitialized) {
    for (uint8_t axis = 0; axis < ANGLE_AXIS_COUNT; ++axis) {
      _lastUnwrappedAngle[axis] = rawDegrees[axis];
      _fastFilteredAngle[axis] = rawDegrees[axis];
      _angleHistory[axis][0] = rawDegrees[axis];
    }
    _angleHistoryIndex = 1U;
    _angleHistoryCount = 1U;
    _angleFilterInitialized = true;
    _lastAngleFilterAt = now;
  } else {
    for (uint8_t axis = 0; axis < ANGLE_AXIS_COUNT; ++axis) {
      const float unwrapped =
          unwrapNear(rawDegrees[axis], _lastUnwrappedAngle[axis]);
      _lastUnwrappedAngle[axis] = unwrapped;
      _angleHistory[axis][_angleHistoryIndex] = unwrapped;
    }

    _angleHistoryIndex =
        static_cast<uint8_t>((_angleHistoryIndex + 1U) % ANGLE_MEDIAN_WINDOW);
    if (_angleHistoryCount < ANGLE_MEDIAN_WINDOW) {
      ++_angleHistoryCount;
    }

    float deltaSeconds = (now - _lastAngleFilterAt) * 0.001F;
    deltaSeconds = clampFloat(deltaSeconds, 0.002F, 0.200F);
    const float alpha =
        deltaSeconds /
        (TowerSensorConfig::FAST_ANGLE_TIME_CONSTANT_S + deltaSeconds);

    for (uint8_t axis = 0; axis < ANGLE_AXIS_COUNT; ++axis) {
      const float robustSample = median(_angleHistory[axis],
                                        _angleHistoryCount);
      _fastFilteredAngle[axis] +=
          alpha * (robustSample - _fastFilteredAngle[axis]);
    }
    _lastAngleFilterAt = now;
  }

  _data.angleXDegrees = wrap180(_fastFilteredAngle[0]);
  _data.angleYDegrees = wrap180(_fastFilteredAngle[1]);
  _data.angleZDegrees = wrap180(_fastFilteredAngle[2]);
  _data.orientationValid = true;
  updateStructuralTilt(now);
}

void TowerSensors::updateStructuralTilt(uint32_t now) {
  _structuralBinRollSum += _fastFilteredAngle[0];
  _structuralBinPitchSum += _fastFilteredAngle[1];
  ++_structuralBinSampleCount;

  if (_lastStructuralBinAt == 0U) {
    _lastStructuralBinAt = now;
    return;
  }
  if (now - _lastStructuralBinAt <
      TowerSensorConfig::STRUCTURAL_BIN_INTERVAL_MS) {
    return;
  }

  const float binRoll =
      _structuralBinRollSum / _structuralBinSampleCount;
  const float binPitch =
      _structuralBinPitchSum / _structuralBinSampleCount;
  _structuralBinRollSum = 0.0F;
  _structuralBinPitchSum = 0.0F;
  _structuralBinSampleCount = 0;
  _lastStructuralBinAt = now;

  _structuralRollWindow[_structuralWindowIndex] = binRoll;
  _structuralPitchWindow[_structuralWindowIndex] = binPitch;
  _structuralWindowIndex = static_cast<uint8_t>(
      (_structuralWindowIndex + 1U) % STRUCTURAL_WINDOW_SIZE);
  if (_structuralWindowCount < STRUCTURAL_WINDOW_SIZE) {
    ++_structuralWindowCount;
  }

  if (_structuralWindowCount < STRUCTURAL_WINDOW_SIZE) {
    return;
  }

  const float robustRoll = trimmedMean(
      _structuralRollWindow, STRUCTURAL_WINDOW_SIZE,
      TowerSensorConfig::STRUCTURAL_TRIM_SAMPLES_PER_SIDE);
  const float robustPitch = trimmedMean(
      _structuralPitchWindow, STRUCTURAL_WINDOW_SIZE,
      TowerSensorConfig::STRUCTURAL_TRIM_SAMPLES_PER_SIDE);
  const float rollMad = medianAbsoluteDeviation(
      _structuralRollWindow, STRUCTURAL_WINDOW_SIZE, robustRoll);
  const float pitchMad = medianAbsoluteDeviation(
      _structuralPitchWindow, STRUCTURAL_WINDOW_SIZE, robustPitch);

  const bool stableWindow =
      !_data.vibrating &&
      max(rollMad, pitchMad) <=
          TowerSensorConfig::STRUCTURAL_MAX_MAD_DEGREES;
  if (stableWindow) {
    updateStructuralCandidate(robustRoll, robustPitch, now);
  } else {
    // Rung chi huy qua trinh xac nhan structural; Fast Angle van tiep tuc.
    _structuralCandidateActive = false;
  }

  evaluateTiltAlarm(now);
}

void TowerSensors::updateStructuralCandidate(float rollDegrees,
                                             float pitchDegrees,
                                             uint32_t now) {
  if (_data.structuralTiltValid) {
    const float change =
        angleDistance(rollDegrees, pitchDegrees,
                      _data.structuralRollDegrees,
                      _data.structuralPitchDegrees);
    if (change <=
        TowerSensorConfig::STRUCTURAL_CHANGE_DEADBAND_DEGREES) {
      _structuralCandidateActive = false;
      return;
    }
  }

  const bool candidateMoved =
      !_structuralCandidateActive ||
      angleDistance(rollDegrees, pitchDegrees, _candidateRollDegrees,
                    _candidatePitchDegrees) >
          TowerSensorConfig::STRUCTURAL_CANDIDATE_DEADBAND_DEGREES;
  if (candidateMoved) {
    _candidateRollDegrees = rollDegrees;
    _candidatePitchDegrees = pitchDegrees;
    _structuralCandidateSince = now;
    _structuralCandidateActive = true;
    return;
  }

  if (now - _structuralCandidateSince <
      TowerSensorConfig::STRUCTURAL_PERSISTENCE_MS) {
    return;
  }

  confirmStructuralTilt(rollDegrees, pitchDegrees);
  _structuralCandidateActive = false;
}

void TowerSensors::confirmStructuralTilt(float rollDegrees,
                                         float pitchDegrees) {
  _data.structuralRollDegrees = wrap180(rollDegrees);
  _data.structuralPitchDegrees = wrap180(pitchDegrees);
  _data.structuralTiltDegrees =
      combinedTilt(_data.structuralRollDegrees,
                   _data.structuralPitchDegrees);
  _data.structuralTiltValid = true;

  Serial.print("[TILT] Confirmed X=");
  Serial.print(_data.structuralRollDegrees, 2);
  Serial.print(" Y=");
  Serial.print(_data.structuralPitchDegrees, 2);
  Serial.print(" Tilt=");
  Serial.println(_data.structuralTiltDegrees, 2);
}

void TowerSensors::evaluateTiltAlarm(uint32_t now) {
  if (!_data.structuralTiltValid) {
    _alarmTransitionPending = false;
    return;
  }

  const bool targetAlarmState = !_data.tiltAlarmActive;
  const bool thresholdReached =
      targetAlarmState
          ? (_data.structuralTiltDegrees >=
             TowerSensorConfig::TILT_ALARM_ENTER_DEGREES)
          : (_data.structuralTiltDegrees <=
             TowerSensorConfig::TILT_ALARM_EXIT_DEGREES);
  if (!thresholdReached) {
    _alarmTransitionPending = false;
    return;
  }

  if (!_alarmTransitionPending ||
      _pendingAlarmState != targetAlarmState) {
    _alarmTransitionPending = true;
    _pendingAlarmState = targetAlarmState;
    _alarmConditionSince = now;
    return;
  }

  if (now - _alarmConditionSince <
      TowerSensorConfig::TILT_ALARM_PERSISTENCE_MS) {
    return;
  }

  _data.tiltAlarmActive = targetAlarmState;
  _alarmTransitionPending = false;
  Serial.println(_data.tiltAlarmActive ? "[TILT] ALARM CONFIRMED"
                                       : "[TILT] Alarm cleared");
}

void TowerSensors::resetOrientationFilter() {
  _angleHistoryIndex = 0;
  _angleHistoryCount = 0;
  _angleFilterInitialized = false;
  _vibrationScore = 0.0F;
  _lastAngleFilterAt = 0;

  _structuralWindowIndex = 0;
  _structuralWindowCount = 0;
  _structuralBinRollSum = 0.0F;
  _structuralBinPitchSum = 0.0F;
  _structuralBinSampleCount = 0;
  _structuralCandidateActive = false;
  _structuralCandidateSince = 0;
  _alarmTransitionPending = false;
  _alarmConditionSince = 0;
  _lastStructuralBinAt = 0;

  _data.angleXDegrees = NAN;
  _data.angleYDegrees = NAN;
  _data.angleZDegrees = NAN;
  _data.structuralRollDegrees = NAN;
  _data.structuralPitchDegrees = NAN;
  _data.structuralTiltDegrees = NAN;
  _data.accelerationXG = NAN;
  _data.accelerationYG = NAN;
  _data.accelerationZG = NAN;
  _data.vibrationG = 0.0F;
  _data.orientationValid = false;
  _data.vibrating = false;
  _data.structuralTiltValid = false;
  _data.tiltAlarmActive = false;
}

void TowerSensors::markMpuUnavailable(uint32_t now, const char *reason) {
  _mpu.setDMPEnabled(false);
  _mpuReady = false;
  _lastMpuInitAttemptAt = now;
  resetOrientationFilter();
  Serial.print("[MPU6050] Mat du lieu: ");
  Serial.println(reason);
}

void TowerSensors::updateLm35(uint32_t now) {
  if (now - _lastLm35SampleAt <
      TowerSensorConfig::LM35_SAMPLE_INTERVAL_MS) {
    return;
  }
  _lastLm35SampleAt = now;

  const uint16_t raw = analogRead(_lm35Pin);
  const uint32_t milliVolts = analogReadMilliVolts(_lm35Pin);

  // Sau moi lan chuyen attenuation, bo cac conversion dau de sample-and-hold
  // cua ADC2 nap lai theo nguon LM35 tro khang cao hon.
  if (_lm35WarmupSamplesRemaining > 0U) {
    --_lm35WarmupSamplesRemaining;
  } else if (raw <= 4095U &&
             milliVolts <= TowerSensorConfig::LM35_ADC_MAX_VALID_MV) {
    _lm35RawSamples[_lm35SampleCount] = raw;
    _lm35MilliVoltSamples[_lm35SampleCount] =
        static_cast<uint16_t>(milliVolts);
    ++_lm35SampleCount;
    if (_lm35SampleCount >= LM35_WINDOW_SIZE) {
      processLm35Window(now);
      _lm35SampleCount = 0;
    }
  }

  if (now - _lastLm35ValidAt >=
      TowerSensorConfig::LM35_INVALID_TIMEOUT_MS) {
    _data.temperatureValid = false;
    _data.temperatureCelsius = NAN;
    _lm35SampleCount = 0;
    _temperatureFilterInitialized = false;
  }
}

void TowerSensors::processLm35Window(uint32_t now) {
  const float averageRaw = trimmedMean(
      _lm35RawSamples, LM35_WINDOW_SIZE,
      TowerSensorConfig::LM35_TRIM_SAMPLES_PER_SIDE);
  const float averageMilliVolts = trimmedMean(
      _lm35MilliVoltSamples, LM35_WINDOW_SIZE,
      TowerSensorConfig::LM35_TRIM_SAMPLES_PER_SIDE);
  const float calibratedMilliVolts =
      (averageMilliVolts * TowerSensorConfig::LM35_CALIBRATION_GAIN) +
      TowerSensorConfig::LM35_CALIBRATION_OFFSET_MV;
  const float measuredTemperature =
      calibratedMilliVolts / TowerSensorConfig::LM35_MV_PER_DEGREE_C;

  if (!isfinite(calibratedMilliVolts) || calibratedMilliVolts < 0.0F ||
      calibratedMilliVolts >
          TowerSensorConfig::LM35_ADC_MAX_VALID_MV ||
      !isfinite(measuredTemperature)) {
    return;
  }

  if (!_temperatureFilterInitialized) {
    _data.temperatureCelsius = measuredTemperature;
    _temperatureFilterInitialized = true;
  } else {
    _data.temperatureCelsius +=
        TowerSensorConfig::LM35_FILTER_ALPHA *
        (measuredTemperature - _data.temperatureCelsius);
  }

  _data.temperatureValid = true;
  _lastLm35ValidAt = now;
  printLm35Diagnostics(now, averageRaw, averageMilliVolts,
                       calibratedMilliVolts, _data.temperatureCelsius);
}

void TowerSensors::setAdcProfile(AdcProfile profile) {
  if (_activeAdcProfile == profile) {
    return;
  }

  if (profile == AdcProfile::BATTERY_11_DB) {
    analogSetAttenuation(ADC_11db);
    _batteryWarmupSamplesRemaining =
        TowerSensorConfig::BATTERY_WARMUP_SAMPLE_COUNT;
  } else {
    analogSetAttenuation(ADC_0db);
    _lm35WarmupSamplesRemaining =
        TowerSensorConfig::LM35_WARMUP_SAMPLE_COUNT;
  }
  _activeAdcProfile = profile;
}

void TowerSensors::printLm35Diagnostics(
    uint32_t now, float averageRaw, float rawMilliVolts,
    float calibratedMilliVolts, float temperatureCelsius) {
  if (!TowerSensorConfig::ADC_DIAGNOSTICS_ENABLED ||
      now - _lastLm35DiagnosticAt <
          TowerSensorConfig::ADC_DIAGNOSTIC_INTERVAL_MS) {
    return;
  }
  _lastLm35DiagnosticAt = now;

  Serial.print("[ADC][LM35] raw=");
  Serial.print(averageRaw, 1);
  Serial.print(", adc=");
  Serial.print(rawMilliVolts, 1);
  Serial.print(" mV, calibrated=");
  Serial.print(calibratedMilliVolts, 1);
  Serial.print(" mV, temp=");
  Serial.print(temperatureCelsius, 2);
  Serial.println(" C");
}

void TowerSensors::updateBattery(uint32_t now) {
  if (_batteryState != BatteryState::IDLE &&
      now - _batteryStateStartedAt >=
          TowerSensorConfig::BATTERY_MEASUREMENT_TIMEOUT_MS) {
    abortBatteryMeasurement(now);
    return;
  }

  switch (_batteryState) {
    case BatteryState::IDLE:
      if (now - _lastBatteryMeasurementAt >=
          TowerSensorConfig::BATTERY_MEASUREMENT_INTERVAL_MS) {
        startBatteryMeasurement(now);
      }
      break;

    case BatteryState::SETTLING:
      if (now - _batteryStateStartedAt >=
          TowerSensorConfig::BATTERY_SETTLING_TIME_MS) {
        _batteryState = BatteryState::SAMPLING;
        sampleBattery(now);
      }
      break;

    case BatteryState::SAMPLING:
      sampleBattery(now);
      break;
  }
}

void TowerSensors::startBatteryMeasurement(uint32_t now) {
  // Khong tron hai phan cua so LM35 nam hai ben lan chuyen attenuation.
  _lm35SampleCount = 0;
  _batterySampleCount = 0;
  _batteryAttemptCount = 0;
  _batteryLastAdcMilliVolts = 0;
  setAdcProfile(AdcProfile::BATTERY_11_DB);
  _batteryWarmupSamplesRemaining =
      TowerSensorConfig::BATTERY_WARMUP_SAMPLE_COUNT;
  _batteryStateStartedAt = now;
  _batteryState = BatteryState::SETTLING;
  digitalWrite(_batteryMeasurePin, HIGH);
}

void TowerSensors::sampleBattery(uint32_t now) {
  uint8_t readsThisUpdate = 0;
  while (readsThisUpdate < TowerSensorConfig::BATTERY_SAMPLES_PER_UPDATE &&
         _batterySampleCount < TowerSensorConfig::BATTERY_SAMPLE_COUNT &&
         _batteryAttemptCount <
             TowerSensorConfig::BATTERY_MAX_SAMPLE_ATTEMPTS) {
    const uint16_t raw = analogRead(_batteryAdcPin);
    const uint32_t milliVolts = analogReadMilliVolts(_batteryAdcPin);
    _batteryLastAdcMilliVolts = static_cast<uint16_t>(
        min(milliVolts, static_cast<uint32_t>(UINT16_MAX)));
    ++readsThisUpdate;

    if (_batteryWarmupSamplesRemaining > 0U) {
      --_batteryWarmupSamplesRemaining;
      continue;
    }

    ++_batteryAttemptCount;
    if (raw <= 4095U &&
        milliVolts >= TowerSensorConfig::BATTERY_ADC_MIN_VALID_MV &&
        milliVolts <= TowerSensorConfig::BATTERY_ADC_MAX_VALID_MV) {
      _batteryRawSamples[_batterySampleCount] = raw;
      _batteryMilliVoltSamples[_batterySampleCount] =
          static_cast<uint16_t>(milliVolts);
      ++_batterySampleCount;
    }
  }

  if (_batterySampleCount >= TowerSensorConfig::BATTERY_SAMPLE_COUNT ||
      _batteryAttemptCount >=
          TowerSensorConfig::BATTERY_MAX_SAMPLE_ATTEMPTS) {
    finishBatteryMeasurement(now);
  }
}

void TowerSensors::finishBatteryMeasurement(uint32_t now) {
  // Tat cau phan ap truoc khi xu ly so lieu de bao dam thoi gian ON ngan nhat.
  digitalWrite(_batteryMeasurePin, LOW);
  _batteryState = BatteryState::IDLE;
  _lastBatteryMeasurementAt = now;
  setAdcProfile(AdcProfile::LM35_0_DB);

  if (_batterySampleCount <
      TowerSensorConfig::BATTERY_MIN_VALID_SAMPLES) {
    if (TowerSensorConfig::ADC_DIAGNOSTICS_ENABLED) {
      Serial.print("[ADC][BAT] invalid samples=");
      Serial.print(_batterySampleCount);
      Serial.print('/');
      Serial.print(_batteryAttemptCount);
      Serial.print(", last=");
      Serial.print(_batteryLastAdcMilliVolts);
      Serial.println(" mV");
    }
    registerBatteryFailure();
    return;
  }

  uint8_t trim = TowerSensorConfig::BATTERY_TRIM_SAMPLES_PER_SIDE;
  if (static_cast<uint16_t>(trim) * 2U >= _batterySampleCount) {
    trim = 0;
  }
  const float averageRaw =
      trimmedMean(_batteryRawSamples, _batterySampleCount, trim);
  const float averageMilliVolts = trimmedMean(
      _batteryMilliVoltSamples, _batterySampleCount, trim);
  const float dividedVoltage =
      (averageMilliVolts * 0.001F) *
      TowerSensorConfig::BATTERY_DIVIDER_RATIO;
  const float calibratedVoltage =
      (dividedVoltage * TowerSensorConfig::BATTERY_CALIBRATION_GAIN) +
      TowerSensorConfig::BATTERY_CALIBRATION_OFFSET_VOLTS;

  printBatteryDiagnostics(now, averageRaw, averageMilliVolts,
                          dividedVoltage, calibratedVoltage);

  if (!isfinite(calibratedVoltage) ||
      calibratedVoltage < TowerSensorConfig::BATTERY_MIN_VALID_VOLTS ||
      calibratedVoltage > TowerSensorConfig::BATTERY_MAX_VALID_VOLTS) {
    registerBatteryFailure();
    return;
  }

  if (!_batteryFilterInitialized) {
    _data.batteryVoltage = calibratedVoltage;
    _batteryFilterInitialized = true;
  } else {
    _data.batteryVoltage +=
        TowerSensorConfig::BATTERY_FILTER_ALPHA *
        (calibratedVoltage - _data.batteryVoltage);
  }

  _batteryFailedCycles = 0;
  _data.batteryValid = true;
}

void TowerSensors::abortBatteryMeasurement(uint32_t now) {
  digitalWrite(_batteryMeasurePin, LOW);
  _batteryState = BatteryState::IDLE;
  _lastBatteryMeasurementAt = now;
  _batterySampleCount = 0;
  _batteryAttemptCount = 0;
  setAdcProfile(AdcProfile::LM35_0_DB);
  registerBatteryFailure();
  if (TowerSensorConfig::ADC_DIAGNOSTICS_ENABLED) {
    Serial.println("[ADC][BAT] timeout; divider forced OFF");
  }
}

void TowerSensors::registerBatteryFailure() {
  if (_batteryFailedCycles < 255U) {
    ++_batteryFailedCycles;
  }
  if (!_data.batteryValid ||
      _batteryFailedCycles >=
          TowerSensorConfig::BATTERY_FAILED_CYCLES_BEFORE_INVALID) {
    _data.batteryVoltage = NAN;
    _data.batteryValid = false;
    _batteryFilterInitialized = false;
  }
}

void TowerSensors::printBatteryDiagnostics(
    uint32_t now, float averageRaw, float rawMilliVolts,
    float dividedVoltage, float calibratedVoltage) {
  if (!TowerSensorConfig::ADC_DIAGNOSTICS_ENABLED ||
      now - _lastBatteryDiagnosticAt <
          TowerSensorConfig::ADC_DIAGNOSTIC_INTERVAL_MS) {
    return;
  }
  _lastBatteryDiagnosticAt = now;

  Serial.print("[ADC][BAT] raw=");
  Serial.print(averageRaw, 1);
  Serial.print(", adc=");
  Serial.print(rawMilliVolts, 1);
  Serial.print(" mV, divider=");
  Serial.print(dividedVoltage, 3);
  Serial.print(" V, calibrated=");
  Serial.print(calibratedVoltage, 3);
  Serial.println(" V");
}

float TowerSensors::median(const float *values, uint8_t count) {
  float sorted[ANGLE_MEDIAN_WINDOW];
  for (uint8_t index = 0; index < count; ++index) {
    sorted[index] = values[index];
  }

  for (uint8_t index = 1; index < count; ++index) {
    const float value = sorted[index];
    int8_t position = static_cast<int8_t>(index) - 1;
    while (position >= 0 && sorted[position] > value) {
      sorted[position + 1] = sorted[position];
      --position;
    }
    sorted[position + 1] = value;
  }

  return sorted[count / 2U];
}

float TowerSensors::trimmedMean(const float *values, uint8_t count,
                                uint8_t trimPerSide) {
  if (count == 0U) {
    return NAN;
  }

  float sorted[STRUCTURAL_WINDOW_SIZE];
  for (uint8_t index = 0; index < count; ++index) {
    sorted[index] = values[index];
  }
  sortAscending(sorted, count);

  if (static_cast<uint16_t>(trimPerSide) * 2U >= count) {
    trimPerSide = 0;
  }
  const uint8_t last = count - trimPerSide;
  float sum = 0.0F;
  for (uint8_t index = trimPerSide; index < last; ++index) {
    sum += sorted[index];
  }
  return sum / static_cast<float>(last - trimPerSide);
}

float TowerSensors::trimmedMean(const uint16_t *values, uint8_t count,
                                uint8_t trimPerSide) {
  if (count == 0U || count > ADC_WINDOW_SIZE) {
    return NAN;
  }

  uint16_t sorted[ADC_WINDOW_SIZE];
  memcpy(sorted, values, count * sizeof(values[0]));
  sortAscending(sorted, count);

  if (static_cast<uint16_t>(trimPerSide) * 2U >= count) {
    trimPerSide = 0;
  }
  const uint8_t last = count - trimPerSide;
  uint32_t sum = 0;
  for (uint8_t index = trimPerSide; index < last; ++index) {
    sum += sorted[index];
  }
  return static_cast<float>(sum) /
         static_cast<float>(last - trimPerSide);
}

float TowerSensors::medianAbsoluteDeviation(const float *values,
                                            uint8_t count, float center) {
  if (count == 0U) {
    return NAN;
  }

  float deviations[STRUCTURAL_WINDOW_SIZE];
  for (uint8_t index = 0; index < count; ++index) {
    deviations[index] = fabsf(values[index] - center);
  }
  sortAscending(deviations, count);

  const uint8_t middle = count / 2U;
  if ((count % 2U) == 0U) {
    return (deviations[middle - 1U] + deviations[middle]) * 0.5F;
  }
  return deviations[middle];
}

void TowerSensors::sortAscending(float *values, uint8_t count) {
  for (uint8_t index = 1; index < count; ++index) {
    const float value = values[index];
    int8_t position = static_cast<int8_t>(index) - 1;
    while (position >= 0 && values[position] > value) {
      values[position + 1] = values[position];
      --position;
    }
    values[position + 1] = value;
  }
}

void TowerSensors::sortAscending(uint16_t *values, uint8_t count) {
  for (uint8_t index = 1; index < count; ++index) {
    const uint16_t value = values[index];
    int8_t position = static_cast<int8_t>(index) - 1;
    while (position >= 0 && values[position] > value) {
      values[position + 1] = values[position];
      --position;
    }
    values[position + 1] = value;
  }
}

float TowerSensors::combinedTilt(float rollDegrees, float pitchDegrees) {
  const float rollRadians = rollDegrees / RADIANS_TO_DEGREES;
  const float pitchRadians = pitchDegrees / RADIANS_TO_DEGREES;
  const float verticalProjection =
      clampFloat(cosf(rollRadians) * cosf(pitchRadians), -1.0F, 1.0F);
  return acosf(verticalProjection) * RADIANS_TO_DEGREES;
}

float TowerSensors::angleDistance(float rollA, float pitchA, float rollB,
                                  float pitchB) {
  const float rollDelta = wrap180(rollA - rollB);
  const float pitchDelta = wrap180(pitchA - pitchB);
  return sqrtf((rollDelta * rollDelta) + (pitchDelta * pitchDelta));
}

float TowerSensors::unwrapNear(float angleDegrees, float referenceDegrees) {
  while (angleDegrees - referenceDegrees > 180.0F) {
    angleDegrees -= 360.0F;
  }
  while (angleDegrees - referenceDegrees < -180.0F) {
    angleDegrees += 360.0F;
  }
  return angleDegrees;
}

float TowerSensors::wrap180(float angleDegrees) {
  while (angleDegrees > 180.0F) {
    angleDegrees -= 360.0F;
  }
  while (angleDegrees < -180.0F) {
    angleDegrees += 360.0F;
  }
  return angleDegrees;
}

float TowerSensors::clampFloat(float value, float minimum, float maximum) {
  if (value < minimum) {
    return minimum;
  }
  if (value > maximum) {
    return maximum;
  }
  return value;
}
