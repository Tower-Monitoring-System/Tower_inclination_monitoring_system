#ifndef TOWER_LORA_PROTOCOL_H
#define TOWER_LORA_PROTOCOL_H

#include <Arduino.h>

namespace TowerLoRaProtocol {

constexpr uint16_t MAGIC = 0x4C54U;  // "TL" tren duong truyen little-endian.
constexpr uint8_t VERSION = 1U;
constexpr uint8_t DATA_TYPE = 1U;
constexpr uint8_t ACK_TYPE = 2U;

constexpr uint8_t FLAG_X_VALID = 1U << 0;
constexpr uint8_t FLAG_Y_VALID = 1U << 1;
constexpr uint8_t FLAG_Z_VALID = 1U << 2;
constexpr uint8_t FLAG_TEMPERATURE_VALID = 1U << 3;
constexpr uint8_t FLAG_BATTERY_VALID = 1U << 4;
// X/Y/Z duoc tao tu bo loc goc nhanh khi gia tri structural chua duoc
// xac nhan. Master van nhan mau, dong thoi co the nhan biet chat luong mau.
constexpr uint8_t FLAG_ORIENTATION_FALLBACK = 1U << 5;

constexpr uint8_t ACK_ACCEPTED = 0U;
constexpr uint8_t ACK_DUPLICATE = 1U;

#pragma pack(push, 1)
struct DataPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  uint16_t nodeId;
  uint32_t messageId;
  int16_t xCentidegrees;
  int16_t yCentidegrees;
  int16_t zCentidegrees;
  int16_t temperatureCentidegreesC;
  uint16_t batteryMillivolts;
  uint8_t validFlags;
  uint16_t crc;
};

struct AckPacket {
  uint16_t magic;
  uint8_t version;
  uint8_t type;
  uint16_t nodeId;
  uint32_t messageId;
  uint8_t status;
  uint16_t crc;
};
#pragma pack(pop)

static_assert(sizeof(DataPacket) == 23U,
              "LoRa DATA packet layout must stay fixed at 23 bytes");
static_assert(sizeof(AckPacket) == 13U,
              "LoRa ACK packet layout must stay fixed at 13 bytes");

uint16_t crc16Ccitt(const uint8_t *data, size_t length);
void finalize(DataPacket &packet);
void finalize(AckPacket &packet);
bool validate(const DataPacket &packet);
bool validate(const AckPacket &packet);

enum class ParseResult : uint8_t {
  NONE,
  DATA,
  ACK,
  INVALID
};

// Parser theo byte, khong cap phat heap va tu dong dong bo lai theo MAGIC.
class PacketParser {
public:
  PacketParser();

  void reset();
  ParseResult push(uint8_t value, DataPacket &dataPacket,
                   AckPacket &ackPacket);

private:
  static constexpr uint8_t MAX_PACKET_SIZE = sizeof(DataPacket);

  uint8_t _buffer[MAX_PACKET_SIZE];
  uint8_t _count;
  uint8_t _expectedSize;

  void restartFrom(uint8_t value);
};

}  // namespace TowerLoRaProtocol

#endif
