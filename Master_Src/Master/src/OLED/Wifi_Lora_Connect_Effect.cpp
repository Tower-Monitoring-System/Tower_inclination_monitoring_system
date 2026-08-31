#include "Wifi_Lora_Connect_Effect.h"

#include <stdio.h>
#include <time.h>

Wifi_Lora_Connect_Effect::Wifi_Lora_Connect_Effect(TwoWire &wire,
                                                   int8_t resetPin)
    : _wire(&wire),
      _display(SCREEN_WIDTH, SCREEN_HEIGHT, &wire, resetPin),
      _ready(false),
      _screen(Screen::NONE),
      _type(ConnectionType::WIFI),
      _frame(0),
      _lastFrameAt(0),
      _holdUntil(0),
      _lastDashboardLoraState(LoraDisplayState::STANDBY),
      _dashboardStateInitialized(false) {}

bool Wifi_Lora_Connect_Effect::begin(int8_t sdaPin, int8_t sclPin,
                                    uint8_t i2cAddress) {
  _wire->begin(sdaPin, sclPin);
  _ready = _display.begin(i2cAddress, true);

  if (!_ready) {
    return false;
  }

  _display.clearDisplay();
  _display.setTextColor(SH110X_WHITE);
  _display.setTextWrap(false);
  _display.display();
  _screen = Screen::NONE;
  return true;
}

bool Wifi_Lora_Connect_Effect::isReady() const { return _ready; }

void Wifi_Lora_Connect_Effect::ConnectingEffect(ConnectionType type) {
  if (!_ready) {
    return;
  }

  const bool changed = selectScreen(Screen::CONNECTING, type);
  const uint32_t now = millis();
  if (!frameDue(now, 140, changed)) {
    return;
  }

  static const uint8_t waveSequence[] = {1, 2, 3, 4, 3, 2};
  _display.clearDisplay();
  drawHeader(type);
  drawConnectionIcon(type, 64, 34, waveSequence[_frame % 6]);
  drawCenteredText(type == ConnectionType::WIFI ? "CONNECTING WIFI"
                                                : "CONNECTING LORA",
                   42);

  const char *dots[] = {" ", ".", "..", "..."};
  drawCenteredText(dots[_frame % 4], 53);
  const uint8_t progressWidth = 18 + ((_frame % 6) * 18);
  _display.drawFastHLine(10, 62, progressWidth, SH110X_WHITE);
  _display.drawPixel(117, 62, SH110X_WHITE);
  _display.display();
  _frame = (_frame + 1) % 12;
}

void Wifi_Lora_Connect_Effect::ConfigPortalEffect(ConnectionType type) {
  if (!_ready) {
    return;
  }

  const bool changed = selectScreen(Screen::CONFIG_PORTAL, type);
  const uint32_t now = millis();
  if (!frameDue(now, 180, changed)) {
    return;
  }

  static const uint8_t waveSequence[] = {1, 2, 3, 4, 3, 2};
  _display.clearDisplay();
  drawHeader(type);
  drawConnectionIcon(type, 64, 33, waveSequence[_frame % 6]);

  // Router/AP badge over the animated Wi-Fi waves.
  _display.fillRoundRect(54, 27, 21, 11, 2, SH110X_BLACK);
  _display.drawRoundRect(54, 27, 21, 11, 2, SH110X_WHITE);
  _display.setTextSize(1);
  _display.setTextColor(SH110X_WHITE);
  _display.setCursor(59, 29);
  _display.print("AP");

  drawCenteredText("WIFI SETUP", 43);
  drawCenteredText("CONFIG PORTAL", 54);

  const uint8_t pulse = _frame % 4;
  for (uint8_t index = 0; index < 4; ++index) {
    if (index <= pulse) {
      _display.drawPixel(51 + (index * 9), 62, SH110X_WHITE);
    }
  }
  _display.display();
  _frame = (_frame + 1) % 12;
}

