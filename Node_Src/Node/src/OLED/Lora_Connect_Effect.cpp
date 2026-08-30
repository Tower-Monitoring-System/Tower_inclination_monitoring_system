#include "Lora_Connect_Effect.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

namespace {
constexpr int16_t DATA_X = 43;
constexpr int16_t DIVIDER_X = 38;
constexpr int16_t ANTENNA_X = 19;
constexpr int16_t ANTENNA_Y = 21;
constexpr uint32_t OLED_I2C_CLOCK_HZ = 400000UL;
constexpr uint32_t LOW_BATTERY_BLINK_INTERVAL_MS = 500UL;

// Duong cong xa cua LiFePO4 rat phang, vi vay cac nguong nay chi dung de tao
// bieu tuong muc pin tuong doi. Dien ap so BAT:x.xxV moi la gia tri can dung.
constexpr uint16_t LIFEPO4_4S_CRITICAL_CV = 1120U;
constexpr uint16_t LIFEPO4_4S_LOW_CV = 1200U;
constexpr uint16_t LIFEPO4_4S_MID_CV = 1260U;
constexpr uint16_t LIFEPO4_4S_NORMAL_CV = 1300U;
constexpr uint16_t LIFEPO4_4S_HIGH_CV = 1330U;
constexpr uint16_t LIFEPO4_4S_FULL_CV = 1360U;
constexpr float MAX_BATTERY_DISPLAY_VOLTS = 20.0F;

template <typename T>
T clampValue(T value, T minimum, T maximum) {
  if (value < minimum) {
    return minimum;
  }
  if (value > maximum) {
    return maximum;
  }
  return value;
}

uint8_t interpolateBatteryPercent(uint16_t value, uint16_t lowVoltage,
                                  uint16_t highVoltage, uint8_t lowPercent,
                                  uint8_t highPercent) {
  if (highVoltage <= lowVoltage || highPercent <= lowPercent) {
    return lowPercent;
  }
  const uint32_t numerator =
      static_cast<uint32_t>(value - lowVoltage) *
      static_cast<uint32_t>(highPercent - lowPercent);
  const uint32_t denominator = highVoltage - lowVoltage;
  return static_cast<uint8_t>(lowPercent + (numerator / denominator));
}
}  // namespace

Lora_Connect_Effect::Lora_Connect_Effect(TwoWire &wire, int8_t resetPin)
    : _wire(&wire),
      _display(SCREEN_WIDTH, SCREEN_HEIGHT, &wire, resetPin),
      _ready(false),
      _dirty(true),
      _sleeping(false),
      _towerId{"TWR-01"},
      _anglesX100{0, 0, 0},
      _angleValid{true, true, true},
      _batteryCentiVolts(420),
      _batteryValid(true),
      _temperatureX10(320),
      _temperatureValid(true),
      _state(State::READY),
      _loraStateActive(false),
      _frame(0),
      _lastFrameAt(0) {}

bool Lora_Connect_Effect::begin(uint8_t i2cAddress) {
  _ready = _display.begin(i2cAddress, true);
  if (!_ready) {
    return false;
  }

  // SH1106 cap nhat ca framebuffer moi lan display(). Dat bus OLED len
  // Fast-mode 400 kHz de frame 128x64 khong chiem qua nhieu thoi gian loop,
  // tranh lam MPU6050 FIFO va state machine LoRa bi cham theo.
  _wire->setClock(OLED_I2C_CLOCK_HZ);

  _display.clearDisplay();
  _display.setTextColor(SH110X_WHITE);
  _display.setTextSize(1);
  _display.setTextWrap(false);
  _display.display();

  _frame = 0;
  _lastFrameAt = 0;
  _dirty = true;
  _sleeping = false;
  return true;
}

bool Lora_Connect_Effect::isReady() const { return _ready; }

