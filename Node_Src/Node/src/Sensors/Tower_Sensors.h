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

// Bat de xem du lieu ADC da loc moi 3 giay. Mac dinh OFF de khong spam Serial.
constexpr bool ADC_DIAGNOSTICS_ENABLED = false;
constexpr uint32_t ADC_DIAGNOSTIC_INTERVAL_MS = 3000UL;

// LM35 / GPIO4, ADC2 voi attenuation 0 dB. Calibration la anh xa tu mV do
// boi analogReadMilliVolts() sang mV VOM. Diem 2 duoc khoi tao tu phep do
// hien tai 384.0 mV -> 335.2 mV; cap nhat ca hai diem khi co hai muc VOM.
constexpr uint32_t LM35_SAMPLE_INTERVAL_MS = 10UL;
constexpr uint32_t LM35_INVALID_TIMEOUT_MS = 2500UL;
constexpr uint8_t LM35_SAMPLE_COUNT = 15;
constexpr uint8_t LM35_TRIM_SAMPLES_PER_SIDE = 3;
constexpr uint8_t LM35_WARMUP_SAMPLE_COUNT = 2;
constexpr uint16_t LM35_ADC_MAX_VALID_MV = 950U;
constexpr float LM35_CALIBRATION_INPUT_POINT_1_MV = 0.0F;
constexpr float LM35_CALIBRATION_REFERENCE_POINT_1_MV = 0.0F;
constexpr float LM35_CALIBRATION_INPUT_POINT_2_MV = 384.0F;
constexpr float LM35_CALIBRATION_REFERENCE_POINT_2_MV = 335.2F;
constexpr float LM35_CALIBRATION_GAIN =
    (LM35_CALIBRATION_REFERENCE_POINT_2_MV -
     LM35_CALIBRATION_REFERENCE_POINT_1_MV) /
    (LM35_CALIBRATION_INPUT_POINT_2_MV -
     LM35_CALIBRATION_INPUT_POINT_1_MV);
constexpr float LM35_CALIBRATION_OFFSET_MV =
    LM35_CALIBRATION_REFERENCE_POINT_1_MV -
    (LM35_CALIBRATION_GAIN * LM35_CALIBRATION_INPUT_POINT_1_MV);
constexpr float LM35_MV_PER_DEGREE_C = 10.0F;
constexpr float LM35_FILTER_ALPHA = 0.18F;

// Battery LiFePO4 4S: dung gia tri dien tro da do tren PCB, khong dung ratio
// danh nghia 5.0. Calibration Battery duoc ap dung sau khi nhan ratio.
constexpr float BATTERY_R7_KILOOHMS = 29.60F;
constexpr float BATTERY_R8_KILOOHMS = 7.57F;
constexpr float BATTERY_DIVIDER_RATIO =
    (BATTERY_R7_KILOOHMS + BATTERY_R8_KILOOHMS) /
    BATTERY_R8_KILOOHMS;

// Diem 12.30489 V la ket qua cua mau 12.53 V cu sau khi thay ratio 5.0 bang
// ratio dien tro thuc. VOM tai cung thoi diem la 12.23 V. Thay hai cap diem
// nay bang hai muc pin khac nhau de co calibration gain + offset day du.
constexpr float BATTERY_CALIBRATION_INPUT_POINT_1_VOLTS = 0.0F;
constexpr float BATTERY_CALIBRATION_REFERENCE_POINT_1_VOLTS = 0.0F;
constexpr float BATTERY_CALIBRATION_INPUT_POINT_2_VOLTS = 12.3048904F;
constexpr float BATTERY_CALIBRATION_REFERENCE_POINT_2_VOLTS = 12.23F;
constexpr float BATTERY_CALIBRATION_GAIN =
    (BATTERY_CALIBRATION_REFERENCE_POINT_2_VOLTS -
     BATTERY_CALIBRATION_REFERENCE_POINT_1_VOLTS) /
    (BATTERY_CALIBRATION_INPUT_POINT_2_VOLTS -
     BATTERY_CALIBRATION_INPUT_POINT_1_VOLTS);
constexpr float BATTERY_CALIBRATION_OFFSET_VOLTS =
    BATTERY_CALIBRATION_REFERENCE_POINT_1_VOLTS -
    (BATTERY_CALIBRATION_GAIN *
     BATTERY_CALIBRATION_INPUT_POINT_1_VOLTS);
constexpr float BATTERY_MIN_VALID_VOLTS = 5.0F;
constexpr float BATTERY_MAX_VALID_VOLTS = 15.5F;
constexpr uint16_t BATTERY_ADC_MIN_VALID_MV = 100U;
constexpr uint16_t BATTERY_ADC_MAX_VALID_MV = 3100U;

constexpr uint32_t BATTERY_MEASUREMENT_INTERVAL_MS = 3000UL;
constexpr uint32_t BATTERY_SETTLING_TIME_MS = 50UL;
constexpr uint32_t BATTERY_MEASUREMENT_TIMEOUT_MS = 1500UL;
constexpr uint8_t BATTERY_SAMPLE_COUNT = 15;
constexpr uint8_t BATTERY_MAX_SAMPLE_ATTEMPTS = 24;
constexpr uint8_t BATTERY_SAMPLES_PER_UPDATE = 4;
constexpr uint8_t BATTERY_WARMUP_SAMPLE_COUNT = 2;
constexpr uint8_t BATTERY_TRIM_SAMPLES_PER_SIDE = 3;
constexpr uint8_t BATTERY_MIN_VALID_SAMPLES = 9;
constexpr uint8_t BATTERY_FAILED_CYCLES_BEFORE_INVALID = 3;
constexpr float BATTERY_FILTER_ALPHA = 0.25F;

