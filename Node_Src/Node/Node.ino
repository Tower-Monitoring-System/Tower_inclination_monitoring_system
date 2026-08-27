#include "src/OLED/Lora_Connect_Effect.h"
#include "src/Sensors/Tower_Sensors.h"

// OLED SH1106G 1.3 inch dung I2C hardware mac dinh cua ESP32 WROOM:
// SDA = GPIO21, SCL = GPIO22. Khong remap SDA/SCL sang GPIO khac.
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

// MPU6050 dung controller I2C thu hai, tach hoan toan khoi bus OLED.
constexpr int8_t MPU6050_SDA_PIN = 18;
constexpr int8_t MPU6050_SCL_PIN = 19;
constexpr uint8_t LM35_PIN = 4;
constexpr uint32_t OLED_TELEMETRY_INTERVAL_MS = 67UL;  // Xap xi 15 FPS.

Lora_Connect_Effect nodeDisplay;
TwoWire mpuWire(1);
TowerSensors towerSensors(mpuWire);

uint32_t lastOledTelemetryAt = 0;

void updateDisplayFromSensors(uint32_t now);

void setup() {
  Serial.begin(115200);

  if (!nodeDisplay.begin(OLED_I2C_ADDRESS)) {
    Serial.println("[OLED] Khong tim thay SH1106G tai dia chi 0x3C.");
  } else {
    Serial.println("[OLED] Node dashboard da san sang tren GPIO21/GPIO22.");
  }

  nodeDisplay.setTowerId("TWR-01");

  // Khong dung du lieu mo phong. Cac gia tri chua co du lieu that duoc hien
  // thi bang placeholder cho den khi cam bien/phan cung tuong ung cap nhat.
  nodeDisplay.setAngles(NAN, NAN, NAN);
  nodeDisplay.setTemperature(NAN);
  nodeDisplay.setBatteryVoltage(NAN);
  nodeDisplay.update();

  if (!towerSensors.begin(MPU6050_SDA_PIN, MPU6050_SCL_PIN, LM35_PIN)) {
    Serial.println("[SENSOR] OLED/LM35 van tiep tuc; MPU6050 se tu thu lai.");
  }
}

void loop() {
  const uint32_t now = millis();

  towerSensors.update(now);
  updateDisplayFromSensors(now);
  nodeDisplay.update();

  // yield() chi nhuong CPU cho ESP32, khong tao tre blocking nhu delay().
  yield();
}

void updateDisplayFromSensors(uint32_t now) {
  if (now - lastOledTelemetryAt < OLED_TELEMETRY_INTERVAL_MS) {
    return;
  }
  lastOledTelemetryAt = now;

  const TowerSensorData &sensorData = towerSensors.data();
  if (sensorData.orientationValid) {
    nodeDisplay.setAngles(sensorData.angleXDegrees, sensorData.angleYDegrees,
                          sensorData.angleZDegrees);
  } else {
    nodeDisplay.setAngles(NAN, NAN, NAN);
  }

  nodeDisplay.setTemperature(sensorData.temperatureValid
                                 ? sensorData.temperatureCelsius
                                 : NAN);

  // LoRa/canh bao sau nay phai dung structuralRoll/Pitch/Tilt va
  // tiltAlarmActive, khong dung truc tiep Fast Angle dang hien tren OLED.
}