void Lora_Connect_Effect::sleep() {
  if (!_ready || _sleeping) {
    return;
  }

  _display.oled_command(SH110X_DISPLAYOFF);
  _sleeping = true;
}

void Lora_Connect_Effect::wake() {
  if (!_ready) {
    return;
  }

  if (_sleeping) {
    _display.oled_command(SH110X_DISPLAYON);
    _sleeping = false;
  }

  // Lan bat OLED phai ve lai frame hien tai ngay lap tuc, khong cho animation
  // cu quyet dinh thoi diem ve lai man hinh.
  _lastFrameAt = 0;
  _dirty = true;
}
void Lora_Connect_Effect::setTowerId(const char *towerId) {
  char nextId[MAX_TOWER_ID_LENGTH + 1] = "--";
  if (towerId != nullptr && towerId[0] != '\0') {
    uint8_t index = 0;
    while (index < MAX_TOWER_ID_LENGTH && towerId[index] != '\0') {
      const char character = towerId[index];
      nextId[index] = (character >= 32 && character <= 126) ? character : '?';
      ++index;
    }
    nextId[index] = '\0';
  }

  if (strncmp(_towerId, nextId, sizeof(_towerId)) == 0) {
    return;
  }

  memcpy(_towerId, nextId, sizeof(_towerId));
  _dirty = true;
}

void Lora_Connect_Effect::setAngles(float xDegrees, float yDegrees,
                                    float zDegrees) {
  const float values[3] = {xDegrees, yDegrees, zDegrees};
  for (uint8_t index = 0; index < 3; ++index) {
    const bool valid = isFinite(values[index]);
    const int16_t quantized = valid ? quantizeAngle(values[index]) : 0;
    if (_angleValid[index] != valid || _anglesX100[index] != quantized) {
      _angleValid[index] = valid;
      _anglesX100[index] = quantized;
      _dirty = true;
    }
  }
}

void Lora_Connect_Effect::setBatteryVoltage(float voltage) {
  const bool valid = isFinite(voltage) && voltage >= 0.0F;
  const uint16_t quantized = valid ? quantizeBattery(voltage) : 0;
  if (_batteryValid == valid && _batteryCentiVolts == quantized) {
    return;
  }

  _batteryValid = valid;
  _batteryCentiVolts = quantized;
  _dirty = true;
}

void Lora_Connect_Effect::setTemperature(float celsius) {
  // LM35 trong Node duoc xu ly o mien nhiet do duong. Gia tri am duoc xem
  // la du lieu khong hop le thay vi hien thi dau am tren OLED.
  const bool valid = isFinite(celsius) && celsius >= 0.0F;
  const int16_t quantized = valid ? quantizeTemperature(celsius) : 0;
  if (_temperatureValid == valid && _temperatureX10 == quantized) {
    return;
  }

  _temperatureValid = valid;
  _temperatureX10 = quantized;
  _dirty = true;
}

void Lora_Connect_Effect::setLoraState(State state) {
  // Khong tu kich hoat trang thai LoRa khi thu vien vua khoi tao. Khi LoRa
  // that duoc tich hop, lan goi setLoraState() dau tien se bat lai day du
  // label va animation Sleep/Ready/Sending/Success/Failed/Retry/Disconnected.
  if (!_loraStateActive) {
    _loraStateActive = true;
    _state = state;
    _frame = 0;
    _lastFrameAt = 0;
    _dirty = true;
    return;
  }

  if (_state == state) {
    return;
  }

  _state = state;
  _frame = 0;
  _lastFrameAt = 0;
  _dirty = true;
}

void Lora_Connect_Effect::setTelemetry(const char *towerId, float xDegrees,
                                       float yDegrees, float zDegrees,
                                       float batteryVoltage,
                                       float temperatureCelsius) {
  setTowerId(towerId);
  setAngles(xDegrees, yDegrees, zDegrees);
  setBatteryVoltage(batteryVoltage);
  setTemperature(temperatureCelsius);
}