void Wifi_Lora_Connect_Effect::ConnectedEffect(ConnectionType type,
                                               int16_t signalStrength) {
  if (!_ready) {
    return;
  }

  const bool changed = selectScreen(Screen::CONNECTED, type);
  const uint32_t now = millis();
  if (!frameDue(now, 160, changed)) {
    return;
  }

  _display.clearDisplay();
  drawHeader(type);
  drawConnectionIcon(type, 48, 33, signalLevel(signalStrength));
  drawCheckIcon(82, 27, _frame);
  drawCenteredText(type == ConnectionType::WIFI ? "WIFI CONNECTED"
                                                : "LORA CONNECTED",
                   42);

  if (signalStrength != 0) {
    char rssiText[20];
    snprintf(rssiText, sizeof(rssiText), "RSSI: %d dBm", signalStrength);
    drawCenteredText(rssiText, 53);
  } else {
    drawCenteredText("LINK READY", 53);
  }

  const uint8_t progressFrame = _frame > 6 ? 6 : _frame;
  _display.drawFastHLine(10, 62, 18 + (progressFrame * 15), SH110X_WHITE);
  _display.drawPixel(117, 62, SH110X_WHITE);
  _display.display();
  if (_frame < 7) {
    ++_frame;
  }
}

void Wifi_Lora_Connect_Effect::MasterDashboard(
    const MasterDashboardState &state) {
  if (!_ready) {
    return;
  }

  const bool changed = selectScreen(Screen::DASHBOARD, ConnectionType::WIFI);
  const bool loraStateChanged = !_dashboardStateInitialized ||
                                _lastDashboardLoraState != state.loraState;
  const bool animationActive =
      state.loraState == LoraDisplayState::CONNECTING ||
      state.loraState == LoraDisplayState::RECEIVING ||
      state.loraState == LoraDisplayState::ACKNOWLEDGING ||
      state.sheetState == SheetDisplayState::SYNCING ||
      state.sheetState == SheetDisplayState::SENDING;
  const uint16_t frameInterval = animationActive ? 180 : 420;
  if (!frameDue(millis(), frameInterval, changed || loraStateChanged)) {
    return;
  }

  _lastDashboardLoraState = state.loraState;
  _dashboardStateInitialized = true;

  _display.clearDisplay();
  drawDashboardHeader(state);
  drawGatewayIcon(_frame, state.loraState, state.loraRssi);
  _display.drawFastVLine(34, 12, 41, SH110X_WHITE);
  drawDashboardRows(state, _frame);
  _display.drawFastHLine(0, 53, SCREEN_WIDTH, SH110X_WHITE);
  drawDashboardFooter(state.timeSynchronized, _frame);
  _display.display();

  _frame = (_frame + 1) % 12;
}

void Wifi_Lora_Connect_Effect::LostConnectEffect(ConnectionType type) {
  if (!_ready) {
    return;
  }

  const uint32_t now = millis();
  if (_screen == Screen::DISCONNECTING &&
      static_cast<int32_t>(now - _holdUntil) < 0) {
    return;
  }

  const bool changed = selectScreen(Screen::LOST, type);
  if (!frameDue(now, 280, changed)) {
    return;
  }

  _display.clearDisplay();
  drawHeader(type);
  drawConnectionIcon(type, 48, 33, 1);
  _display.drawLine(35, 18, 61, 37, SH110X_WHITE);
  _display.drawLine(61, 18, 35, 37, SH110X_WHITE);
  drawAlertIcon(82, 27, _frame);
  drawCenteredText("CONNECTION LOST", 42);
  drawCenteredText((_frame % 2) == 0 ? "AUTO RETRY" : "CHECK ROUTER", 54);
  _display.display();
  _frame = (_frame + 1) % 4;
}

void Wifi_Lora_Connect_Effect::Disconnect(ConnectionType type) {
  if (!_ready) {
    return;
  }

  const uint32_t now = millis();
  const bool changed = selectScreen(Screen::DISCONNECTING, type);
  if (changed) {
    _holdUntil = now + 900;
  }
  if (!frameDue(now, 160, changed)) {
    return;
  }

  _display.clearDisplay();
  drawHeader(type);
  drawReconnectIcon(64, 27, _frame);
  drawCenteredText("RECONNECTING", 42);
  const char *dots[] = {"RESET RADIO", "RESET RADIO.", "RESET RADIO..",
                        "RESET RADIO..."};
  drawCenteredText(dots[_frame % 4], 54);
  _display.display();
  _frame = (_frame + 1) % 8;
}

