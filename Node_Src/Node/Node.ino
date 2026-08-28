#include "src/OLED/Lora_Connect_Effect.h"
#include "src/Sensors/Tower_Sensors.h"

// OLED SH1106G 1.3 inch dung I2C hardware mac dinh cua ESP32 WROOM:
// SDA = GPIO21, SCL = GPIO22. Khong remap SDA/SCL sang GPIO khac.
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

// MPU6050 dung controller I2C thu hai, tach hoan toan khoi bus OLED.
constexpr int8_t MPU6050_SDA_PIN = 18;
constexpr int8_t MPU6050_SCL_PIN = 19;
constexpr uint8_t LM35_PIN = 4;
constexpr uint8_t BATTERY_MEASURE_PIN = 26;
constexpr uint8_t BATTERY_ADC_PIN = 27;

// Button SET: tich cuc muc LOW, co R6 = 10 kOhm keo len 3V3 va
// C10 = 100 nF loc nhieu theo schematic.
constexpr uint8_t OLED_BUTTON_PIN = 23;
constexpr uint32_t OLED_ON_DURATION_MS = 15000UL;
constexpr uint32_t BUTTON_DEBOUNCE_MS = 35UL;
constexpr uint32_t OLED_TELEMETRY_INTERVAL_MS = 67UL;  // Xap xi 15 FPS.

Lora_Connect_Effect nodeDisplay;
TwoWire mpuWire(1);
TowerSensors towerSensors(mpuWire);

uint32_t lastOledTelemetryAt = 0;
uint32_t oledAwakeSince = 0;
uint32_t buttonLastTransitionAt = 0;
bool oledAwake = false;
bool buttonRawState = HIGH;
bool buttonStableState = HIGH;

void updateDisplayFromSensors(uint32_t now);
void updateOledButton(uint32_t now);
void wakeOled(uint32_t now);
void sleepOled();

void setup() {
  // Tat bo chia ap ngay tu dau qua trinh khoi dong. GPIO26 chi duoc bat trong
  // cua so do ngan de tranh dong ro lien tuc tu pin LiFePO4 4S.
  pinMode(BATTERY_MEASURE_PIN, OUTPUT);
  digitalWrite(BATTERY_MEASURE_PIN, LOW);

  // Button tren GPIO23 keo len 3V3 va bam se keo xuong GND.
  pinMode(OLED_BUTTON_PIN, INPUT);
  buttonRawState = digitalRead(OLED_BUTTON_PIN);
  buttonStableState = buttonRawState;

  Serial.begin(115200);

  if (!nodeDisplay.begin(OLED_I2C_ADDRESS)) {
    Serial.println("[OLED] Khong tim thay SH1106G tai dia chi 0x3C.");
  } else {
    Serial.println("[OLED] Node dashboard da san sang tren GPIO21/GPIO22.");
  }

  nodeDisplay.setTowerId("TWR-01");

  // Khong dung du lieu mo phong. Cac gia tri chua co du lieu that duoc luu
  // bang placeholder trong RAM, nhung OLED mac dinh ngu de tiet kiem pin.
  nodeDisplay.setAngles(NAN, NAN, NAN);
  nodeDisplay.setTemperature(NAN);
  nodeDisplay.setBatteryVoltage(NAN);
  nodeDisplay.sleep();
  oledAwake = false;

  if (!towerSensors.begin(MPU6050_SDA_PIN, MPU6050_SCL_PIN, LM35_PIN,
                          BATTERY_MEASURE_PIN, BATTERY_ADC_PIN)) {
    Serial.println("[SENSOR] OLED/LM35 van tiep tuc; MPU6050 se tu thu lai.");
  }
}

void loop() {
  const uint32_t now = millis();

  // Cam bien van cap nhat lien tuc nhu thuat toan cu. Button chi dieu khien
  // viec OLED co duoc bat va ve frame hay khong.
  towerSensors.update(now);
  updateOledButton(now);

  if (oledAwake) {
    updateDisplayFromSensors(now);
    nodeDisplay.update();
  }

  // yield() chi nhuong CPU cho ESP32, khong tao tre blocking nhu delay().
  yield();
}

void updateOledButton(uint32_t now) {
  const bool rawState = digitalRead(OLED_BUTTON_PIN);

  if (rawState != buttonRawState) {
    buttonRawState = rawState;
    buttonLastTransitionAt = now;
  }

  // Debounce non-blocking: chi cong nhan trang thai neu on dinh du lau.
  if (buttonStableState != buttonRawState &&
      now - buttonLastTransitionAt >= BUTTON_DEBOUNCE_MS) {
    buttonStableState = buttonRawState;

    // Chi xu ly canh bam xuong (HIGH -> LOW). Neu bam lai trong 15 giay,
    // timer duoc gia han them 15 giay tu lan bam moi nhat.
    if (buttonStableState == LOW) {
      wakeOled(now);
    }
  }

  if (oledAwake && now - oledAwakeSince >= OLED_ON_DURATION_MS) {
    sleepOled();
  }
}

void wakeOled(uint32_t now) {
  oledAwakeSince = now;

  if (!oledAwake) {
    oledAwake = true;
    nodeDisplay.wake();
  }

  // Ep lay snapshot cam bien moi nhat ngay khi user bam nut, khong cho phai
  // doi het chu ky telemetry 67 ms.
  lastOledTelemetryAt = now - OLED_TELEMETRY_INTERVAL_MS;
  updateDisplayFromSensors(now);
  nodeDisplay.forceRedraw();
}

void sleepOled() {
  nodeDisplay.sleep();
  oledAwake = false;
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
  nodeDisplay.setBatteryVoltage(sensorData.batteryValid
                                    ? sensorData.batteryVoltage
                                    : NAN);

  // LoRa/canh bao sau nay phai dung structuralRoll/Pitch/Tilt va
  // tiltAlarmActive, khong dung truc tiep Fast Angle dang hien tren OLED.
}
