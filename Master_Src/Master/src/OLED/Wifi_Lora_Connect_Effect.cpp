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
      _holdUntil(0) {}

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
  if (!frameDue(now, 170, changed)) {
    return;
  }

  _display.clearDisplay();
  drawHeader(type);
  drawConnectionIcon(type, 64, 33, (_frame % 4) + 1);
  drawCenteredText("CONNECTING", 41);

  const char *dots[] = {" ", ".", "..", "..."};
  drawCenteredText(dots[_frame % 4], 53);
  _display.display();
  _frame = (_frame + 1) % 4;
}

void Wifi_Lora_Connect_Effect::ConnectedEffect(ConnectionType type,
                                               int16_t signalStrength) {
  if (!_ready) {
    return;
  }

  const bool changed = selectScreen(Screen::CONNECTED, type);
  const uint32_t now = millis();
  if (!frameDue(now, 750, changed)) {
    return;
  }

  _display.clearDisplay();
  drawHeader(type);
  drawConnectionIcon(type, 64, 33, signalLevel(signalStrength));
  drawCenteredText("CONNECTED", 41);

  if (signalStrength != 0) {
    char rssiText[20];
    snprintf(rssiText, sizeof(rssiText), "RSSI: %d dBm", signalStrength);
    drawCenteredText(rssiText, 53);
  } else {
    drawCenteredText("LINK READY", 53);
  }

  _display.display();
}

void Wifi_Lora_Connect_Effect::MasterDashboard(
    const MasterDashboardState &state) {
  if (!_ready) {
    return;
  }

  const bool changed = selectScreen(Screen::DASHBOARD, ConnectionType::WIFI);
  const bool animationActive =
      state.loraState == LoraDisplayState::CONNECTING ||
      state.sheetState == SheetDisplayState::SYNCING ||
      state.sheetState == SheetDisplayState::SENDING;
  const uint16_t frameInterval = animationActive ? 250 : 1000;
  if (!frameDue(millis(), frameInterval, changed)) {
    return;
  }

  _display.clearDisplay();
  drawDashboardHeader(state);
  drawGatewayIcon(_frame, state.loraState, state.loraRssi);
  _display.drawFastVLine(34, 12, 41, SH110X_WHITE);
  drawDashboardRows(state, _frame);
  _display.drawFastHLine(0, 53, SCREEN_WIDTH, SH110X_WHITE);
  drawDashboardFooter(state.timeSynchronized, _frame);
  _display.display();

  _frame = (_frame + 1) % 4;
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
  if (!frameDue(now, 350, changed)) {
    return;
  }

  _display.clearDisplay();
  drawHeader(type);

  if ((_frame % 2) == 0) {
    drawConnectionIcon(type, 64, 33, 1);
    _display.drawLine(51, 17, 77, 36, SH110X_WHITE);
    _display.drawLine(77, 17, 51, 36, SH110X_WHITE);
  }

  drawCenteredText("CONNECTION LOST", 42);
  drawCenteredText((_frame % 2) == 0 ? "CHECK SIGNAL" : " ", 54);
  _display.display();
  _frame = (_frame + 1) % 2;
}

void Wifi_Lora_Connect_Effect::Disconnect(ConnectionType type) {
  if (!_ready) {
    return;
  }

  selectScreen(Screen::DISCONNECTING, type);
  _holdUntil = millis() + 800;

  _display.clearDisplay();
  drawHeader(type);
  drawReconnectIcon(64, 27);
  drawCenteredText("RECONNECTING", 42);
  drawCenteredText("RESET RADIO", 54);
  _display.display();
}

void Wifi_Lora_Connect_Effect::RestartESP32(ConnectionType type) {
  if (!_ready) {
    return;
  }

  selectScreen(Screen::RESTARTING, type);

  _display.clearDisplay();
  drawHeader(type);
  drawRestartIcon(64, 27);
  drawCenteredText("RESTART ESP32", 42);
  drawCenteredText("PLEASE WAIT...", 54);
  _display.display();
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
  if (signalStrength == 0 || signalStrength > -50) {
    return 4;
  }
  if (signalStrength > -65) {
    return 3;
  }
  if (signalStrength > -80) {
    return 2;
  }
  return 1;
}

