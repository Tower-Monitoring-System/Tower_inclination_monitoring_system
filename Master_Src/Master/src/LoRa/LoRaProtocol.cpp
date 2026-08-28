#include "LoRaProtocol.h"

#include <stddef.h>
#include <string.h>

namespace TowerLoRaProtocol {
namespace {
constexpr uint8_t MAGIC_LOW = static_cast<uint8_t>(MAGIC & 0xFFU);
constexpr uint8_t MAGIC_HIGH = static_cast<uint8_t>((MAGIC >> 8U) & 0xFFU);

template <typename Packet>
uint16_t packetCrc(const Packet &packet) {
  return crc16Ccitt(reinterpret_cast<const uint8_t *>(&packet),
                    offsetof(Packet, crc));
}
}  // namespace

uint16_t crc16Ccitt(const uint8_t *data, size_t length) {
  uint16_t crc = 0xFFFFU;
  for (size_t index = 0; index < length; ++index) {
    crc ^= static_cast<uint16_t>(data[index]) << 8U;
    for (uint8_t bit = 0; bit < 8U; ++bit) {
      crc = (crc & 0x8000U) != 0U
                ? static_cast<uint16_t>((crc << 1U) ^ 0x1021U)
                : static_cast<uint16_t>(crc << 1U);
    }
  }
  return crc;
}

void finalize(DataPacket &packet) {
  packet.magic = MAGIC;
  packet.version = VERSION;
  packet.type = DATA_TYPE;
  packet.crc = packetCrc(packet);
}

void finalize(AckPacket &packet) {
  packet.magic = MAGIC;
  packet.version = VERSION;
  packet.type = ACK_TYPE;
  packet.crc = packetCrc(packet);
}

bool validate(const DataPacket &packet) {
  return packet.magic == MAGIC && packet.version == VERSION &&
         packet.type == DATA_TYPE && packet.crc == packetCrc(packet);
}

bool validate(const AckPacket &packet) {
  return packet.magic == MAGIC && packet.version == VERSION &&
         packet.type == ACK_TYPE && packet.crc == packetCrc(packet);
}

PacketParser::PacketParser() : _buffer{}, _count(0), _expectedSize(0) {}

void PacketParser::reset() {
  _count = 0;
  _expectedSize = 0;
}

void PacketParser::restartFrom(uint8_t value) {
  reset();
  if (value == MAGIC_LOW) {
    _buffer[0] = value;
    _count = 1;
  }
}

ParseResult PacketParser::push(uint8_t value, DataPacket &dataPacket,
                               AckPacket &ackPacket) {
  if (_count == 0U) {
    if (value == MAGIC_LOW) {
      _buffer[_count++] = value;
    }
    return ParseResult::NONE;
  }

  if (_count >= MAX_PACKET_SIZE) {
    restartFrom(value);
    return ParseResult::INVALID;
  }

  _buffer[_count++] = value;

  if (_count == 2U && _buffer[1] != MAGIC_HIGH) {
    restartFrom(value);
    return ParseResult::INVALID;
  }

  if (_count == 4U) {
    if (_buffer[2] != VERSION) {
      restartFrom(value);
      return ParseResult::INVALID;
    }

    if (_buffer[3] == DATA_TYPE) {
      _expectedSize = sizeof(DataPacket);
    } else if (_buffer[3] == ACK_TYPE) {
      _expectedSize = sizeof(AckPacket);
    } else {
      restartFrom(value);
      return ParseResult::INVALID;
    }
  }

  if (_expectedSize == 0U || _count < _expectedSize) {
    return ParseResult::NONE;
  }

  const uint8_t lastValue = value;
  if (_buffer[3] == DATA_TYPE) {
    memcpy(&dataPacket, _buffer, sizeof(dataPacket));
    const bool valid = validate(dataPacket);
    reset();
    if (!valid) {
      restartFrom(lastValue);
      return ParseResult::INVALID;
    }
    return ParseResult::DATA;
  }

  memcpy(&ackPacket, _buffer, sizeof(ackPacket));
  const bool valid = validate(ackPacket);
  reset();
  if (!valid) {
    restartFrom(lastValue);
    return ParseResult::INVALID;
  }
  return ParseResult::ACK;
}

}  // namespace TowerLoRaProtocol
