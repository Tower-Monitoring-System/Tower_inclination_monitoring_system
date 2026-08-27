#ifndef TOWER_SENSORS_H
#define TOWER_SENSORS_H

#include <Arduino.h>
#include <Wire.h>

#include "../MPU6050/MPU6050_6Axis_MotionApps20.h"

// Cac gia tri offset phai duoc do tren tung MPU6050 cu the. Mac dinh khong
// ghi offset de tranh xoa calibration cua nha san xuat bang gia tri doan.
namespace TowerSensorConfig {
constexpr bool APPLY_MPU_OFFSETS = false;
constexpr int16_t ACCEL_OFFSET_X = 0;
constexpr int16_t ACCEL_OFFSET_Y = 0;
constexpr int16_t ACCEL_OFFSET_Z = 0;
constexpr int16_t GYRO_OFFSET_X = 0;
constexpr int16_t GYRO_OFFSET_Y = 0;
constexpr int16_t GYRO_OFFSET_Z = 0;

// Bu co khi lap cam bien len Tower. Chi thay doi sau khi da can chuan tu the.
constexpr float ROLL_TRIM_DEGREES = 0.0F;
constexpr float PITCH_TRIM_DEGREES = 0.0F;
constexpr float YAW_TRIM_DEGREES = 0.0F;

// Pipeline Fast Angle cho OLED: median 5 mau + EMA nhe. Vibration khong thay
// doi time constant nay, do do OLED luon phan hoi nhanh va deu.
constexpr float FAST_ANGLE_TIME_CONSTANT_S = 0.20F;

// Pipeline Structural Tilt: 30 bin x 100 ms = cua so robust 3 giay.
constexpr uint32_t STRUCTURAL_BIN_INTERVAL_MS = 100UL;
constexpr uint8_t STRUCTURAL_WINDOW_SAMPLES = 30;
constexpr uint8_t STRUCTURAL_TRIM_SAMPLES_PER_SIDE = 4;
constexpr float STRUCTURAL_MAX_MAD_DEGREES = 0.20F;
constexpr float STRUCTURAL_CHANGE_DEADBAND_DEGREES = 0.15F;
constexpr float STRUCTURAL_CANDIDATE_DEADBAND_DEGREES = 0.12F;
constexpr uint32_t STRUCTURAL_PERSISTENCE_MS = 2500UL;

// Nguong canh bao nghieng tuyet doi theo gravity. Hai nguong rieng tao
// hysteresis, persistence ngan viec canh bao bat/tat quanh nguong.
constexpr float TILT_ALARM_ENTER_DEGREES = 1.00F;
constexpr float TILT_ALARM_EXIT_DEGREES = 0.70F;
constexpr uint32_t TILT_ALARM_PERSISTENCE_MS = 2000UL;

// Vibration chi gate Structural Tilt, khong lam cham Fast Angle.
constexpr float VIBRATION_ACCEL_REFERENCE_G = 0.040F;
constexpr float VIBRATION_GYRO_REFERENCE_DPS = 3.0F;
constexpr float VIBRATION_SCORE_ALPHA = 0.08F;
constexpr float VIBRATION_ENTER_SCORE = 0.90F;
constexpr float VIBRATION_EXIT_SCORE = 0.45F;
}  // namespace TowerSensorConfig

struct TowerSensorData {
  // Fast Angle cho OLED. Quy uoc: X = Roll, Y = Pitch, Z = Yaw.
  float angleXDegrees;
  float angleYDegrees;
  float angleZDegrees;

  // Gia tri da xac nhan cho LoRa/canh bao. Chi Roll/Pitch duoc dung de danh
  // gia Tower; Yaw khong tham gia vi MPU6050 khong co magnetometer.
  float structuralRollDegrees;
  float structuralPitchDegrees;
  float structuralTiltDegrees;

  // Gia toc tuyen tinh da loai gravity, don vi g. Du lieu nay duoc dung de
  // phat hien rung va san sang cho telemetry LoRa sau nay.
  float accelerationXG;
  float accelerationYG;
  float accelerationZG;

  float temperatureCelsius;
  float vibrationG;
  bool orientationValid;
  bool temperatureValid;
  bool vibrating;
  bool structuralTiltValid;
  bool tiltAlarmActive;

  TowerSensorData()
      : angleXDegrees(NAN),
        angleYDegrees(NAN),
        angleZDegrees(NAN),
        structuralRollDegrees(NAN),
        structuralPitchDegrees(NAN),
        structuralTiltDegrees(NAN),
        accelerationXG(NAN),
        accelerationYG(NAN),
        accelerationZG(NAN),
        temperatureCelsius(NAN),
        vibrationG(0.0F),
        orientationValid(false),
        temperatureValid(false),
        vibrating(false),
        structuralTiltValid(false),
        tiltAlarmActive(false) {}
};

