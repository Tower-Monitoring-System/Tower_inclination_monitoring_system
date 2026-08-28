#ifndef WIFI_LORA_CONNECT_EFFECT_H
#define WIFI_LORA_CONNECT_EFFECT_H

#include <Arduino.h>
#include <Wire.h>

#include "Adafruit_SH110X.h"

enum class ConnectionType : uint8_t {
  WIFI,
  LORA
};

enum class LoraDisplayState : uint8_t {
  STANDBY,
  CONNECTING,
  CONNECTED,
  RECEIVING,
  ACKNOWLEDGING,
  ERROR,
  LOST
};

enum class SheetDisplayState : uint8_t {
  SYNCING,
  READY,
  SENDING,
  SUCCESS,
  ERROR
};

struct MasterDashboardState {
  int16_t wifiRssi;
  LoraDisplayState loraState;
  int16_t loraRssi;
  uint8_t nodeCount;
  SheetDisplayState sheetState;
  uint8_t pendingUploads;
  bool timeSynchronized;
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

  // Giao dien chinh cua Master. Cac truong LoRa/node da san sang de cap nhat
  // khi module AS32-TTL-100 duoc tich hop sau nay.
  void MasterDashboard(const MasterDashboardState &state);

  void clear();

private:
  enum class Screen : uint8_t {
    NONE,
    CONNECTING,
    CONNECTED,
    DASHBOARD,
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
  LoraDisplayState _lastDashboardLoraState;
  bool _dashboardStateInitialized;

  bool selectScreen(Screen screen, ConnectionType type);
  bool frameDue(uint32_t now, uint16_t interval, bool screenChanged);
  uint8_t signalLevel(int16_t signalStrength) const;

  void drawHeader(ConnectionType type);
  void drawCenteredText(const char *text, int16_t y, uint8_t size = 1);
  void drawConnectionIcon(ConnectionType type, int16_t centerX,
                          int16_t centerY, uint8_t level);
  void drawWifiIcon(int16_t centerX, int16_t baselineY, uint8_t level);
  void drawLoraIcon(int16_t centerX, int16_t centerY, uint8_t level);
  void drawMiniWifiIcon(int16_t centerX, int16_t baselineY, uint8_t level);
  void drawMasterBadge();
  void drawReconnectIcon(int16_t centerX, int16_t centerY, uint8_t frame);
  void drawRestartIcon(int16_t centerX, int16_t centerY, uint8_t frame);
  void drawCheckIcon(int16_t centerX, int16_t centerY, uint8_t frame);
  void drawAlertIcon(int16_t centerX, int16_t centerY, uint8_t frame);
  void drawDashboardHeader(const MasterDashboardState &state);
  void drawGatewayIcon(uint8_t frame, LoraDisplayState loraState,
                       int16_t loraRssi);
  void drawSignalBars(int16_t rightX, int16_t baselineY, uint8_t level);
  void drawDashboardRows(const MasterDashboardState &state, uint8_t frame);
  void drawDashboardFooter(bool timeSynchronized, uint8_t frame);
};

#endif
