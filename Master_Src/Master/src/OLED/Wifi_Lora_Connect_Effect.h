#ifndef WIFI_LORA_CONNECT_EFFECT_H
#define WIFI_LORA_CONNECT_EFFECT_H

#include <Arduino.h>
#include <Wire.h>

#include "Adafruit_SH110X.h"

enum class ConnectionType : uint8_t {
  WIFI,
  LORA
};

/**
 * Hieu ung trang thai ket noi cho OLED SH1106 1.3 inch (128x64).
 *
 * Thu vien chi hien thi trang thai. Sketch chinh van chiu trach nhiem ket noi,
 * ngat ket noi va khoi dong lai phan cung Wi-Fi/LoRa.
 */
class Wifi_Lora_Connect_Effect {
public:
  explicit Wifi_Lora_Connect_Effect(TwoWire &wire = Wire,
                                    int8_t resetPin = -1);

  bool begin(int8_t sdaPin = 18, int8_t sclPin = 19,
             uint8_t i2cAddress = 0x3C);
  bool isReady() const;

  void ConnectingEffect(ConnectionType type = ConnectionType::WIFI);
  void ConnectedEffect(ConnectionType type = ConnectionType::WIFI,
                       int16_t signalStrength = 0);
  void LostConnectEffect(ConnectionType type = ConnectionType::WIFI);
  void Disconnect(ConnectionType type = ConnectionType::WIFI);
  void RestartESP32(ConnectionType type = ConnectionType::WIFI);

  void clear();

private:
  enum class Screen : uint8_t {
    NONE,
    CONNECTING,
    CONNECTED,
    LOST,
    DISCONNECTING,
    RESTARTING
  };

  static const uint8_t SCREEN_WIDTH = 128;
  static const uint8_t SCREEN_HEIGHT = 64;

  TwoWire *_wire;
  Adafruit_SH1106G _display;
  bool _ready;
  Screen _screen;
  ConnectionType _type;
  uint8_t _frame;
  uint32_t _lastFrameAt;
  uint32_t _holdUntil;

  bool selectScreen(Screen screen, ConnectionType type);
  bool frameDue(uint32_t now, uint16_t interval, bool screenChanged);
  uint8_t signalLevel(int16_t signalStrength) const;

  void drawHeader(ConnectionType type);
  void drawCenteredText(const char *text, int16_t y, uint8_t size = 1);
  void drawConnectionIcon(ConnectionType type, int16_t centerX,
                          int16_t centerY, uint8_t level);
  void drawWifiIcon(int16_t centerX, int16_t baselineY, uint8_t level);
  void drawLoraIcon(int16_t centerX, int16_t centerY, uint8_t level);
  void drawReconnectIcon(int16_t centerX, int16_t centerY);
  void drawRestartIcon(int16_t centerX, int16_t centerY);
};

#endif