void Wifi_Lora_Connect_Effect::drawHeader(ConnectionType type) {
  drawCenteredText(type == ConnectionType::WIFI ? "WIFI" : "LORA", 0);
  _display.drawFastHLine(0, 9, SCREEN_WIDTH, SH110X_WHITE);
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

void Wifi_Lora_Connect_Effect::drawReconnectIcon(int16_t centerX,
                                                  int16_t centerY) {
  _display.drawCircle(centerX, centerY, 11, SH110X_WHITE);
  _display.fillTriangle(centerX + 8, centerY - 10, centerX + 15,
                        centerY - 10, centerX + 12, centerY - 4,
                        SH110X_WHITE);
  _display.fillTriangle(centerX - 8, centerY + 10, centerX - 15,
                        centerY + 10, centerX - 12, centerY + 4,
                        SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawRestartIcon(int16_t centerX,
                                                int16_t centerY) {
  _display.drawCircleHelper(centerX, centerY, 12, 0x0F, SH110X_WHITE);
  _display.fillRect(centerX - 2, centerY - 14, 5, 13, SH110X_BLACK);
  _display.drawFastVLine(centerX, centerY - 15, 13, SH110X_WHITE);
  _display.fillTriangle(centerX + 8, centerY - 11, centerX + 15,
                        centerY - 10, centerX + 12, centerY - 4,
                        SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawDashboardHeader(
    const MasterDashboardState &state) {
  _display.setTextSize(1);
  _display.setCursor(1, 1);
  _display.print("MASTER");
  _display.setCursor(42, 1);
  _display.print("GW");

  _display.setCursor(73, 1);
  switch (state.loraState) {
    case LoraDisplayState::CONNECTED:
      _display.print("L+");
      break;
    case LoraDisplayState::CONNECTING:
      _display.print("L~");
      break;
    case LoraDisplayState::LOST:
      _display.print("L!");
      break;
    case LoraDisplayState::STANDBY:
    default:
      _display.print("L-");
      break;
  }

  _display.setCursor(98, 1);
  _display.print("W");
  drawSignalBars(126, 9, signalLevel(state.wifiRssi));
  _display.drawFastHLine(0, 10, SCREEN_WIDTH, SH110X_WHITE);
}

void Wifi_Lora_Connect_Effect::drawGatewayIcon(
    uint8_t frame, LoraDisplayState loraState, int16_t loraRssi) {
  const int16_t centerX = 17;
  const int16_t antennaY = 27;

  uint8_t waveLevel = 1;
  if (loraState == LoraDisplayState::CONNECTING) {
    waveLevel = 1 + (frame % 3);
  } else if (loraState == LoraDisplayState::CONNECTED) {
    waveLevel = signalLevel(loraRssi);
  } else if (loraState == LoraDisplayState::STANDBY) {
    waveLevel = 1 + (frame % 2);
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
  _display.drawLine(13, 39, 21, 39, SH110X_WHITE);
  _display.drawLine(11, 44, 23, 44, SH110X_WHITE);
  _display.drawLine(13, 38, 22, 44, SH110X_WHITE);
  _display.drawLine(21, 38, 12, 44, SH110X_WHITE);
  _display.drawFastHLine(7, 50, 21, SH110X_WHITE);
  _display.drawFastHLine(10, 52, 15, SH110X_WHITE);

  if (loraState == LoraDisplayState::LOST && (frame % 2) == 0) {
    _display.drawLine(11, 20, 23, 32, SH110X_WHITE);
    _display.drawLine(23, 20, 11, 32, SH110X_WHITE);
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

  snprintf(line, sizeof(line), "WIFI %ddBm", state.wifiRssi);
  _display.setCursor(39, 13);
  _display.print(line);

  switch (state.loraState) {
    case LoraDisplayState::CONNECTING: {
      const char spinner[] = {'|', '/', '-', '\\'};
      snprintf(line, sizeof(line), "LORA SEARCH %c", spinner[frame % 4]);
      break;
    }
    case LoraDisplayState::CONNECTED:
      if (state.loraRssi != 0) {
        snprintf(line, sizeof(line), "LORA %ddBm", state.loraRssi);
      } else {
        snprintf(line, sizeof(line), "LORA LINK");
      }
      break;
    case LoraDisplayState::LOST:
      snprintf(line, sizeof(line), "LORA LOST");
      break;
    case LoraDisplayState::STANDBY:
    default:
      snprintf(line, sizeof(line), "LORA STANDBY");
      break;
  }
  _display.setCursor(39, 23);
  _display.print(line);

  const char spinner[] = {'|', '/', '-', '\\'};
  switch (state.sheetState) {
    case SheetDisplayState::SYNCING:
      snprintf(line, sizeof(line), "SHEET SYNC %c", spinner[frame % 4]);
      break;
    case SheetDisplayState::SENDING:
      snprintf(line, sizeof(line), "SHEET SEND %c", spinner[frame % 4]);
      break;
    case SheetDisplayState::SUCCESS:
      snprintf(line, sizeof(line), "SHEET OK");
      break;
    case SheetDisplayState::ERROR:
      snprintf(line, sizeof(line), "SHEET ERROR");
      break;
    case SheetDisplayState::READY:
    default:
      snprintf(line, sizeof(line), "SHEET READY");
      break;
  }
  _display.setCursor(39, 33);
  _display.print(line);

  if (state.loraState == LoraDisplayState::STANDBY) {
    snprintf(line, sizeof(line), "NODES -- Q:%u",
             static_cast<unsigned>(state.pendingUploads));
  } else {
    snprintf(line, sizeof(line), "NODES %02u Q:%u",
             static_cast<unsigned>(state.nodeCount),
             static_cast<unsigned>(state.pendingUploads));
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
      strftime(text, sizeof(text), "%d/%m %H:%M:%S", &localTime);
    } else {
      snprintf(text, sizeof(text), "TIME ERROR");
    }
  } else {
    const char spinner[] = {'|', '/', '-', '\\'};
    snprintf(text, sizeof(text), "TIME SYNC %c", spinner[frame % 4]);
  }
  drawCenteredText(text, 56);
}
