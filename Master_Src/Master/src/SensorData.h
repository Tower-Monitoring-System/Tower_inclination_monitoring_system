#ifndef SENSOR_DATA_H
#define SENSOR_DATA_H

#include <Arduino.h>
#include <math.h>

const size_t SENSOR_TOWER_ID_CAPACITY = 32;
const size_t SENSOR_REQUEST_ID_CAPACITY = 40;

struct SensorReading {
  float x;
  float y;
  float z;
  float battery;
  char towerId[SENSOR_TOWER_ID_CAPACITY];
  char requestId[SENSOR_REQUEST_ID_CAPACITY];
};

inline bool isSensorReadingValid(const SensorReading &reading) {
  return isfinite(reading.x) && reading.x >= -180.0F &&
         reading.x <= 180.0F && isfinite(reading.y) &&
         reading.y >= -180.0F && reading.y <= 180.0F &&
         isfinite(reading.z) && reading.z >= -180.0F &&
         reading.z <= 180.0F && isfinite(reading.battery) &&
         reading.battery >= 0.0F && reading.battery <= 24.0F;
}

#endif