Lora_Connect_Effect::State Lora_Connect_Effect::loraState() const {
  return _state;
}

void Lora_Connect_Effect::forceRedraw() { _dirty = true; }

void Lora_Connect_Effect::update() {
  if (!_ready || _sleeping) {
    return;
  }

  const uint32_t now = millis();
  uint16_t refreshInterval = animationInterval(_state);
  if (_batteryValid && batteryPercent() <= 15U &&
      refreshInterval > LOW_BATTERY_BLINK_INTERVAL_MS) {
    refreshInterval = LOW_BATTERY_BLINK_INTERVAL_MS;
  }
  if (!_dirty && (now - _lastFrameAt) < refreshInterval) {
    return;
  }

  render();
  _display.display();

  _dirty = false;
  _lastFrameAt = now;
  _frame = static_cast<uint8_t>((_frame + 1U) % 12U);
}

void Lora_Connect_Effect::clear() {
  if (!_ready) {
    return;
  }

  _display.clearDisplay();
  _display.display();
  _dirty = true;
}

bool Lora_Connect_Effect::isFinite(float value) { return isfinite(value); }

int16_t Lora_Connect_Effect::quantizeAngle(float degrees) {
  const float limited = clampValue(degrees, -180.0F, 180.0F);
  return static_cast<int16_t>(lroundf(limited * 100.0F));
}

uint16_t Lora_Connect_Effect::quantizeBattery(float voltage) {
  const float limited =
      clampValue(voltage, 0.0F, MAX_BATTERY_DISPLAY_VOLTS);
  return static_cast<uint16_t>(lroundf(limited * 100.0F));
}

int16_t Lora_Connect_Effect::quantizeTemperature(float celsius) {
  const float limited = clampValue(celsius, 0.0F, 199.9F);
  return static_cast<int16_t>(lroundf(limited * 10.0F));
}

const char *Lora_Connect_Effect::stateLabel(State state) {
  switch (state) {
    case State::SLEEP:
      return "SLEEP";
    case State::SENDING:
      return "SENDING";
    case State::SUCCESS:
      return "SUCCESS";
    case State::FAILED:
      return "FAILED";
    case State::RETRY:
      return "RETRY";
    case State::DISCONNECTED:
      return "DISCONN";
    case State::READY:
    default:
      return "READY";
  }
}

uint16_t Lora_Connect_Effect::animationInterval(State state) {
  switch (state) {
    case State::SLEEP:
      return 1000;
    case State::SENDING:
      return 120;
    case State::SUCCESS:
      return 240;
    case State::FAILED:
      return 300;
    case State::RETRY:
      return 160;
    case State::DISCONNECTED:
      return 650;
    case State::READY:
    default:
      return 600;
  }
}

void Lora_Connect_Effect::render() {
  _display.clearDisplay();
  _display.setTextColor(SH110X_WHITE);
  _display.setTextSize(1);
  _display.setTextWrap(false);

  drawHeader();
  _display.drawFastVLine(DIVIDER_X, 12, 52, SH110X_WHITE);
  drawRadioTower();
  drawDataRows();
}

