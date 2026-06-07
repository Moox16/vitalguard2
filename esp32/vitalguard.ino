/*
 * VitalGuard — XIAO ESP32C3
 * Fall + Alert Detection → Wi-Fi → Supabase
 *
 * Hardware:
 *   MPU-6050  SDA→GPIO6  SCL→GPIO7  VCC→3.3V  GND→GND
 *   SSD1306   SDA→GPIO6  SCL→GPIO7  VCC→3.3V  GND→GND
 *   Mic A0    →GPIO2     D0→GPIO3   VCC→3.3V  GND→GND
 *
 * Libraries (Arduino Library Manager):
 *   - MPU6050 by Electronic Cats
 *   - Adafruit SSD1306
 *   - Adafruit GFX Library
 *   - ArduinoJson by Benoit Blanchon
 */

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include "MPU6050.h"
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>

// ── CONFIGURAÇÃO — ALTERA ESTES VALORES ──────────────────────
const char* WIFI_SSID      = "NomeDaRede";
const char* WIFI_PASSWORD  = "PasswordDaRede";

// Supabase — usa a service_role key (não a anon key)
const char* SUPABASE_URL   = "https://ektychwtekgekblxtmnx.supabase.co";
const char* SUPABASE_KEY   = "COLA_AQUI_A_SERVICE_ROLE_KEY";

// UUID do utente (Supabase > Table Editor > patients > coluna id)
const char* PATIENT_ID     = "COLA_AQUI_O_UUID_DO_UTENTE";
// ─────────────────────────────────────────────────────────────

// ── Pinos ────────────────────────────────────────────────────
#define I2C_SDA  6
#define I2C_SCL  7
#define MIC_A0   2
#define MIC_D0   3

// ── OLED ─────────────────────────────────────────────────────
#define OLED_WIDTH  128
#define OLED_HEIGHT  64
#define OLED_ADDR   0x3C

// ── Thresholds ───────────────────────────────────────────────
#define JOLT_THRESHOLD        2.2f
#define FREE_FALL_THRESHOLD   0.5f
#define FREE_FALL_MIN_MS      30
#define IMPACT_THRESHOLD      1.3f
#define GYRO_FALL_THRESHOLD   300.0f
#define STILLNESS_BAND        0.08f
#define STILLNESS_MS          5000
#define SOUND_SPIKE           200
#define SOUND_WINDOW_MS       8000
#define GREEN_COOLDOWN_MS     5000
#define RED_COOLDOWN_MS       15000

// ── Polling ──────────────────────────────────────────────────
#define IMU_INTERVAL_MS      10
#define MIC_INTERVAL_MS      10
#define DISPLAY_INTERVAL_MS  100
#define SERIAL_INTERVAL_MS   200

// ── Estado ───────────────────────────────────────────────────
enum AlertState { IDLE, GREEN_ALERT, WAITING_STILLNESS, WAITING_SOUND, RED_ALERT };
AlertState alertState     = IDLE;
AlertState lastSentState  = IDLE;
uint32_t   stateStart     = 0;
bool       inFreeFall     = false;
uint32_t   freeFallStart  = 0;
uint32_t   stillStart     = 0;
bool       soundDetected  = false;

// ── Sensores ─────────────────────────────────────────────────
MPU6050          mpu;
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);

float   accelMag    = 1.0f;
float   gyroMag     = 0.0f;
float   micBaseline = 2048.0f;
int     micCurrent  = 0;
bool    micActive   = false;

// ── Timing ───────────────────────────────────────────────────
uint32_t lastImuMs = 0, lastMicMs = 0, lastDisplayMs = 0, lastSerialMs = 0;

// ── Wi-Fi helper ─────────────────────────────────────────────
void connectWifi() {
  Serial.printf("A ligar a '%s'...", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries < 40) {
    delay(500); Serial.print("."); tries++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[OK] Wi-Fi ligado — IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[AVISO] Wi-Fi falhou — a continuar sem rede.");
  }
}

// ── Enviar evento para Supabase ──────────────────────────────
void sendEvent(AlertState state, bool fallDetected) {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect(); delay(2000);
    if (WiFi.status() != WL_CONNECTED) return;
  }

  const char* stateStr = "IDLE";
  switch (state) {
    case GREEN_ALERT:       stateStr = "GREEN_ALERT";       break;
    case WAITING_STILLNESS: stateStr = "WAITING_STILLNESS"; break;
    case WAITING_SOUND:     stateStr = "WAITING_SOUND";     break;
    case RED_ALERT:         stateStr = "RED_ALERT";         break;
    default:                stateStr = "IDLE";              break;
  }

  StaticJsonDocument<256> doc;
  doc["patient_id"]   = PATIENT_ID;
  doc["alert_state"]  = stateStr;
  doc["accel_mag"]    = accelMag;
  doc["gyro_mag"]     = gyroMag;
  doc["mic_active"]   = micActive;
  doc["fall_detected"]= fallDetected;

  String body;
  serializeJson(doc, body);

  HTTPClient http;
  http.begin(String(SUPABASE_URL) + "/rest/v1/events");
  http.addHeader("Content-Type",  "application/json");
  http.addHeader("apikey",        SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Prefer",        "return=minimal");

  int code = http.POST(body);
  if (code == 201) {
    Serial.printf("[WIFI] Enviado: %s\n", stateStr);
  } else {
    Serial.printf("[WIFI] Erro %d: %s\n", code, http.getString().c_str());
  }
  http.end();
}