void Wifi_Lora_Connect_Effect::RestartESP32(ConnectionType type) {
  if (!_ready) {
    return;
  }

  const bool changed = selectScreen(Screen::RESTARTING, type);
  if (!frameDue(millis(), 160, changed)) {
    return;
  }

  _display.clearDisplay();
  drawHeader(type);
  drawRestartIcon(64, 27, _frame);
  drawCenteredText("RESTART ESP32", 42);
  const char *dots[] = {"PLEASE WAIT", "PLEASE WAIT.", "PLEASE WAIT..",
                        "PLEASE WAIT..."};
  drawCenteredText(dots[_frame % 4], 54);
  _display.display();
  _frame = (_frame + 1) % 8;
}

void Wifi_Lora_Connect_Effect::clear() {
  if (!_ready) {
    return;
  }

  _display.clearDisplay();
  _display.display();
  _screen = Screen::NONE;
  _frame = 0;
}

bool Wifi_Lora_Connect_Effect::selectScreen(Screen screen,
                                            ConnectionType type) {
  if (_screen == screen && _type == type) {
    return false;
  }

  _screen = screen;
  _type = type;
  _frame = 0;
  _lastFrameAt = 0;
  _holdUntil = 0;
  return true;
}

bool Wifi_Lora_Connect_Effect::frameDue(uint32_t now, uint16_t interval,
                                        bool screenChanged) {
  if (!screenChanged && (now - _lastFrameAt) < interval) {
    return false;
  }

  _lastFrameAt = now;
  return true;
}

uint8_t
Wifi_Lora_Connect_Effect::signalLevel(int16_t signalStrength) const {
  if (signalStrength == 0) {
    return 0;
  }
  if (signalStrength >= -55) {
    return 4;
  }
  if (signalStrength >= -67) {
    return 3;
  }
  if (signalStrength >= -80) {
    return 2;
  }
  return 1;
}