void Lora_Connect_Effect::drawHeader() {
  _display.fillRoundRect(0, 0, 29, 10, 2, SH110X_WHITE);
  _display.setTextColor(SH110X_BLACK);
  _display.setCursor(3, 1);
  _display.print("NODE");
  _display.setTextColor(SH110X_WHITE);

  if (_loraStateActive) {
    const char *label = stateLabel(_state);
    const int16_t labelWidth = static_cast<int16_t>(strlen(label) * 6U);
    const int16_t labelX = 31 + ((73 - labelWidth) / 2);
    const bool alertFlash =
        (_state == State::FAILED || _state == State::DISCONNECTED) &&
        ((_frame % 2U) == 0U);

    if (alertFlash) {
      _display.fillRoundRect(labelX - 2, 0, labelWidth + 4, 10, 2,
                             SH110X_WHITE);
      _display.setTextColor(SH110X_BLACK);
    }
    _display.setCursor(labelX, 1);
    _display.print(label);
    _display.setTextColor(SH110X_WHITE);

    if (_state == State::SENDING) {
      const uint8_t width = static_cast<uint8_t>(5U + ((_frame % 6U) * 6U));
      _display.drawFastHLine(labelX, 9, width, SH110X_WHITE);
    } else if (_state == State::RETRY) {
      _display.drawPixel(labelX - 4, 3 + (_frame % 4U), SH110X_WHITE);
      _display.drawPixel(labelX + labelWidth + 3, 6 - (_frame % 4U),
                         SH110X_WHITE);
    }
  }

  drawBatteryIcon(106, 1);
  _display.drawFastHLine(0, 10, SCREEN_WIDTH, SH110X_WHITE);
}

void Lora_Connect_Effect::drawBatteryIcon(int16_t x, int16_t y) {
  _display.drawRect(x, y, 18, 8, SH110X_WHITE);
  _display.fillRect(x + 18, y + 2, 3, 4, SH110X_WHITE);

  if (!_batteryValid) {
    _display.drawLine(x + 3, y + 2, x + 14, y + 5, SH110X_WHITE);
    _display.drawLine(x + 14, y + 2, x + 3, y + 5, SH110X_WHITE);
    return;
  }

  const uint8_t percent = batteryPercent();
  uint8_t fillWidth = static_cast<uint8_t>((percent * 14U) / 100U);
  if (percent > 0U && fillWidth == 0U) {
    fillWidth = 1U;
  }
  // Blink theo thoi gian thuc, khong theo _frame. _frame co the tang rat nhanh
  // khi telemetry lam OLED redraw lien tuc, neu dung _frame icon pin se nhap
  // nhay nhanh/cham tuy tai he thong.
  if (percent <= 15U &&
      ((millis() / LOW_BATTERY_BLINK_INTERVAL_MS) & 1U) != 0U) {
    fillWidth = 0U;
  }
  if (fillWidth > 0U) {
    _display.fillRect(x + 2, y + 2, fillWidth, 4, SH110X_WHITE);
  }
}

void Lora_Connect_Effect::drawRadioTower() {
  const uint8_t waveCount = activeWaveCount();
  static const uint8_t radii[] = {4, 7, 10};
  for (uint8_t index = 0; index < waveCount; ++index) {
    drawWavePair(ANTENNA_X, ANTENNA_Y, radii[index]);
  }

  _display.fillCircle(ANTENNA_X, ANTENNA_Y, 1, SH110X_WHITE);
  _display.drawFastVLine(ANTENNA_X, ANTENNA_Y + 2, 12, SH110X_WHITE);
  _display.drawLine(ANTENNA_X, 27, 7, 58, SH110X_WHITE);
  _display.drawLine(ANTENNA_X, 27, 31, 58, SH110X_WHITE);
  _display.drawFastHLine(15, 35, 9, SH110X_WHITE);
  _display.drawFastHLine(12, 43, 15, SH110X_WHITE);
  _display.drawFastHLine(9, 51, 21, SH110X_WHITE);
  _display.drawLine(15, 35, 26, 43, SH110X_WHITE);
  _display.drawLine(23, 35, 12, 43, SH110X_WHITE);
  _display.drawLine(12, 43, 29, 51, SH110X_WHITE);
  _display.drawLine(26, 43, 9, 51, SH110X_WHITE);
  _display.drawLine(9, 51, 30, 58, SH110X_WHITE);
  _display.drawLine(29, 51, 8, 58, SH110X_WHITE);
  _display.drawFastHLine(4, 59, 31, SH110X_WHITE);
  _display.drawFastHLine(7, 61, 25, SH110X_WHITE);

  drawStateMark();
}

