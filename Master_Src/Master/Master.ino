#include <Arduino.h>
#include <Wire.h>

// ============================================================
// LOCAL LIBRARY
// Không sử dụng Adafruit_SH110X từ Library Manager
// ============================================================
#include "src/Adafruit_SH110X.h"

// ============================================================
// OLED CONFIG
// ============================================================
#define OLED_WIDTH     128
#define OLED_HEIGHT    64

#define OLED_SDA       18
#define OLED_SCL       19

#define OLED_RESET     -1
#define OLED_ADDRESS   0x3C

Adafruit_SH1106G display(
  OLED_WIDTH,
  OLED_HEIGHT,
  &Wire,
  OLED_RESET
);

// ============================================================
// EFFECT SETTINGS
// ============================================================
#define FRAME_DELAY 25

// ============================================================
// FUNCTION PROTOTYPES
// ============================================================
void effectBoot();
void effectLoading();
void effectScanLine();
void effectWave();
void effectBouncingBall();
void effectRadar();
void effectMatrix();
void effectTower();
void effectFadeText();


// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(115200);

  delay(300);

  Serial.println();
  Serial.println("==============================");
  Serial.println("OLED SH1106 LOCAL LIBRARY TEST");
  Serial.println("==============================");

  // ----------------------------------------------------------
  // ESP32 I2C
  // SDA = GPIO18
  // SCL = GPIO19
  // ----------------------------------------------------------
  Wire.begin(OLED_SDA, OLED_SCL);

  // ----------------------------------------------------------
  // Initialize OLED
  // ----------------------------------------------------------
  if (!display.begin(OLED_ADDRESS, true)) {
    Serial.println("ERROR: OLED initialization failed!");

    while (true) {
      delay(1000);
    }
  }

  Serial.println("OLED initialized successfully.");
  Serial.println("Using local libraries from /src");

  display.clearDisplay();
  display.display();

  delay(300);

  effectBoot();
}


// ============================================================
// LOOP
// ============================================================
void loop() {

  effectLoading();

  effectScanLine();

  effectWave();

  effectBouncingBall();

  effectRadar();

  effectMatrix();

  effectTower();

  effectFadeText();
}


// ============================================================
// 1. BOOT EFFECT
// ============================================================
void effectBoot() {

  display.clearDisplay();

  // Border animation
  for (int x = 0; x <= OLED_WIDTH; x += 4) {

    display.clearDisplay();

    display.drawLine(
      0,
      0,
      x,
      0,
      SH110X_WHITE
    );

    display.drawLine(
      OLED_WIDTH - 1,
      OLED_HEIGHT - 1,
      OLED_WIDTH - x,
      OLED_HEIGHT - 1,
      SH110X_WHITE
    );

    display.display();

    delay(15);
  }

  for (int y = 0; y <= OLED_HEIGHT; y += 4) {

    display.drawLine(
      0,
      0,
      0,
      y,
      SH110X_WHITE
    );

    display.drawLine(
      OLED_WIDTH - 1,
      OLED_HEIGHT - 1,
      OLED_WIDTH - 1,
      OLED_HEIGHT - y,
      SH110X_WHITE
    );

    display.display();

    delay(15);
  }

  display.clearDisplay();

  display.drawRect(
    0,
    0,
    OLED_WIDTH,
    OLED_HEIGHT,
    SH110X_WHITE
  );

  display.setTextColor(SH110X_WHITE);

  display.setTextSize(1);
  display.setCursor(24, 12);
  display.println("SMART TOWER");

  display.setCursor(15, 28);
  display.println("MONITORING SYSTEM");

  display.setCursor(32, 46);
  display.println("Starting...");

  display.display();

  delay(1500);
}


// ============================================================
// 2. LOADING BAR
// ============================================================
void effectLoading() {

  for (int progress = 0; progress <= 100; progress += 2) {

    display.clearDisplay();

    display.setTextColor(SH110X_WHITE);

    display.setTextSize(1);

    display.setCursor(37, 10);
    display.print("LOADING");

    // Loading border
    display.drawRect(
      13,
      30,
      102,
      12,
      SH110X_WHITE
    );

    int barWidth = map(
      progress,
      0,
      100,
      0,
      98
    );

    display.fillRect(
      15,
      32,
      barWidth,
      8,
      SH110X_WHITE
    );

    display.setCursor(52, 50);

    display.print(progress);
    display.print("%");

    display.display();

    delay(20);
  }

  delay(500);
}


