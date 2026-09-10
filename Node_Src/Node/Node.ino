#include "src/OLED/Lora_Connect_Effect.h"
#include "src/LoRa/NodeLoRaManager.h"
#include "src/Sensors/Tower_Sensors.h"

//-------------- OLED SH1106G 1.3 inch --------------//
// SDA = GPIO21, SCL = GPIO22
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

//-------------- MPU6050 --------------//
// SDA = GPIO21, SCL = GPIO22
constexpr int8_t MPU6050_SDA_PIN = 18;
constexpr int8_t MPU6050_SCL_PIN = 19;
constexpr uint8_t LM35_PIN = 4;
constexpr uint8_t BATTERY_MEASURE_PIN = 26;
constexpr uint8_t BATTERY_ADC_PIN = 27;

//-------------- Relay bao ve qua nhiet --------------//
constexpr uint8_t OVERHEAT_RELAY_PIN = 25;
// Doi thanh LOW neu module relay thuc te kich muc thap.
constexpr uint8_t OVERHEAT_RELAY_ACTIVE_LEVEL = HIGH;
constexpr uint8_t OVERHEAT_RELAY_INACTIVE_LEVEL =
    OVERHEAT_RELAY_ACTIVE_LEVEL == HIGH ? LOW : HIGH;
constexpr float OVERHEAT_RELAY_ON_C = 40.0F;
constexpr float OVERHEAT_RELAY_OFF_C = 38.0F;
constexpr uint32_t OVERHEAT_RELAY_ON_PERSISTENCE_MS = 500UL;
constexpr uint32_t OVERHEAT_RELAY_OFF_PERSISTENCE_MS = 3000UL;

//-------------- AS32-TTL-100 / UART2 --------------//
constexpr int8_t LORA_RX_PIN = 16;
constexpr int8_t LORA_TX_PIN = 17;
constexpr int8_t LORA_AUX_PIN = 34;
constexpr int8_t LORA_M0_PIN = 33;
constexpr int8_t LORA_M1_PIN = 32;
constexpr uint16_t LORA_NODE_ID = 1U;

//---------- Button SET: tich cuc muc LOW ----------//
constexpr uint8_t OLED_BUTTON_PIN = 23;
constexpr uint32_t OLED_ON_DURATION_MS = 15000UL;
constexpr uint32_t BUTTON_DEBOUNCE_MS = 35UL;
constexpr uint32_t OLED_TELEMETRY_INTERVAL_MS = 67UL;  // Xap xi 15 FPS.

Lora_Connect_Effect nodeDisplay;
TwoWire mpuWire(1);
TowerSensors towerSensors(mpuWire);
HardwareSerial loraSerial(2);
NodeLoRaManager nodeLoRa(loraSerial, LORA_RX_PIN, LORA_TX_PIN, LORA_AUX_PIN,
                        LORA_M0_PIN, LORA_M1_PIN, LORA_NODE_ID);

uint32_t lastOledTelemetryAt = 0;
uint32_t oledAwakeSince = 0;
uint32_t buttonLastTransitionAt = 0;
bool oledAwake = false;
bool buttonRawState = HIGH;
bool buttonStableState = HIGH;
bool overheatRelayActive = false;
bool relayTransitionPending = false;
bool pendingRelayState = false;
bool relayTemperatureFaultActive = false;
uint32_t relayConditionSince = 0;
NodeLoRaStatus lastLoRaStatus = NodeLoRaStatus::DISCONNECTED;
bool loRaStatusInitialized = false;

void updateDisplayFromSensors(uint32_t now);
void updateOledButton(uint32_t now);
void wakeOled(uint32_t now);
void sleepOled();
void syncLoRaDisplayState();
void updateOverheatRelay(uint32_t now);
void setOverheatRelay(bool active, float temperatureCelsius);
LoraNodeState toDisplayState(NodeLoRaStatus status);