void Lora_Connect_Effect::drawWavePair(int16_t centerX, int16_t centerY,
                                       uint8_t radius) {
  const int16_t halfRadius = static_cast<int16_t>((radius + 1U) / 2U);
  const int16_t vertical = static_cast<int16_t>(radius - 1U);

  _display.drawLine(centerX - halfRadius, centerY - vertical,
                    centerX - radius, centerY, SH110X_WHITE);
  _display.drawLine(centerX - radius, centerY, centerX - halfRadius,
                    centerY + vertical, SH110X_WHITE);
  _display.drawLine(centerX + halfRadius, centerY - vertical,
                    centerX + radius, centerY, SH110X_WHITE);
  _display.drawLine(centerX + radius, centerY, centerX + halfRadius,
                    centerY + vertical, SH110X_WHITE);
}

void Lora_Connect_Effect::drawStateMark() {
  if (!_loraStateActive) {
    return;
  }

  switch (_state) {
    case State::SLEEP:
      // Radio ngu nen khong ve song vo tuyen. Trang thai nay chi duoc luu
      // trong RAM va khong lam OLED tu bat day.
      break;

    case State::SENDING: {
      const int16_t packetX = 2 + static_cast<int16_t>((_frame % 6U) * 6U);
      _display.fillRect(packetX, 13, 2, 2, SH110X_WHITE);
      break;
    }

    case State::SUCCESS:
      _display.drawLine(26, 18, 29, 21, SH110X_WHITE);
      _display.drawLine(29, 21, 35, 14, SH110X_WHITE);
      if ((_frame % 3U) == 0U) {
        _display.drawPixel(34, 22, SH110X_WHITE);
        _display.drawPixel(31, 13, SH110X_WHITE);
      }
      break;

    case State::FAILED:
      if ((_frame % 2U) == 0U) {
        _display.drawLine(13, 15, 25, 27, SH110X_WHITE);
        _display.drawLine(25, 15, 13, 27, SH110X_WHITE);
      }
      break;

    case State::RETRY: {
      static const int8_t markerY[] = {15, 18, 21, 24};
      const uint8_t phase = _frame % 4U;
      _display.fillCircle(3, markerY[phase], 1, SH110X_WHITE);
      _display.fillCircle(35, markerY[3U - phase], 1, SH110X_WHITE);
      break;
    }

    case State::DISCONNECTED:
      _display.drawLine(12, 14, 26, 28, SH110X_WHITE);
      _display.drawLine(26, 14, 12, 28, SH110X_WHITE);
      break;

    case State::READY:
    default:
      if ((_frame % 4U) == 0U) {
        _display.drawPixel(ANTENNA_X, 14, SH110X_WHITE);
      }
      break;
  }
}

void Lora_Connect_Effect::drawDataRows() {
  char line[16];
  _display.setTextColor(SH110X_WHITE);
  _display.setTextSize(1);

  snprintf(line, sizeof(line), "ID:%s", _towerId);
  _display.setCursor(DATA_X, 12);
  _display.print(line);

  drawAngleRow('X', 21, _anglesX100[0], _angleValid[0]);
  drawAngleRow('Y', 30, _anglesX100[1], _angleValid[1]);
  drawAngleRow('Z', 39, _anglesX100[2], _angleValid[2]);

  _display.setCursor(DATA_X, 48);
  if (_batteryValid) {
    snprintf(line, sizeof(line), "BAT:%u.%02uV",
             static_cast<unsigned>(_batteryCentiVolts / 100U),
             static_cast<unsigned>(_batteryCentiVolts % 100U));
    _display.print(line);
  } else {
    _display.print("BAT:--.--V");
  }

  drawTemperatureRow(57);
}