// ============================================================
// 3. SCAN LINE EFFECT
// ============================================================
void effectScanLine() {

  for (int y = 0; y < OLED_HEIGHT; y += 2) {

    display.clearDisplay();

    display.drawRect(
      0,
      0,
      OLED_WIDTH,
      OLED_HEIGHT,
      SH110X_WHITE
    );

    display.setTextSize(1);
    display.setTextColor(SH110X_WHITE);

    display.setCursor(27, 10);
    display.println("SYSTEM SCAN");

    display.setCursor(26, 48);
    display.println("PLEASE WAIT");

    // Scan line
    display.drawFastHLine(
      4,
      y,
      120,
      SH110X_WHITE
    );

    if (y > 2) {
      display.drawFastHLine(
        10,
        y - 2,
        108,
        SH110X_WHITE
      );
    }

    display.display();

    delay(25);
  }

  delay(300);
}


// ============================================================
// 4. SINE WAVE EFFECT
// ============================================================
void effectWave() {

  float phase = 0;

  for (int frame = 0; frame < 160; frame++) {

    display.clearDisplay();

    display.setTextSize(1);
    display.setTextColor(SH110X_WHITE);

    display.setCursor(4, 2);
    display.print("SENSOR SIGNAL");

    display.drawFastHLine(
      0,
      32,
      OLED_WIDTH,
      SH110X_WHITE
    );

    int previousY = 32;

    for (int x = 0; x < OLED_WIDTH; x++) {

      float rad =
        (x * 0.15f) +
        phase;

      int y =
        32 +
        (int)(sin(rad) * 18);

      if (x > 0) {

        display.drawLine(
          x - 1,
          previousY,
          x,
          y,
          SH110X_WHITE
        );
      }

      previousY = y;
    }

    phase += 0.20f;

    display.display();

    delay(FRAME_DELAY);
  }
}


// ============================================================
// 5. BOUNCING BALL EFFECT
// ============================================================
void effectBouncingBall() {

  float x = 10;
  float y = 20;

  float vx = 2.1;
  float vy = 1.6;

  const int radius = 4;

  for (int frame = 0; frame < 180; frame++) {

    display.clearDisplay();

    // Border
    display.drawRect(
      0,
      0,
      OLED_WIDTH,
      OLED_HEIGHT,
      SH110X_WHITE
    );

    // Ball
    display.fillCircle(
      (int)x,
      (int)y,
      radius,
      SH110X_WHITE
    );

    // Motion trail
    display.drawCircle(
      (int)(x - vx * 2),
      (int)(y - vy * 2),
      radius,
      SH110X_WHITE
    );

    x += vx;
    y += vy;

    if (x >= OLED_WIDTH - radius - 2 ||
        x <= radius + 1) {

      vx = -vx;
    }

    if (y >= OLED_HEIGHT - radius - 2 ||
        y <= radius + 1) {

      vy = -vy;
    }

    display.display();

    delay(20);
  }
}


// ============================================================
// 6. RADAR EFFECT
// ============================================================
void effectRadar() {

  const int centerX = 64;
  const int centerY = 33;

  const int radarRadius = 28;

  for (int angle = 0; angle < 720; angle += 4) {

    display.clearDisplay();

    display.setTextSize(1);
    display.setTextColor(SH110X_WHITE);

    display.setCursor(2, 2);
    display.print("RADAR");

    // Radar circles
    display.drawCircle(
      centerX,
      centerY,
      radarRadius,
      SH110X_WHITE
    );

    display.drawCircle(
      centerX,
      centerY,
      19,
      SH110X_WHITE
    );

    display.drawCircle(
      centerX,
      centerY,
      10,
      SH110X_WHITE
    );

    // Crosshair
    display.drawFastHLine(
      centerX - radarRadius,
      centerY,
      radarRadius * 2,
      SH110X_WHITE
    );

    display.drawFastVLine(
      centerX,
      centerY - radarRadius,
      radarRadius * 2,
      SH110X_WHITE
    );

    float rad =
      angle *
      0.0174532925f;

    int x =
      centerX +
      cos(rad) *
      radarRadius;

    int y =
      centerY +
      sin(rad) *
      radarRadius;

    // Radar sweep
    display.drawLine(
      centerX,
      centerY,
      x,
      y,
      SH110X_WHITE
    );

    // Targets
    display.fillCircle(
      centerX + 14,
      centerY - 9,
      2,
      SH110X_WHITE
    );

    display.fillCircle(
      centerX - 18,
      centerY + 11,
      2,
      SH110X_WHITE
    );

    display.fillCircle(
      centerX + 5,
      centerY + 18,
      1,
      SH110X_WHITE
    );

    display.display();

    delay(20);
  }
}


