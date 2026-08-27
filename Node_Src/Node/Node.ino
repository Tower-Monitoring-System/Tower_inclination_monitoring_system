#include <math.h>

#include "src/OLED/Lora_Connect_Effect.h"

// OLED SH1106G 1.3 inch dung I2C hardware mac dinh cua ESP32 WROOM:
// SDA = GPIO21, SCL = GPIO22. Khong remap SDA/SCL sang GPIO khac.
constexpr uint8_t OLED_I2C_ADDRESS = 0x3C;

constexpr uint32_t SENSOR_SAMPLE_INTERVAL_MS = 150UL;
constexpr uint32_t DEMO_STATE_INTERVAL_MS = 3000UL;

Lora_Connect_Effect nodeDisplay;

const Lora_Connect_Effect::State DEMO_STATES[] = {
    Lora_Connect_Effect::State::READY,
    Lora_Connect_Effect::State::SENDING,
    Lora_Connect_Effect::State::SUCCESS,
    Lora_Connect_Effect::State::FAILED,
    Lora_Connect_Effect::State::RETRY,
    Lora_Connect_Effect::State::DISCONNECTED,
};
constexpr uint8_t DEMO_STATE_COUNT =
    sizeof(DEMO_STATES) / sizeof(DEMO_STATES[0]);

uint32_t lastSensorSampleAt = 0;
uint8_t currentDemoState = 0;

void updateDemoTelemetry(uint32_t now);
void updateDemoLoraState(uint32_t now);

void setup() {
  Serial.begin(115200);

  if (!nodeDisplay.begin(OLED_I2C_ADDRESS)) {
    Serial.println("[OLED] Khong tim thay SH1106G tai dia chi 0x3C.");
    return;
  }

  nodeDisplay.setTelemetry("TWR-01", 0.64F, 0.00F, 0.00F, 4.20F, 32.0F);
  nodeDisplay.setLoraState(Lora_Connect_Effect::State::READY);
  nodeDisplay.update();
  Serial.println("[OLED] Node dashboard da san sang.");
}

void loop() {
  const uint32_t now = millis();

  // Thay hai ham demo nay bang du lieu MPU6050, LM35/Battery va SX1278.
  updateDemoTelemetry(now);
  updateDemoLoraState(now);
  nodeDisplay.update();

  // yield() chi nhuong CPU cho ESP32, khong tao tre blocking nhu delay().
  yield();
}

void updateDemoTelemetry(uint32_t now) {
  if (now - lastSensorSampleAt < SENSOR_SAMPLE_INTERVAL_MS) {
    return;
  }
  lastSensorSampleAt = now;

  const float phase = static_cast<float>(now % 12000UL) / 12000.0F;
  const float angle = phase * 2.0F * PI;
  const float x = 0.64F + (0.18F * sinf(angle));
  const float y = 0.12F * cosf(angle * 0.8F);
  const float z = 0.08F * sinf(angle * 0.55F);
  const float battery = 4.20F - (0.12F * phase);
  const float temperature = 32.0F + (0.8F * sinf(angle * 0.35F));

  nodeDisplay.setTelemetry("TWR-01", x, y, z, battery, temperature);
}

void updateDemoLoraState(uint32_t now) {
  const uint8_t nextState = static_cast<uint8_t>(
      (now / DEMO_STATE_INTERVAL_MS) % DEMO_STATE_COUNT);
  if (nextState == currentDemoState) {
    return;
  }

  currentDemoState = nextState;
  nodeDisplay.setLoraState(DEMO_STATES[currentDemoState]);
}
