#ifndef LORA_CONNECT_EFFECT_H
#define LORA_CONNECT_EFFECT_H

#include <Arduino.h>
#include <Wire.h>

#include "Adafruit_SH110X.h"

// Trang thai nay chi dieu khien giao dien. Phan LoRa that van duoc xu ly
// boi sketch chinh va chi can day trang thai moi sang thu vien.
enum class LoraNodeState : uint8_t {
  READY,
  SENDING,
  SUCCESS,
  FAILED,
  RETRY,
  DISCONNECTED
};

/**
 * Dashboard non-blocking cho OLED SH1106G 1.3 inch (128x64).
 *
 * Tat ca du lieu duoc luu bang bo dem co dinh. update() chi truyen mot frame
 * moi den OLED khi du lieu hien thi thay doi hoac animation den han.
 */
class Lora_Connect_Effect {
public:
  using State = LoraNodeState;

  explicit Lora_Connect_Effect(TwoWire &wire = Wire, int8_t resetPin = -1);

  // Khoi tao bang I2C hardware mac dinh cua ESP32 (Wire):
  // SDA = GPIO21, SCL = GPIO22. Khong remap chan SDA/SCL.
  bool begin(uint8_t i2cAddress = 0x3C);
  bool isReady() const;

  void setTowerId(const char *towerId);
  void setAngles(float xDegrees, float yDegrees, float zDegrees);
  void setBatteryVoltage(float voltage);
  void setTemperature(float celsius);
  void setLoraState(State state);

  // Ham tien ich de cap nhat mot snapshot cam bien trong mot lan goi.
  void setTelemetry(const char *towerId, float xDegrees, float yDegrees,
                    float zDegrees, float batteryVoltage,
                    float temperatureCelsius);

  State loraState() const;
  void forceRedraw();
  void update();
  void clear();

private:
  static const uint8_t SCREEN_WIDTH = 128;
  static const uint8_t SCREEN_HEIGHT = 64;
  static const uint8_t MAX_TOWER_ID_LENGTH = 10;

  TwoWire *_wire;
  Adafruit_SH1106G _display;
  bool _ready;
  bool _dirty;

  char _towerId[MAX_TOWER_ID_LENGTH + 1];
  int16_t _anglesX100[3];
  bool _angleValid[3];
  uint16_t _batteryCentiVolts;
  bool _batteryValid;
  int16_t _temperatureX10;
  bool _temperatureValid;
  State _state;
  bool _loraStateActive;

  uint8_t _frame;
  uint32_t _lastFrameAt;

  static bool isFinite(float value);
  static int16_t quantizeAngle(float degrees);
  static uint16_t quantizeBattery(float voltage);
  static int16_t quantizeTemperature(float celsius);
  static const char *stateLabel(State state);
  static uint16_t animationInterval(State state);

  void render();
  void drawHeader();
  void drawBatteryIcon(int16_t x, int16_t y);
  void drawRadioTower();
  void drawWavePair(int16_t centerX, int16_t centerY, uint8_t radius);
  void drawStateMark();
  void drawDataRows();
  void drawAngleRow(char axis, int16_t y, int16_t valueX100, bool valid);
  void drawTemperatureRow(int16_t y);
  uint8_t activeWaveCount() const;
  uint8_t batteryPercent() const;
};

#endif