void Wifi_Lora_Connect_Effect::drawHeader(ConnectionType type) {
  drawMasterBadge();
  _display.setTextColor(SH110X_WHITE);
  _display.setTextSize(1);
  _display.setCursor(102, 1);
  _display.print(type == ConnectionType::WIFI ? "WIFI" : "LORA");
  _display.drawPixel(96, 4, SH110X_WHITE);
  _display.drawPixel(96, 6, SH110X_WHITE);
  _display.drawFastHLine(0, 10, SCREEN_WIDTH, SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawCenteredText(const char *text, int16_t y,
                                                uint8_t size) {
  int16_t x1;
  int16_t y1;
  uint16_t width;
  uint16_t height;

  _display.setTextSize(size);
  _display.getTextBounds(text, 0, y, &x1, &y1, &width, &height);
  _display.setCursor((SCREEN_WIDTH - static_cast<int16_t>(width)) / 2, y);
  _display.print(text);
}

void Wifi_Lora_Connect_Effect::drawConnectionIcon(ConnectionType type,
                                                   int16_t centerX,
                                                   int16_t centerY,
                                                   uint8_t level) {
  if (type == ConnectionType::WIFI) {
    drawWifiIcon(centerX, centerY, level);
  } else {
    drawLoraIcon(centerX, centerY - 9, level);
  }
}

void Wifi_Lora_Connect_Effect::drawWifiIcon(int16_t centerX,
                                            int16_t baselineY,
                                            uint8_t level) {
  const uint8_t radii[] = {4, 8, 12, 16};
  if (level > 4) {
    level = 4;
  }

  for (uint8_t index = 0; index < level; ++index) {
    const uint8_t radius = radii[index];
    _display.drawCircleHelper(centerX, baselineY, radius, 0x03,
                              SH110X_WHITE);
    _display.drawPixel(centerX - radius, baselineY, SH110X_WHITE);
    _display.drawPixel(centerX + radius, baselineY, SH110X_WHITE);
    _display.drawPixel(centerX, baselineY - radius, SH110X_WHITE);
  }
  _display.fillCircle(centerX, baselineY, 2, SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawLoraIcon(int16_t centerX,
                                            int16_t centerY, uint8_t level) {
  if (level > 4) {
    level = 4;
  }

  _display.drawLine(centerX, centerY, centerX, centerY + 14, SH110X_WHITE);
  _display.drawLine(centerX, centerY + 7, centerX - 7, centerY + 15,
                    SH110X_WHITE);
  _display.drawLine(centerX, centerY + 7, centerX + 7, centerY + 15,
                    SH110X_WHITE);
  _display.fillCircle(centerX, centerY, 2, SH110X_WHITE);

  for (uint8_t index = 1; index < level; ++index) {
    const uint8_t radius = index * 4;
    _display.drawCircleHelper(centerX, centerY, radius, 0x0F,
                              SH110X_WHITE);
  }
}

void Wifi_Lora_Connect_Effect::drawMiniWifiIcon(int16_t centerX,
                                                int16_t baselineY,
                                                uint8_t level) {
  if (level > 3) {
    level = 3;
  }

  static const uint8_t radii[] = {2, 4, 6};
  for (uint8_t index = 0; index < level; ++index) {
    _display.drawCircleHelper(centerX, baselineY, radii[index], 0x03,
                              SH110X_WHITE);
  }

  if (level > 0) {
    _display.drawPixel(centerX, baselineY, SH110X_WHITE);
  } else {
    _display.drawRect(centerX - 1, baselineY - 1, 3, 2, SH110X_WHITE);
  }
}

void Wifi_Lora_Connect_Effect::drawMasterBadge() {
  _display.fillRoundRect(0, 0, 43, 10, 2, SH110X_WHITE);
  _display.setTextSize(1);
  _display.setTextColor(SH110X_BLACK);
  _display.setCursor(3, 1);
  _display.print("MASTER");
  _display.setTextColor(SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawReconnectIcon(int16_t centerX,
                                                  int16_t centerY,
                                                  uint8_t frame) {
  _display.drawCircle(centerX, centerY, 11, SH110X_WHITE);
  _display.fillTriangle(centerX + 8, centerY - 10, centerX + 15,
                        centerY - 10, centerX + 12, centerY - 4,
                        SH110X_WHITE);
  _display.fillTriangle(centerX - 8, centerY + 10, centerX - 15,
                        centerY + 10, centerX - 12, centerY + 4,
                        SH110X_WHITE);

  static const int8_t markerX[] = {0, 13, 0, -13};
  static const int8_t markerY[] = {-13, 0, 13, 0};
  const uint8_t marker = frame % 4;
  _display.fillCircle(centerX + markerX[marker], centerY + markerY[marker], 1,
                      SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawRestartIcon(int16_t centerX,
                                                int16_t centerY,
                                                uint8_t frame) {
  _display.drawCircleHelper(centerX, centerY, 12, 0x0F, SH110X_WHITE);
  _display.fillRect(centerX - 2, centerY - 14, 5, 13, SH110X_BLACK);
  _display.drawFastVLine(centerX, centerY - 15, 13, SH110X_WHITE);
  _display.fillTriangle(centerX + 8, centerY - 11, centerX + 15,
                        centerY - 10, centerX + 12, centerY - 4,
                        SH110X_WHITE);

  const int16_t pulseRadius = 15 + (frame % 3);
  _display.drawCircleHelper(centerX, centerY, pulseRadius, 0x03,
                            SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawCheckIcon(int16_t centerX,
                                              int16_t centerY,
                                              uint8_t frame) {
  _display.drawCircle(centerX, centerY, 10, SH110X_WHITE);
  if (frame >= 1) {
    _display.drawLine(centerX - 5, centerY, centerX - 1, centerY + 4,
                      SH110X_WHITE);
  }
  if (frame >= 2) {
    _display.drawLine(centerX - 1, centerY + 4, centerX + 6, centerY - 5,
                      SH110X_WHITE);
    _display.drawLine(centerX, centerY + 4, centerX + 7, centerY - 5,
                      SH110X_WHITE);
  }
  if (frame >= 4 && (frame % 2) == 0) {
    _display.drawPixel(centerX - 13, centerY, SH110X_WHITE);
    _display.drawPixel(centerX + 13, centerY, SH110X_WHITE);
  }
}

void Wifi_Lora_Connect_Effect::drawAlertIcon(int16_t centerX,
                                              int16_t centerY,
                                              uint8_t frame) {
  _display.drawTriangle(centerX, centerY - 11, centerX - 11, centerY + 9,
                        centerX + 11, centerY + 9, SH110X_WHITE);
  _display.drawFastVLine(centerX, centerY - 5, 8, SH110X_WHITE);
  if ((frame % 2) == 0) {
    _display.fillCircle(centerX, centerY + 6, 1, SH110X_WHITE);
  } else {
    _display.drawPixel(centerX, centerY + 6, SH110X_WHITE);
  }
}

void Wifi_Lora_Connect_Effect::drawDashboardHeader(
    const MasterDashboardState &state) {
  drawMasterBadge();
  _display.setTextSize(1);
  _display.setTextColor(SH110X_WHITE);

  char rssiText[8];
  if (state.wifiRssi == 0) {
    snprintf(rssiText, sizeof(rssiText), "W---");
  } else {
    snprintf(rssiText, sizeof(rssiText), "W%d", state.wifiRssi);
  }
  _display.setCursor(48, 1);
  _display.print(rssiText);

  const uint8_t wifiLevel = signalLevel(state.wifiRssi);
  uint8_t animatedWifiLevel = wifiLevel > 3 ? 3 : wifiLevel;
  if (animatedWifiLevel > 1 && (_frame % 4) == 0) {
    --animatedWifiLevel;
  }
  drawMiniWifiIcon(96, 8, animatedWifiLevel);
  drawSignalBars(126, 9, wifiLevel);
  _display.drawFastHLine(0, 10, SCREEN_WIDTH, SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawGatewayIcon(
    uint8_t frame, LoraDisplayState loraState, int16_t loraRssi) {
  const int16_t centerX = 17;
  const int16_t antennaY = 25;

  uint8_t waveLevel = 1;
  if (loraState == LoraDisplayState::CONNECTING) {
    waveLevel = 1 + (frame % 3);
  } else if (loraState == LoraDisplayState::CONNECTED) {
    const uint8_t level = signalLevel(loraRssi);
    waveLevel = level > 3 ? 3 : level;
  } else if (loraState == LoraDisplayState::STANDBY) {
    static const uint8_t standbyPulse[] = {1, 1, 2, 2, 1, 1};
    waveLevel = standbyPulse[frame % 6];
  } else if (loraState == LoraDisplayState::RECEIVING) {
    waveLevel = 3;
  } else if (loraState == LoraDisplayState::ACKNOWLEDGING) {
    static const uint8_t ackPulse[] = {3, 2, 1, 2};
    waveLevel = ackPulse[frame % 4];
  } else {
    waveLevel = 0;
  }

  const uint8_t radii[] = {5, 9, 13};
  for (uint8_t index = 0; index < waveLevel && index < 3; ++index) {
    _display.drawCircleHelper(centerX, antennaY, radii[index], 0x03,
                              SH110X_WHITE);
  }

  _display.fillCircle(centerX, antennaY, 1, SH110X_WHITE);
  _display.drawLine(centerX, antennaY + 2, 9, 49, SH110X_WHITE);
  _display.drawLine(centerX, antennaY + 2, 25, 49, SH110X_WHITE);
  _display.drawFastVLine(centerX, antennaY + 2, 21, SH110X_WHITE);
  _display.drawLine(13, 37, 21, 37, SH110X_WHITE);
  _display.drawLine(11, 43, 23, 43, SH110X_WHITE);
  _display.drawLine(13, 36, 22, 43, SH110X_WHITE);
  _display.drawLine(21, 36, 12, 43, SH110X_WHITE);
  _display.drawLine(11, 43, 20, 48, SH110X_WHITE);
  _display.drawLine(23, 43, 14, 48, SH110X_WHITE);
  _display.drawFastHLine(7, 50, 21, SH110X_WHITE);
  _display.drawFastHLine(10, 52, 15, SH110X_WHITE);

  const uint8_t groundPhase = frame % 3;
  _display.drawPixel(3 + groundPhase, 51, SH110X_WHITE);
  _display.drawPixel(31 - groundPhase, 51, SH110X_WHITE);

  if ((loraState == LoraDisplayState::LOST ||
       loraState == LoraDisplayState::ERROR) &&
      (frame % 2) == 0) {
    _display.drawLine(11, 19, 23, 31, SH110X_WHITE);
    _display.drawLine(23, 19, 11, 31, SH110X_WHITE);
  }
}

void Wifi_Lora_Connect_Effect::drawSignalBars(int16_t rightX,
                                              int16_t baselineY,
                                              uint8_t level) {
  if (level > 4) {
    level = 4;
  }

  const int16_t firstX = rightX - 15;
  for (uint8_t index = 0; index < 4; ++index) {
    const int16_t height = static_cast<int16_t>((index + 1) * 2);
    const int16_t x = firstX + static_cast<int16_t>(index * 4);
    const int16_t y = baselineY - height + 1;
    if (index < level) {
      _display.fillRect(x, y, 3, height, SH110X_WHITE);
    } else {
      _display.drawRect(x, y, 3, height, SH110X_WHITE);
    }
  }
}

void Wifi_Lora_Connect_Effect::drawDashboardRows(
    const MasterDashboardState &state, uint8_t frame) {
  char line[20];
  _display.setTextSize(1);
  _display.setTextColor(SH110X_WHITE);

  snprintf(line, sizeof(line), "MODE:GATEWAY");
  _display.setCursor(39, 13);
  _display.print(line);

  switch (state.loraState) {
    case LoraDisplayState::CONNECTING: {
      const char spinner[] = {'|', '/', '-', '\\'};
      snprintf(line, sizeof(line), "LORA:SEARCH %c", spinner[frame % 4]);
      break;
    }
    case LoraDisplayState::CONNECTED:
      if (state.loraRssi != 0) {
        snprintf(line, sizeof(line), "LORA:%ddBm", state.loraRssi);
      } else {
        snprintf(line, sizeof(line), "LORA:LINK");
      }
      break;
    case LoraDisplayState::RECEIVING:
      snprintf(line, sizeof(line), "LORA:RECEIVING");
      break;
    case LoraDisplayState::ACKNOWLEDGING:
      snprintf(line, sizeof(line), "LORA:SEND ACK");
      break;
    case LoraDisplayState::ERROR:
      snprintf(line, sizeof(line), "LORA:ERROR");
      break;
    case LoraDisplayState::LOST:
      snprintf(line, sizeof(line), "LORA:LOST");
      break;
    case LoraDisplayState::STANDBY:
    default:
      snprintf(line, sizeof(line), "LORA:STANDBY");
      break;
  }
  _display.setCursor(39, 23);
  _display.print(line);

  if (state.nodeCount > 99 || state.pendingUploads > 99) {
    if (state.loraState == LoraDisplayState::STANDBY) {
      snprintf(line, sizeof(line), "N:-- Q:%u",
               static_cast<unsigned>(state.pendingUploads));
    } else {
      snprintf(line, sizeof(line), "N:%u Q:%u",
               static_cast<unsigned>(state.nodeCount),
               static_cast<unsigned>(state.pendingUploads));
    }
  } else if (state.loraState == LoraDisplayState::STANDBY) {
    snprintf(line, sizeof(line), "NODES:-- Q:%02u",
             static_cast<unsigned>(state.pendingUploads));
  } else {
    snprintf(line, sizeof(line), "NODES:%02u Q:%02u",
             static_cast<unsigned>(state.nodeCount),
             static_cast<unsigned>(state.pendingUploads));
  }
  _display.setCursor(39, 33);
  _display.print(line);

  const char spinner[] = {'|', '/', '-', '\\'};
  switch (state.sheetState) {
    case SheetDisplayState::SYNCING:
      snprintf(line, sizeof(line), "SHEET:SYNC %c", spinner[frame % 4]);
      break;
    case SheetDisplayState::SENDING:
      snprintf(line, sizeof(line), "SHEET:SEND %c", spinner[frame % 4]);
      break;
    case SheetDisplayState::SUCCESS:
      snprintf(line, sizeof(line), "SHEET:SUCCESS");
      break;
    case SheetDisplayState::ERROR:
      snprintf(line, sizeof(line), "SHEET:FAILED");
      break;
    case SheetDisplayState::READY:
    default:
      snprintf(line, sizeof(line), "SHEET:READY");
      break;
  }
  _display.setCursor(39, 43);
  _display.print(line);
}

void Wifi_Lora_Connect_Effect::drawDashboardFooter(bool timeSynchronized,
                                                   uint8_t frame) {
  char text[24];
  if (timeSynchronized) {
    const time_t now = time(nullptr);
    struct tm localTime = {};
    if (localtime_r(&now, &localTime)) {
      strftime(text, sizeof(text), "%d/%m/%Y %H:%M", &localTime);
    } else {
      snprintf(text, sizeof(text), "TIME ERROR");
    }
  } else {
    const char spinner[] = {'|', '/', '-', '\\'};
    snprintf(text, sizeof(text), "TIME SYNC %c", spinner[frame % 4]);
  }
  drawCenteredText(text, 56);

  const uint8_t phase = frame % 3;
  for (uint8_t index = 0; index < 3; ++index) {
    if (index <= phase) {
      _display.drawPixel(2 + (index * 3), 60, SH110X_WHITE);
      _display.drawPixel(125 - (index * 3), 60, SH110X_WHITE);
    }
  }
}