/**
 * Quan ly MPU6050 DMP tren I2C rieng va LM35 theo kieu non-blocking.
 *
 * DMP -> median, sau do tach thanh Fast Angle phan hoi nhanh va Structural
 * Tilt robust co vibration gating, persistence va hysteresis.
 */
class TowerSensors {
public:
  explicit TowerSensors(TwoWire &mpuWire,
                        uint8_t mpuAddress = MPU6050_DEFAULT_ADDRESS);

  bool begin(int8_t mpuSdaPin, int8_t mpuSclPin, uint8_t lm35Pin);
  void update(uint32_t now);

  const TowerSensorData &data() const;
  bool isMpuReady() const;

private:
  static constexpr uint8_t ANGLE_AXIS_COUNT = 3;
  static constexpr uint8_t ANGLE_MEDIAN_WINDOW = 5;
  static constexpr uint8_t STRUCTURAL_WINDOW_SIZE =
      TowerSensorConfig::STRUCTURAL_WINDOW_SAMPLES;
  static constexpr uint8_t LM35_WINDOW_SIZE = 15;
  static constexpr uint8_t LM35_TRIM_COUNT = 3;
  static constexpr uint8_t DMP_PACKET_BUFFER_SIZE = 64;

  TwoWire *_wire;
  MPU6050 _mpu;
  uint8_t _mpuAddress;
  uint8_t _lm35Pin;
  bool _mpuReady;
  uint16_t _dmpPacketSize;
  uint8_t _fifoBuffer[DMP_PACKET_BUFFER_SIZE];

  TowerSensorData _data;

  float _angleHistory[ANGLE_AXIS_COUNT][ANGLE_MEDIAN_WINDOW];
  float _lastUnwrappedAngle[ANGLE_AXIS_COUNT];
  float _fastFilteredAngle[ANGLE_AXIS_COUNT];
  uint8_t _angleHistoryIndex;
  uint8_t _angleHistoryCount;
  bool _angleFilterInitialized;
  float _vibrationScore;

  float _structuralRollWindow[STRUCTURAL_WINDOW_SIZE];
  float _structuralPitchWindow[STRUCTURAL_WINDOW_SIZE];
  uint8_t _structuralWindowIndex;
  uint8_t _structuralWindowCount;
  float _structuralBinRollSum;
  float _structuralBinPitchSum;
  uint16_t _structuralBinSampleCount;
  bool _structuralCandidateActive;
  float _candidateRollDegrees;
  float _candidatePitchDegrees;
  uint32_t _structuralCandidateSince;
  bool _alarmTransitionPending;
  bool _pendingAlarmState;
  uint32_t _alarmConditionSince;

  uint16_t _lm35Samples[LM35_WINDOW_SIZE];
  uint8_t _lm35SampleCount;
  bool _temperatureFilterInitialized;

  uint32_t _lastMpuInitAttemptAt;
  uint32_t _lastMpuPacketAt;
  uint32_t _lastAngleFilterAt;
  uint32_t _lastStructuralBinAt;
  uint32_t _lastLm35SampleAt;
  uint32_t _lastLm35ValidAt;

  bool initializeMpu(uint32_t now);
  bool probeMpuAddress();
  void applyConfiguredOffsets();
  void updateMpu(uint32_t now);
  void processDmpPacket(uint32_t now);
  void updateVibration(const VectorInt16 &linearAcceleration,
                       const VectorInt16 &gyro);
  void updateFastAngles(const float rawDegrees[ANGLE_AXIS_COUNT],
                        uint32_t now);
  void updateStructuralTilt(uint32_t now);
  void updateStructuralCandidate(float rollDegrees, float pitchDegrees,
                                 uint32_t now);
  void confirmStructuralTilt(float rollDegrees, float pitchDegrees);
  void evaluateTiltAlarm(uint32_t now);
  void resetOrientationFilter();
  void markMpuUnavailable(uint32_t now, const char *reason);

  void updateLm35(uint32_t now);
  void processLm35Window(uint32_t now);

  static float median(const float *values, uint8_t count);
  static float trimmedMean(const float *values, uint8_t count,
                           uint8_t trimPerSide);
  static float medianAbsoluteDeviation(const float *values, uint8_t count,
                                       float center);
  static void sortAscending(float *values, uint8_t count);
  static void sortAscending(uint16_t *values, uint8_t count);
  static float combinedTilt(float rollDegrees, float pitchDegrees);
  static float angleDistance(float rollA, float pitchA, float rollB,
                             float pitchB);
  static float unwrapNear(float angleDegrees, float referenceDegrees);
  static float wrap180(float angleDegrees);
  static float clampFloat(float value, float minimum, float maximum);
};

#endif