// =============================================================================
void setup() {
  Serial.begin(115200);
  uint32_t t = millis();
  while (!Serial && millis() - t < 3000) delay(10);
  delay(300);

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);
  pinMode(MIC_D0, INPUT);

  // OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("SSD1306 not found!"); while (true) delay(1000);
  }
  display.clearDisplay();
  display.setTextColor(WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("VitalGuard");
  display.println("A iniciar...");
  display.display();

  // MPU-6050
  Wire.beginTransmission(0x68); Wire.write(0x6B); Wire.write(0x00); Wire.endTransmission();
  delay(100);
  mpu.initialize();
  if (!mpu.testConnection()) {
    Serial.println("MPU-6050 nao encontrado.");
    display.clearDisplay(); display.setCursor(0,0);
    display.println("MPU-6050"); display.println("nao encontrado!"); display.display();
    while (true) delay(1000);
  }
  mpu.setFullScaleAccelRange(MPU6050_ACCEL_FS_8);
  mpu.setFullScaleGyroRange(MPU6050_GYRO_FS_500);
  mpu.setDLPFMode(MPU6050_DLPF_BW_20);

  // Wi-Fi
  display.clearDisplay(); display.setCursor(0,0);
  display.println("VitalGuard");
  display.println("Wi-Fi...");
  display.display();
  connectWifi();

  display.clearDisplay(); display.setCursor(0,0);
  display.println("VitalGuard");
  display.println("Pronto.");
  if (WiFi.status() == WL_CONNECTED)
    display.println(WiFi.localIP().toString());
  display.display();
  delay(1500);

  Serial.println("=== VitalGuard pronto ===");
}

// =============================================================================
void loop() {
  uint32_t now = millis();
  if (now - lastImuMs    >= IMU_INTERVAL_MS)     { lastImuMs    = now; readIMU(); }
  if (now - lastMicMs    >= MIC_INTERVAL_MS)     { lastMicMs    = now; readMic(); }
  runAlertLogic(now);
  if (now - lastDisplayMs >= DISPLAY_INTERVAL_MS) { lastDisplayMs = now; drawFrame(now); }
  if (now - lastSerialMs  >= SERIAL_INTERVAL_MS)  { lastSerialMs  = now; printSerial(now); }
}

// =============================================================================
void readIMU() {
  int16_t ax, ay, az, gx, gy, gz;
  mpu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
  float x = ax / 4096.0f, y = ay / 4096.0f, z = az / 4096.0f;
  accelMag = sqrtf(x*x + y*y + z*z);
  float gxDps = gx / 65.54f, gyDps = gy / 65.54f, gzDps = gz / 65.54f;
  gyroMag = sqrtf(gxDps*gxDps + gyDps*gyDps + gzDps*gzDps);
}

// =============================================================================
void readMic() {
  micCurrent  = analogRead(MIC_A0);
  micBaseline = 0.95f * micBaseline + 0.05f * (float)micCurrent;
  micActive   = (micCurrent > (int)(micBaseline + SOUND_SPIKE))
             || (digitalRead(MIC_D0) == HIGH);
}

// =============================================================================
void runAlertLogic(uint32_t now) {
  bool jolt     = (accelMag > JOLT_THRESHOLD);
  bool gyroJolt = (gyroMag  > GYRO_FALL_THRESHOLD);
  bool impact   = false;
  bool fallNow  = false;

  if (!inFreeFall && accelMag < FREE_FALL_THRESHOLD) {
    inFreeFall = true; freeFallStart = now;
  } else if (inFreeFall) {
    if (accelMag >= FREE_FALL_THRESHOLD) {
      if ((now - freeFallStart) >= FREE_FALL_MIN_MS && accelMag > IMPACT_THRESHOLD) {
        impact = true; fallNow = true;
      }
      inFreeFall = false;
    }
  }

  bool anyEvent = jolt || impact || gyroJolt;
  AlertState prevState = alertState;

  switch (alertState) {
    case IDLE:
      if (anyEvent) {
        alertState = GREEN_ALERT; stateStart = now;
        stillStart = 0; soundDetected = false;
        Serial.println(">>> GREEN ALERT");
      }
      break;

    case GREEN_ALERT: {
      float dev = fabsf(accelMag - 1.0f);
      if (dev < STILLNESS_BAND) { if (stillStart == 0) stillStart = now; }
      else                      { stillStart = 0; }
      if (stillStart != 0 && (now - stillStart) >= STILLNESS_MS) {
        alertState = IDLE; stillStart = 0;
        Serial.println("GREEN cleared — OK.");
        break;
      }
      if (anyEvent) stateStart = now;
      if ((now - stateStart) >= GREEN_COOLDOWN_MS) {
        alertState = WAITING_STILLNESS; stateStart = now;
        stillStart = 0; soundDetected = false;
        Serial.println("GREEN timeout — watching stillness...");
      }
      break;
    }

    case WAITING_STILLNESS: {
      float dev = fabsf(accelMag - 1.0f);
      if (dev < STILLNESS_BAND) { if (stillStart == 0) stillStart = now; }
      else                      { stillStart = 0; }
      if (stillStart != 0 && (now - stillStart) >= STILLNESS_MS) {
        alertState = WAITING_SOUND; stateStart = now;
        stillStart = 0; soundDetected = false;
        Serial.println("Still 5s — a ouvir...");
      }
      if (anyEvent) {
        alertState = GREEN_ALERT; stateStart = now; stillStart = 0;
        Serial.println("Movimento — de volta a GREEN.");
      }
      break;
    }

    case WAITING_SOUND:
      if (micActive) soundDetected = true;
      if ((now - stateStart) >= SOUND_WINDOW_MS) {
        if (!soundDetected) {
          alertState = RED_ALERT; stateStart = now;
          Serial.println(">>> RED ALERT — sem resposta!");
        } else {
          alertState = IDLE;
          Serial.println("Som detectado — CLEARED.");
        }
      }
      break;

    case RED_ALERT:
      if ((now - stateStart) >= RED_COOLDOWN_MS) {
        alertState = IDLE;
        Serial.println("RED cleared.");
      }
      break;
  }

  // Enviar para Supabase só quando o estado muda (ou ocorre queda)
  if (alertState != prevState || fallNow) {
    sendEvent(alertState, fallNow);
  }
}