// ============================================================
// 7. MATRIX EFFECT
// ============================================================
void effectMatrix() {

  const int columns = 16;

  int yPos[columns];
  int speed[columns];

  for (int i = 0; i < columns; i++) {

    yPos[i] =
      random(
        -OLED_HEIGHT,
        OLED_HEIGHT
      );

    speed[i] =
      random(
        1,
        5
      );
  }

  for (int frame = 0; frame < 140; frame++) {

    display.clearDisplay();

    display.setTextSize(1);
    display.setTextColor(SH110X_WHITE);

    for (int i = 0; i < columns; i++) {

      int x = i * 8;

      display.setCursor(
        x,
        yPos[i]
      );

      char c =
        random(
          0,
          2
        ) ?
        '1' :
        '0';

      display.print(c);

      display.setCursor(
        x,
        yPos[i] - 9
      );

      display.print(
        random(
          0,
          2
        )
      );

      display.setCursor(
        x,
        yPos[i] - 18
      );

      display.print(
        random(
          0,
          2
        )
      );

      yPos[i] += speed[i];

      if (yPos[i] > OLED_HEIGHT + 20) {

        yPos[i] =
          random(
            -40,
            0
          );

        speed[i] =
          random(
            1,
            5
          );
      }
    }

    display.display();

    delay(35);
  }
}


// ============================================================
// 8. TOWER MONITORING EFFECT
// ============================================================
void effectTower() {

  for (int frame = 0; frame < 140; frame++) {

    display.clearDisplay();

    display.setTextColor(SH110X_WHITE);
    display.setTextSize(1);

    display.setCursor(2, 2);
    display.print("TOWER MONITOR");

    // Ground
    display.drawFastHLine(
      0,
      61,
      OLED_WIDTH,
      SH110X_WHITE
    );

    // Tower
    int centerX = 64;

    display.drawLine(
      centerX,
      16,
      centerX - 16,
      60,
      SH110X_WHITE
    );

    display.drawLine(
      centerX,
      16,
      centerX + 16,
      60,
      SH110X_WHITE
    );

    // Horizontal tower bars
    display.drawLine(
      55,
      35,
      73,
      35,
      SH110X_WHITE
    );

    display.drawLine(
      50,
      48,
      78,
      48,
      SH110X_WHITE
    );

    // Diagonal reinforcement
    display.drawLine(
      55,
      35,
      78,
      48,
      SH110X_WHITE
    );

    display.drawLine(
      73,
      35,
      50,
      48,
      SH110X_WHITE
    );

    // Antenna
    display.drawFastVLine(
      centerX,
      9,
      8,
      SH110X_WHITE
    );

    // Wireless signal animation
    int signal =
      (frame / 10) % 3;

    if (signal >= 0) {
      display.drawCircle(
        centerX,
        10,
        5,
        SH110X_WHITE
      );
    }

    if (signal >= 1) {
      display.drawCircle(
        centerX,
        10,
        10,
        SH110X_WHITE
      );
    }

    if (signal >= 2) {
      display.drawCircle(
        centerX,
        10,
        15,
        SH110X_WHITE
      );
    }

    // Data points
    display.fillCircle(
      centerX,
      35,
      2,
      SH110X_WHITE
    );

    display.display();

    delay(50);
  }
}


// ============================================================
// 9. FINAL TEXT EFFECT
// ============================================================
void effectFadeText() {

  // Flash effect
  for (int i = 0; i < 4; i++) {

    display.clearDisplay();

    if (i % 2 == 0) {

      display.fillRect(
        0,
        0,
        OLED_WIDTH,
        OLED_HEIGHT,
        SH110X_WHITE
      );
    }

    display.display();

    delay(100);
  }

  display.clearDisplay();

  display.drawRect(
    0,
    0,
    OLED_WIDTH,
    OLED_HEIGHT,
    SH110X_WHITE
  );

  display.setTextColor(SH110X_WHITE);

  display.setTextSize(1);

  display.setCursor(
    29,
    10
  );

  display.print(
    "SMART TOWER"
  );

  display.setCursor(
    27,
    27
  );

  display.print(
    "SYSTEM READY"
  );

  display.setCursor(
    34,
    45
  );

  display.print(
    "ESP32 + OLED"
  );

  display.display();

  delay(2000);
}