void setup() {
  // Ghi muc khong kich truoc pinMode de tranh xung dong relay khi boot.
  digitalWrite(OVERHEAT_RELAY_PIN, OVERHEAT_RELAY_INACTIVE_LEVEL);
  pinMode(OVERHEAT_RELAY_PIN, OUTPUT);

  pinMode(BATTERY_MEASURE_PIN, OUTPUT);
  digitalWrite(BATTERY_MEASURE_PIN, LOW);

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
  nodeDisplay.setAngles(NAN, NAN, NAN);
  nodeDisplay.setTemperature(NAN);
  nodeDisplay.setBatteryVoltage(NAN);
  nodeDisplay.setLoraState(LoraNodeState::SLEEP);
  nodeDisplay.sleep();
  oledAwake = false;

  if (!towerSensors.begin(MPU6050_SDA_PIN, MPU6050_SCL_PIN, LM35_PIN,
                          BATTERY_MEASURE_PIN, BATTERY_ADC_PIN)) {
    Serial.println("[SENSOR] OLED/LM35 van tiep tuc; MPU6050 se tu thu lai.");
  }

  nodeLoRa.begin(millis());
  syncLoRaDisplayState();
}

void loop() {
  const uint32_t now = millis();
  towerSensors.update(now);
  updateOverheatRelay(now);
  nodeLoRa.update(now, towerSensors);
  syncLoRaDisplayState();
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
}

void updateOverheatRelay(uint32_t now) {
  const TowerSensorData &sensorData = towerSensors.data();
  const bool temperatureValid =
      sensorData.temperatureValid && isfinite(sensorData.temperatureCelsius);

  if (!temperatureValid) {
    relayTransitionPending = false;
    // Giu nguyen trang thai khi LM35 loi: relay dang dong se khong bi mo ngoai
    // y muon, con luc boot relay van o trang thai khong kich an toan.
    if (!relayTemperatureFaultActive) {
      relayTemperatureFaultActive = true;
      Serial.printf("[RELAY] LM35 invalid; retaining relay %s\n",
                    overheatRelayActive ? "ON" : "OFF");
    }
    return;
  }

  if (relayTemperatureFaultActive) {
    relayTemperatureFaultActive = false;
    Serial.println("[RELAY] LM35 data restored");
  }

  bool requestedState = overheatRelayActive;
  if (!overheatRelayActive &&
      sensorData.temperatureCelsius >= OVERHEAT_RELAY_ON_C) {
    requestedState = true;
  } else if (overheatRelayActive &&
             sensorData.temperatureCelsius <= OVERHEAT_RELAY_OFF_C) {
    requestedState = false;
  } else {
    relayTransitionPending = false;
    return;
  }

  if (!relayTransitionPending || pendingRelayState != requestedState) {
    relayTransitionPending = true;
    pendingRelayState = requestedState;
    relayConditionSince = now;
    return;
  }

  const uint32_t requiredPersistence =
      requestedState ? OVERHEAT_RELAY_ON_PERSISTENCE_MS
                     : OVERHEAT_RELAY_OFF_PERSISTENCE_MS;
  if (now - relayConditionSince < requiredPersistence) {
    return;
  }

  relayTransitionPending = false;
  setOverheatRelay(requestedState, sensorData.temperatureCelsius);
}

void setOverheatRelay(bool active, float temperatureCelsius) {
  if (overheatRelayActive == active) {
    return;
  }

  digitalWrite(OVERHEAT_RELAY_PIN,
               active ? OVERHEAT_RELAY_ACTIVE_LEVEL
                      : OVERHEAT_RELAY_INACTIVE_LEVEL);
  overheatRelayActive = active;
  Serial.printf("[RELAY] %s at %.2f C\n", active ? "ON" : "OFF",
                temperatureCelsius);
}

void syncLoRaDisplayState() {
  const NodeLoRaStatus status = nodeLoRa.status();
  if (loRaStatusInitialized && status == lastLoRaStatus) {
    return;
  }

  lastLoRaStatus = status;
  loRaStatusInitialized = true;
  nodeDisplay.setLoraState(toDisplayState(status));
}

LoraNodeState toDisplayState(NodeLoRaStatus status) {
  switch (status) {
    case NodeLoRaStatus::SLEEP:
      return LoraNodeState::SLEEP;
    case NodeLoRaStatus::READY:
      return LoraNodeState::READY;
    case NodeLoRaStatus::SENDING:
      return LoraNodeState::SENDING;
    case NodeLoRaStatus::SUCCESS:
      return LoraNodeState::SUCCESS;
    case NodeLoRaStatus::RETRY:
      return LoraNodeState::RETRY;
    case NodeLoRaStatus::FAILED:
      return LoraNodeState::FAILED;
    case NodeLoRaStatus::DISCONNECTED:
    default:
      return LoraNodeState::DISCONNECTED;
  }
}