static_assert(LM35_CALIBRATION_INPUT_POINT_2_MV !=
                  LM35_CALIBRATION_INPUT_POINT_1_MV,
              "LM35 calibration points must have different inputs");
static_assert(BATTERY_R8_KILOOHMS > 0.0F,
              "Battery lower divider resistor must be positive");
static_assert(BATTERY_CALIBRATION_INPUT_POINT_2_VOLTS !=
                  BATTERY_CALIBRATION_INPUT_POINT_1_VOLTS,
              "Battery calibration points must have different inputs");
static_assert(LM35_SAMPLE_COUNT >
                  (2U * LM35_TRIM_SAMPLES_PER_SIDE),
              "LM35 trim must retain at least one sample");
static_assert(BATTERY_SAMPLE_COUNT >
                  (2U * BATTERY_TRIM_SAMPLES_PER_SIDE),
              "Battery trim must retain at least one sample");
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
  float batteryVoltage;
  float vibrationG;
  bool orientationValid;
  bool temperatureValid;
  bool batteryValid;
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
        batteryVoltage(NAN),
        vibrationG(0.0F),
        orientationValid(false),
        temperatureValid(false),
        batteryValid(false),
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

  bool begin(int8_t mpuSdaPin, int8_t mpuSclPin, uint8_t lm35Pin,
             uint8_t batteryMeasurePin, uint8_t batteryAdcPin);
  void update(uint32_t now);

  const TowerSensorData &data() const;
  bool isMpuReady() const;

private:
  static constexpr uint8_t ANGLE_AXIS_COUNT = 3;
  static constexpr uint8_t ANGLE_MEDIAN_WINDOW = 5;
  static constexpr uint8_t STRUCTURAL_WINDOW_SIZE =
      TowerSensorConfig::STRUCTURAL_WINDOW_SAMPLES;
  static constexpr uint8_t LM35_WINDOW_SIZE =
      TowerSensorConfig::LM35_SAMPLE_COUNT;
  static constexpr uint8_t BATTERY_WINDOW_SIZE =
      TowerSensorConfig::BATTERY_SAMPLE_COUNT;
  static constexpr uint8_t ADC_WINDOW_SIZE =
      LM35_WINDOW_SIZE > BATTERY_WINDOW_SIZE
          ? LM35_WINDOW_SIZE
          : BATTERY_WINDOW_SIZE;
  static constexpr uint8_t DMP_PACKET_BUFFER_SIZE = 64;

  enum class BatteryState : uint8_t {
    IDLE,
    SETTLING,
    SAMPLING
  };


  TwoWire *_wire;
  MPU6050 _mpu;
  uint8_t _mpuAddress;
  uint8_t _lm35Pin;
  uint8_t _batteryMeasurePin;
  uint8_t _batteryAdcPin;
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

  uint16_t _lm35RawSamples[LM35_WINDOW_SIZE];
  uint16_t _lm35MilliVoltSamples[LM35_WINDOW_SIZE];
  uint8_t _lm35SampleCount;
  uint8_t _lm35WarmupSamplesRemaining;
  bool _temperatureFilterInitialized;

  BatteryState _batteryState;
  uint16_t _batteryRawSamples[BATTERY_WINDOW_SIZE];
  uint16_t _batteryMilliVoltSamples[BATTERY_WINDOW_SIZE];
  uint8_t _batterySampleCount;
  uint8_t _batteryAttemptCount;
  uint8_t _batteryWarmupSamplesRemaining;
  uint8_t _batteryFailedCycles;
  uint16_t _batteryLastAdcMilliVolts;
  bool _batteryFilterInitialized;

  uint32_t _lastMpuInitAttemptAt;
  uint32_t _lastMpuPacketAt;
  uint32_t _lastAngleFilterAt;
  uint32_t _lastStructuralBinAt;
  uint32_t _lastLm35SampleAt;
  uint32_t _lastLm35ValidAt;
  uint32_t _lastLm35DiagnosticAt;
  uint32_t _lastBatteryMeasurementAt;
  uint32_t _batteryStateStartedAt;
  uint32_t _lastBatteryDiagnosticAt;

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
  void printLm35Diagnostics(uint32_t now, float averageRaw,
                            float rawMilliVolts,
                            float calibratedMilliVolts,
                            float temperatureCelsius);

  void updateBattery(uint32_t now);
  void startBatteryMeasurement(uint32_t now);
  void sampleBattery(uint32_t now);
  void finishBatteryMeasurement(uint32_t now);
  void abortBatteryMeasurement(uint32_t now);
  void registerBatteryFailure();
  void printBatteryDiagnostics(uint32_t now, float averageRaw,
                               float rawMilliVolts,
                               float dividedVoltage,
                               float calibratedVoltage);

  static float median(const float *values, uint8_t count);
  static float trimmedMean(const float *values, uint8_t count,
                           uint8_t trimPerSide);
  static float trimmedMean(const uint16_t *values, uint8_t count,
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