// =============================================================================
void printSerial(uint32_t now) {
  Serial.print("Acc:"); Serial.print(accelMag, 3); Serial.print("g");
  Serial.print(" Gyro:"); Serial.print(gyroMag, 1); Serial.print("dps");
  Serial.print(" Mic:"); Serial.print(micActive ? "SOUND" : "quiet");
  Serial.print(" | ");
  switch (alertState) {
    case IDLE:              Serial.println("IDLE"); break;
    case GREEN_ALERT:       Serial.println("GREEN ALERT"); break;
    case WAITING_STILLNESS: Serial.println("Watching stillness..."); break;
    case WAITING_SOUND: {
      uint32_t r = SOUND_WINDOW_MS - (now - stateStart);
      Serial.print("Listening... "); Serial.print(r/1000); Serial.println("s"); break;
    }
    case RED_ALERT:         Serial.println("*** RED ALERT ***"); break;
  }
}

// =============================================================================
void drawFrame(uint32_t now) {
  display.clearDisplay();
  switch (alertState) {
    case IDLE:
    case WAITING_STILLNESS: {
      display.setTextSize(1); display.setCursor(0, 0);
      display.println(alertState == IDLE ? "MONITORING" : "WATCHING...");
      display.drawFastHLine(0, 10, OLED_WIDTH, WHITE);
      display.setCursor(0, 14);
      display.print("Acc:"); display.print(accelMag, 2); display.print("g");
      display.setCursor(0, 24);
      display.print("Gyro:"); display.print((int)gyroMag); display.print("dps");
      display.setCursor(0, 34);
      display.print("Mic:"); display.print(micActive ? "SOUND" : "quiet");
      display.setCursor(0, 44);
      display.print("WiFi:"); display.print(WiFi.status() == WL_CONNECTED ? "OK" : "OFF");
      if (alertState == WAITING_STILLNESS && stillStart != 0) {
        int barW = constrain((int)((float)(now - stillStart) / (float)STILLNESS_MS * 112.0f), 0, 112);
        display.drawRect(0, 56, 112, 7, WHITE);
        display.fillRect(0, 56, barW, 7, WHITE);
      }
      break;
    }
    case GREEN_ALERT:
    case WAITING_SOUND: {
      display.fillRect(0, 0, OLED_WIDTH, 36, WHITE);
      display.setTextColor(BLACK); display.setTextSize(2);
      display.setCursor(8, 2); display.print("GREEN");
      display.setTextSize(1); display.setCursor(4, 22); display.print("Movimento!");
      display.setTextColor(WHITE); display.setTextSize(1);
      display.setCursor(0, 40);
      display.print("A:"); display.print(accelMag, 2); display.print("g ");
      display.print("G:"); display.print((int)gyroMag); display.print("d");
      display.setCursor(0, 52);
      if (alertState == WAITING_SOUND) {
        uint32_t rem = SOUND_WINDOW_MS - (now - stateStart);
        display.print("Ouvir "); display.print(rem/1000); display.print("s | ");
        display.print(micActive ? "SOM OK" : "silencio");
      } else {
        display.print("Mic:"); display.print(micActive ? "SOM" : "silencio");
      }
      break;
    }
    case RED_ALERT: {
      display.fillRect(0, 0, OLED_WIDTH, OLED_HEIGHT, WHITE);
      display.setTextColor(BLACK); display.setTextSize(2);
      display.setCursor(22, 6);  display.print("RED");
      display.setCursor(14, 26); display.print("ALERT!");
      display.setTextSize(1); display.setCursor(8, 50); display.print("Sem resposta!");
      break;
    }
  }
  display.display();
}