void Lora_Connect_Effect::drawAngleRow(char axis, int16_t y,
                                       int16_t valueX100, bool valid) {
  char line[15];
  _display.setCursor(DATA_X, y);
  if (!valid) {
    snprintf(line, sizeof(line), "%c: --.--", axis);
    _display.print(line);
    return;
  }

  const bool negative = valueX100 < 0;
  const uint16_t magnitude = static_cast<uint16_t>(
      negative ? -static_cast<int32_t>(valueX100) : valueX100);
  snprintf(line, sizeof(line), "%c:%c%u.%02u", axis,
           negative ? '-' : '+', static_cast<unsigned>(magnitude / 100U),
           static_cast<unsigned>(magnitude % 100U));
  _display.print(line);

  const int16_t degreeX = _display.getCursorX() + 1;
  _display.drawCircle(degreeX, y + 1, 1, SH110X_WHITE);
}

void Lora_Connect_Effect::drawTemperatureRow(int16_t y) {
  char line[15];
  _display.setCursor(DATA_X, y);
  if (!_temperatureValid) {
    _display.print("TMP:--.-C");
    return;
  }

  const uint16_t temperature = static_cast<uint16_t>(_temperatureX10);
  snprintf(line, sizeof(line), "TMP:%u.%u",
           static_cast<unsigned>(temperature / 10U),
           static_cast<unsigned>(temperature % 10U));
  _display.print(line);

  const int16_t degreeX = _display.getCursorX() + 1;
  _display.drawCircle(degreeX, y + 1, 1, SH110X_WHITE);
  _display.setCursor(degreeX + 4, y);
  _display.print('C');
}

uint8_t Lora_Connect_Effect::activeWaveCount() const {
  if (!_loraStateActive) {
    return 0;
  }

  switch (_state) {
    case State::SLEEP:
      return 0;
    case State::SENDING: {
      static const uint8_t sequence[] = {1, 2, 3, 2, 1, 2};
      return sequence[_frame % 6U];
    }
    case State::SUCCESS:
      return 3;
    case State::FAILED:
      return static_cast<uint8_t>((_frame % 2U) == 0U ? 1U : 0U);
    case State::RETRY: {
      static const uint8_t sequence[] = {3, 2, 1, 0, 1, 2};
      return sequence[_frame % 6U];
    }
    case State::DISCONNECTED:
      return 0;
    case State::READY:
    default: {
      static const uint8_t sequence[] = {1, 1, 2, 2};
      return sequence[_frame % 4U];
    }
  }
}

uint8_t Lora_Connect_Effect::batteryPercent() const {
  if (!_batteryValid || _batteryCentiVolts <= LIFEPO4_4S_CRITICAL_CV) {
    return 0;
  }
  if (_batteryCentiVolts < LIFEPO4_4S_LOW_CV) {
    return interpolateBatteryPercent(_batteryCentiVolts,
                                     LIFEPO4_4S_CRITICAL_CV,
                                     LIFEPO4_4S_LOW_CV, 0U, 10U);
  }
  if (_batteryCentiVolts < LIFEPO4_4S_MID_CV) {
    return interpolateBatteryPercent(_batteryCentiVolts, LIFEPO4_4S_LOW_CV,
                                     LIFEPO4_4S_MID_CV, 10U, 30U);
  }
  if (_batteryCentiVolts < LIFEPO4_4S_NORMAL_CV) {
    return interpolateBatteryPercent(_batteryCentiVolts, LIFEPO4_4S_MID_CV,
                                     LIFEPO4_4S_NORMAL_CV, 30U, 55U);
  }
  if (_batteryCentiVolts < LIFEPO4_4S_HIGH_CV) {
    return interpolateBatteryPercent(_batteryCentiVolts,
                                     LIFEPO4_4S_NORMAL_CV,
                                     LIFEPO4_4S_HIGH_CV, 55U, 75U);
  }
  if (_batteryCentiVolts < LIFEPO4_4S_FULL_CV) {
    return interpolateBatteryPercent(_batteryCentiVolts, LIFEPO4_4S_HIGH_CV,
                                     LIFEPO4_4S_FULL_CV, 75U, 100U);
  }
  return 100;
}
