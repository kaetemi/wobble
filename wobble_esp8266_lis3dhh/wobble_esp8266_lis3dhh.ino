/*
Copyright (C) 2020  Jan BOON (Kaetemi) <jan.boon@kaetemi.be>
All rights reserved.
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.
THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/*
 * Wobble.
 * IMPORTANT:
 * - Set lwIP Variant to "v2 Higher Bandwidth"
 * - Builtin Led: "2"
 */

#define SENSOR_LIS3DHH 1
#define SENSOR_MPU6050 2

#define SENSOR SENSOR_LIS3DHH

#if (SENSOR == SENSOR_LIS3DHH)
#define CS_PIN 15 // Wemos D1 mini, NodeMCU ESP-12E
#elif (SENSOR == SENSOR_MPU6050)
#define SCL_PIN D6
#define SDA_PIN D7
#endif

#define INT1_PIN 5
#define INT2_PIN 4

#define OPT_FIFO_EN 1
#define AUXIL_SENSOR_EN 1

// Boards Manager URLs:
// https://dl.espressif.com/dl/package_esp32_index.json (esp32)
// https://arduino.esp8266.com/stable/package_esp8266com_index.json (esp8266)

// Dependencies:
// https://github.com/Links2004/arduinoWebSockets
// https://github.com/arduino-libraries/NTPClient
// https://github.com/yoursunny/PriUint64/
// https://techtutorialsx.com/2018/10/19/esp32-esp8266-arduino-protocol-buffers/

// References:
// https://www.instructables.com/id/Wemos-ESP8266-Getting-Started-Guide-Wemos-101/
// http://shawnhymel.com/1675/arduino-websocket-server-using-an-esp32/
// https://techtutorialsx.com/2018/10/19/esp32-esp8266-arduino-protocol-buffers/
// https://www.dfrobot.com/blog-1161.html
// https://www.dfrobot.com/blog-1177.html
// https://randomnerdtutorials.com/esp32-ntp-client-date-time-arduino-ide/
// https://in.uninett.no/ntp-clock-synch-accuracy-its-time-for-microseconds/
// https://lastminuteengineers.com/handling-esp32-gpio-interrupts-tutorial/
// https://esp32.com/viewtopic.php?t=9289
// https://www.circuito.io/app?components=513,360217,1671987
// https://github.com/stm32duino/LIS3DHH/blob/master/src/lis3dhh_reg.h
// https://www.st.com/content/ccc/resource/technical/document/application_note/group0/b5/5a/15/58/aa/82/44/e8/DM00477046/files/DM00477046.pdf/jcr:content/translations/en.DM00477046.pdf
// https://www.reddit.com/r/esp8266/comments/ausw32/turn_off_built_in_blue_led_wemos_d1_mini/
// https://www.arduino.cc/reference/en/language/functions/external-interrupts/attachinterrupt/
// https://forum.arduino.cc/index.php?topic=616264.0
// https://arduino.stackexchange.com/questions/51893/how-to-rebuild-arduino-core-for-esp8266

#ifdef ESP32
#include <esp32-hal-cpu.h>
#endif
#include <Arduino.h>
#include <Udp.h>
#include <PriUint64.h>

#ifdef ESP8266
#include <ESP8266WiFi.h>
#else
#include <WiFi.h>
#endif
#include <WiFiUDP.h>

#define private public
#include <NTPClient.h>
#undef private
#include <WebSocketsClient.h>
#include <pb_common.h>
#include <pb.h>
#include <pb_encode.h>

#if (SENSOR == SENSOR_LIS3DHH)
#include <SPI.h>
#define private public
#include <LIS3DHHSensor.h>
#undef private
#elif (SENSOR == SENSOR_MPU6050)
#include <Wire.h>
#endif

#include "wobble_protocol.pb.h"
#include "wifi_setup.h"

bool clockedUp = false;
bool connectingWiFi = false;
bool timeConnected = false;
bool timeReady = false;

WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP); // ntpUDP, "europe.pool.ntp.org", 3600, 60000

WebSocketsClient webSocket;

#if (SENSOR == SENSOR_LIS3DHH)
LIS3DHHSensor *sensor;
#endif

#if (SENSOR == SENSOR_MPU6050)

// MPU6050 Slave Device Address
const uint8_t MPU6050_SLAVE_ADDRESS = 0x68;

// MPU6050 Configuration Register Addresses
const uint8_t MPU6050_REGISTER_SMPLRT_DIV   =  0x19;
const uint8_t MPU6050_REGISTER_USER_CTRL    =  0x6A;
const uint8_t MPU6050_REGISTER_PWR_MGMT_1   =  0x6B;
const uint8_t MPU6050_REGISTER_PWR_MGMT_2   =  0x6C;
const uint8_t MPU6050_REGISTER_CONFIG       =  0x1A;
const uint8_t MPU6050_REGISTER_GYRO_CONFIG  =  0x1B;
const uint8_t MPU6050_REGISTER_ACCEL_CONFIG =  0x1C;
const uint8_t MPU6050_REGISTER_FIFO_EN      =  0x23;
const uint8_t MPU6050_REGISTER_INT_ENABLE   =  0x38;
const uint8_t MPU6050_REGISTER_ACCEL_XOUT_H =  0x3B;
const uint8_t MPU6050_REGISTER_SIGNAL_PATH_RESET = 0x68;

#endif

const unsigned long ntpRefresh = 4 * 60000;
unsigned long ntpLast = 0;
bool refreshNtp = false;
bool checkDrift = false;
bool checkSampleDrift = false;

int32_t ntpCountdown = 0;
unsigned long microsLast;
int64_t ntpOffset;

bool webSocketProblem = false;
bool webSocketConnected = false;
bool webSocketConnecting = false;
int32_t safeTimeout = 10;

/*
const int testStreamAlias = 1;
bool testStreamOpen = false;
bool testStreamProblem = false;
int64_t lastTestStreamTimestamp = 0;
int32_t samplesSent = 0;
*/

bool sensorChecked = false;

#define ACCEL_BUFFER_SZ 4096
#define ACCEL_BUFFER_MASK (ACCEL_BUFFER_SZ - 1)
#if (SENSOR == SENSOR_LIS3DHH)
#define ACCEL_SAMPLE_BLOCK 55
#elif (SENSOR == SENSOR_MPU6050)
#define ACCEL_SAMPLE_BLOCK 50
#endif
const int accelStreamAlias = 2;
bool accelStreamOpen = false;
bool accelStreamProblem = false;
bool accelFifoOverflow = false;
int16_t accelX[ACCEL_BUFFER_SZ], accelY[ACCEL_BUFFER_SZ], accelZ[ACCEL_BUFFER_SZ];
int16_t accelRd = 0, accelWr = 0;
int16_t accelRefWr = 0;
int64_t accelRefTs = 0, accelNextTs = 0;
int32_t accelRefReads = 0, accelNextReads = 0;
int32_t accelReads = 0;
int32_t accelSamplesSent = 0;
#if (SENSOR == SENSOR_LIS3DHH)
int32_t accelFreq = 1100; // auto adjust by drift
#elif (SENSOR == SENSOR_MPU6050)
#if OPT_FIFO_EN
int32_t accelFreq = 1000; // auto adjust by drift
#else
int32_t accelFreq = 250; // auto adjust by drift
#endif
#endif
int64_t accelOpenTs = 0;
int32_t accelOpenReads = 0;
os_timer_t accelTimer;

#if AUXIL_SENSOR_EN
#if (SENSOR == SENSOR_LIS3DHH)
// 50 samples per second, send twice a second, 10 seconds buffer
#define AUXIL_BUFFER_SZ 512
#define AUXIL_SAMPLE_BLOCK 25
#define AUXIL_TIMER_INTERVAL (1000 / 50)
#elif (SENSOR == SENSOR_MPU6050)
// 10 samples per second, four buffers, send once a second, 10 seconds buffer
#define AUXIL_BUFFER_SZ 128
#define AUXIL_SAMPLE_BLOCK 10
#define AUXIL_TIMER_INTERVAL (1000 / 10)
#endif
#define AUXIL_BUFFER_MASK (AUXIL_BUFFER_SZ - 1)
const int auxilStreamAlias = 3;
bool auxilStreamOpen = false;
bool auxilStreamProblem = false;
#if (SENSOR == SENSOR_LIS3DHH)
int16_t auxil[AUXIL_BUFFER_SZ];
#elif (SENSOR == SENSOR_MPU6050)
int16_t auxilTemp[AUXIL_BUFFER_SZ];
int16_t auxilGyroX[AUXIL_BUFFER_SZ], auxilGyroY[AUXIL_BUFFER_SZ], auxilGyroZ[AUXIL_BUFFER_SZ];
#endif
int64_t auxilRd = 0, auxilWr = 0;
os_timer_t auxilTimer;
#endif

void delaySafe(int32_t maxTimeout = 1000) {
  delay(safeTimeout);
  if (safeTimeout < maxTimeout) {
    safeTimeout *= 2;
  }
}

void delayReset() {
  safeTimeout = 10;
}

union {
  OpenStream openStream;
  CloseStream closeStream;
  WriteFrame writeFrame;
} messages;

struct {
  uint8_t hdr[WEBSOCKETS_MAX_HEADER_SIZE];
  union {
    uint8_t any[1];
    uint8_t openStream[OpenStream_size];
    uint8_t closeStream[CloseStream_size];
    uint8_t writeFrame[WriteFrame_size];
  } frame;
} buffers;

void setup() {
  Serial.begin(115200);
  delay(10);
  
  Serial.println();
  Serial.println();
  Serial.println("Wobble!");
#ifdef ESP32
  Serial.print("Clock: ");
  Serial.println(getCpuFrequencyMhz());
  /* if (getCpuFrequencyMhz() >= 240) {
    clockedUp = true;
  } */
#endif

  pinMode(INT1_PIN, INPUT);
  pinMode(INT2_PIN, INPUT);
  
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW); // Turn on LED

#if (SENSOR == SENSOR_LIS3DHH)
  SPI.begin();
  // SPI.setFrequency(1000000);
  sensor = new LIS3DHHSensor(&SPI, CS_PIN);
#elif (SENSOR == SENSOR_MPU6050)
  Wire.begin(SDA_PIN, SCL_PIN);
#endif
}

void clockDown() {
#ifdef ESP32
  if (clockedUp) {
    setCpuFrequencyMhz(80); // 80, 160, 240
    clockedUp = false;
    Serial.print("Clock: ");
    Serial.println(getCpuFrequencyMhz());
  }
#endif
}

void clockUp() {
#ifdef ESP32
  if (!clockedUp) { // Throttling between 80 and 240 seems to drop the WiFi more frequently
    setCpuFrequencyMhz(160); // 80, 160, 240
    clockedUp = true;
    Serial.print("Clock: ");
    Serial.println(getCpuFrequencyMhz());
  }
#endif
}

int64_t ICACHE_RAM_ATTR currentTimestamp() {
  const unsigned long currentMicros = micros();
  const unsigned long deltaMicros = currentMicros - microsLast;
  ntpOffset += deltaMicros;
  microsLast = currentMicros;
  return ntpOffset;
}

int64_t ICACHE_RAM_ATTR currentTimestampNoAdj() {
  const unsigned long currentMicros = micros();
  const unsigned long deltaMicros = currentMicros - microsLast;
  return ntpOffset + deltaMicros;
}

int64_t getEpochTimeMillis() {
  return ((int64_t)timeClient._timeOffset * 1000)
    + ((int64_t)timeClient._currentEpoc * 1000)
    + (int64_t)millis() - (int64_t)timeClient._lastUpdate;
}

void printWiFiStatus() {
  switch (WiFi.status()) {
    case WL_NO_SHIELD:
      Serial.println("WL_NO_SHIELD");
      break;
    case WL_IDLE_STATUS:
      Serial.println("WL_IDLE_STATUS");
      break;
    case WL_NO_SSID_AVAIL:
      Serial.println("WL_NO_SSID_AVAIL");
      break;
    case WL_SCAN_COMPLETED:
      Serial.println("WL_SCAN_COMPLETED");
      break;
    case WL_CONNECTED:
      Serial.println("WL_CONNECTED");
      break;
    case WL_CONNECT_FAILED:
      Serial.println("WL_CONNECT_FAILED");
      break;
    case WL_CONNECTION_LOST:
      Serial.println("WL_CONNECTION_LOST");
      break;
    case WL_DISCONNECTED:
      Serial.println("WL_DISCONNECTED");
      break;
  }
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("WStype_DISCONNECTED");
      clockDown();
      webSocketProblem = false;
      webSocketConnected = false;
      webSocketConnecting = false;
      if (safeTimeout < 1000) {
        safeTimeout *= 2;
      }
      break;
    case WStype_CONNECTED:
      Serial.println();
      Serial.println("WStype_CONNECTED");
      webSocketConnected = true;
      break;
    case WStype_TEXT:
      Serial.println("WStype_TEXT");
      break;
    case WStype_BIN:
      Serial.println("WStype_BIN");
      break;
    case WStype_ERROR:
      Serial.println("WStype_ERROR");
      webSocketProblem = true;
      if (safeTimeout < 1000) {
        safeTimeout *= 2;
      }
      break;   
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_FRAGMENT_FIN:
      break;
  }
}

#if (SENSOR == SENSOR_MPU6050)

void writeRegister(uint8_t deviceAddress, uint8_t regAddress, uint8_t data){
  Wire.beginTransmission(deviceAddress);
  Wire.write(regAddress);
  Wire.write(data);
  Wire.endTransmission();
}

#endif

void accelReset() {
  accelRd = 0;
  accelWr = 0;
  accelRefWr = 0;
  accelRefTs = 0;
  accelRefReads = 0;
}

// Called from timer
void ICACHE_RAM_ATTR accelPushValue(int16_t x, int16_t y, int16_t z, int i) {
  // if (!accelStreamOpen) return;
  if (accelStreamProblem) {
    // Serial.println("DEBUG: accelPushValue accelStreamProblem");
    return;
  }
  int16_t rd = accelRd, wr = accelWr;
  int16_t space = (ACCEL_BUFFER_SZ - wr + rd - 1) & ACCEL_BUFFER_MASK;
  if (!space) {
    Serial.println("Accelerometer buffer out of space");
    accelStreamProblem = true;
    // System will restart stream & clear buffer
    return;
  }
  accelX[wr] = x;
  accelY[wr] = y;
  accelZ[wr] = z;
  /*
  Serial.print("X: ");
  Serial.print(x);
  Serial.print(", Y: ");
  Serial.print(y);
  Serial.print(", Z: ");
  Serial.println(z);
  */
  int64_t ts = accelNextTs;
  if (i == 0 && ts) {
    // This is the first read in this fifo batch,
    // the last stored timestamp is good to use!
    // Store the next batch timestamp when done processing this fifo.
    accelRefWr = wr;
    accelRefTs = ts;
    accelRefReads = accelNextReads;
    accelNextTs = 0;
    // Serial.println(PriUint64<DEC>(accelRefTs));
    if (!accelStreamOpen) {
      accelRd = wr; // Skip ahead
    }
  }
  accelWr = (wr + 1) & ACCEL_BUFFER_MASK;
}

bool accelOpenOrPublish(int count) {
  if (accelStreamProblem) return false;
  int16_t rd = accelRd, wr = accelWr;
  if (accelStreamOpen) {
    int16_t space = (ACCEL_BUFFER_SZ - wr + rd - 1) & ACCEL_BUFFER_MASK;
    int16_t written = ACCEL_BUFFER_SZ - space;
    return written >= count;
  } else {
    int64_t refTs = accelRefTs;
    int16_t refWr = accelRefWr;
    int16_t space = (ACCEL_BUFFER_SZ - wr + rd - 1) & ACCEL_BUFFER_MASK;
    int16_t written = ACCEL_BUFFER_SZ - space;
    int16_t refOff = (refWr - rd) & ACCEL_BUFFER_MASK;
    // Serial.println(refOff);
    // Serial.println(written);
    // Serial.println(PriUint64<DEC>(refTs));
    delaySafe();
    return (refOff < written) && refTs;
  }
}

// Called from main function
bool accelReadValues(int32_t *x, int32_t *y, int32_t *z, int count, int64_t *timestamp = NULL, int32_t *reads = NULL) {
  // if (!accelStreamOpen) return false;
  if (accelStreamProblem) return false;
  // Only set timestamp if a timestamp is wanted
  // A timestamp is only needed for opening the stream
  int16_t rd = accelRd, wr = accelWr;
  int64_t refTs = accelRefTs;
  int16_t refWr = accelRefWr;
  int16_t space = (ACCEL_BUFFER_SZ - wr + rd - 1) & ACCEL_BUFFER_MASK;
  int16_t written = ACCEL_BUFFER_SZ - space;
  int16_t refOff = (refWr - rd) & ACCEL_BUFFER_MASK;
  if (timestamp) {
    if (refOff >= written || !refTs) {
      // Don't have a valid timestamp currently
      return false;
    }
    *timestamp = refTs;
    if (reads) {
      *reads = accelRefReads;
    }
  }
  if (count >= written) {
    // Don't have enough values currently
    return false;
  }
  for (int i = 0; i < count; ++i) {
    int rdi = (rd + i) & ACCEL_BUFFER_MASK;
    x[i] = accelX[rdi];
    y[i] = accelY[rdi];
    z[i] = accelZ[rdi];
  }
  accelRd = (rd + count) & ACCEL_BUFFER_MASK;
  return true;
}

bool accelBackoutRead(int count) {
  // Attempt to back out of a read when sending fails
  if (accelStreamProblem) return false;
  int16_t rd = accelRd, wr = accelWr;
  int16_t space = (ACCEL_BUFFER_SZ - wr + rd - 1) & ACCEL_BUFFER_MASK;
  if (space < count) {
    return false;
  }
  accelRd = (rd - count) & ACCEL_BUFFER_MASK;
  return true;
}

void ICACHE_RAM_ATTR accelRead(void *) {
  int64_t nextTs = currentTimestamp();
  int32_t nextReads = accelReads;
#if (SENSOR == SENSOR_LIS3DHH)
  LIS3DHHStatusTypeDef res;
  lis3dhh_reg_t reg;
  reg.byte = 0;
  res = sensor->ReadReg(LIS3DHH_FIFO_SRC, &reg.byte);
  if (res != LIS3DHH_STATUS_OK) {
    accelStreamProblem = true;
    accelNextTs = 0;
    return;
  }
  if (reg.fifo_src.ovrn) {
    Serial.println("Accelerometer FIFO Overrun");
    accelStreamProblem = true;
    accelFifoOverflow = true;
  }
  for (int i = 0; i < reg.fifo_src.fss; ++i) {
      int16_t sample[3];
      res = sensor->Get_X_AxesRaw(sample);
      accelPushValue(sample[0], sample[1], sample[2], i);
      if (accelReads % 1100 == 0) {
        if (accelStreamOpen) {
          digitalWrite(LED_BUILTIN, LOW); // Turn on LED
        }
      } else if (accelReads % 1100 == 55) {
        digitalWrite(LED_BUILTIN, HIGH); // Turn off LED
      }
      ++accelReads;
      if (res != LIS3DHH_STATUS_OK) {
        accelStreamProblem = true;
        accelNextTs = 0;
        return;
      }
  }
#elif (SENSOR == SENSOR_MPU6050)
#if OPT_FIFO_EN
  // TODO: MPU6050
#else
  Wire.beginTransmission(MPU6050_SLAVE_ADDRESS);
  Wire.write(MPU6050_REGISTER_ACCEL_XOUT_H);
  Wire.endTransmission();
  Wire.requestFrom(MPU6050_SLAVE_ADDRESS, (uint8_t)6); // Up to 14 to add temp and gyro
  int16_t accelX = ((int16_t)Wire.read() << 8) | Wire.read();
  int16_t accelY = ((int16_t)Wire.read() << 8) | Wire.read();
  int16_t accelZ = ((int16_t)Wire.read() << 8) | Wire.read();
  accelPushValue(accelX, accelY, accelZ, 0);
  if (accelReads % 250 == 0) {
    if (accelStreamOpen) {
      digitalWrite(LED_BUILTIN, LOW); // Turn on LED
    }
  } else if (accelReads % 250 == 10) {
    digitalWrite(LED_BUILTIN, HIGH); // Turn off LED
  }
  ++accelReads;
#endif
#endif
  accelNextTs = nextTs;
  accelNextReads = nextReads;
}

#if AUXIL_SENSOR_EN
void auxilReset() {
  auxilRd = 0;
  auxilWr = 0;
}

bool auxilOpenOrPublish(int count) {
  if (auxilStreamProblem) return false;
  int16_t rd = auxilRd, wr = auxilWr;
  int16_t space = (AUXIL_BUFFER_SZ - wr + rd - 1) & AUXIL_BUFFER_MASK;
  int16_t written = AUXIL_BUFFER_SZ - space;
  if (auxilStreamOpen) {
    return written >= count;
  } else {
    return written > 0;
  }
}

#if (SENSOR == SENSOR_LIS3DHH)
void ICACHE_RAM_ATTR auxilPushValue(int16_t temp) {
#elif (SENSOR == SENSOR_MPU6050)
void ICACHE_RAM_ATTR auxilPushValue(int16_t temp, int16_t gyroX, int16_t gyroY, int16_t gyroZ) {
#endif
  if (auxilStreamProblem) return;
  int16_t rd = auxilRd, wr = auxilWr;
  int16_t space = (AUXIL_BUFFER_SZ - wr + rd - 1) & AUXIL_BUFFER_MASK;
  if (!space) {
    Serial.println("Temperature buffer out of space");
    auxilStreamProblem = true;
    // System will restart stream & clear buffer
    return;
  }
#if (SENSOR == SENSOR_LIS3DHH)
  auxil[wr] = temp;
#elif (SENSOR == SENSOR_MPU6050)
  auxilTemp[wr] = temp;
  auxilGyroX[wr] = gyroX;
  auxilGyroY[wr] = gyroY;
  auxilGyroZ[wr] = gyroZ;
#endif
  auxilWr = (wr + 1) & AUXIL_BUFFER_MASK;
}

#if (SENSOR == SENSOR_LIS3DHH)
bool ICACHE_RAM_ATTR auxilReadValues(int32_t *temp, int count, int64_t *timestamp = NULL) {
#elif (SENSOR == SENSOR_MPU6050)
bool ICACHE_RAM_ATTR auxilReadValues(int32_t *temp, int32_t *gyroX, int32_t *gyroY, int32_t *gyroZ, int count, int64_t *timestamp = NULL) {
#endif
  if (auxilStreamProblem) return false;
  int16_t rd = auxilRd, wr = auxilWr;
  int16_t space = (AUXIL_BUFFER_SZ - wr + rd - 1) & AUXIL_BUFFER_MASK;
  int16_t written = AUXIL_BUFFER_SZ - space;
  if (timestamp && written > 0) {
    // Timestamping for temperature should match system clock, since it's sampled by the timer
    // Temperature sampling may have aliasing due to not matching the native sampling rate
    // Simply calculate the past timestamp
    *timestamp = currentTimestamp() - (AUXIL_TIMER_INTERVAL * 1000 * written);
  }
  if (count >= written) {
    // Don't have enough values currently
    return false;
  }
  for (int i = 0; i < count; ++i) {
    int rdi = (rd + i) & AUXIL_BUFFER_MASK;
#if (SENSOR == SENSOR_LIS3DHH)
    temp[i] = auxil[rdi];
#elif (SENSOR == SENSOR_MPU6050)
    temp[i] = auxilTemp[rdi];
    gyroX[i] = auxilGyroX[rdi];
    gyroY[i] = auxilGyroY[rdi];
    gyroZ[i] = auxilGyroZ[rdi];
#endif
  }
  auxilRd = (rd + count) & AUXIL_BUFFER_MASK;
  return true;
}

void ICACHE_RAM_ATTR auxilRead(void *) {
#if (SENSOR == SENSOR_LIS3DHH)
  int32_t res;
  axis1bit16_t buf;
  res = lis3dhh_temperature_raw_get(&sensor->reg_ctx, buf.u8bit);
  if (res) {
    auxilStreamProblem = true;
    return;
  }
  auxilPushValue(buf.i16bit >> 4);
#elif (SENSOR == SENSOR_MPU6050)
  // TODO: MPU6050
  /*// read all 14 register
void Read_RawValue(uint8_t deviceAddress, uint8_t regAddress){
  Wire.beginTransmission(deviceAddress);
  Wire.write(regAddress);
  Wire.endTransmission();
  Wire.requestFrom(deviceAddress, (uint8_t)14);
  AccelX = (((int16_t)Wire.read()<<8) | Wire.read());
  AccelY = (((int16_t)Wire.read()<<8) | Wire.read());
  AccelZ = (((int16_t)Wire.read()<<8) | Wire.read());
  Temperature = (((int16_t)Wire.read()<<8) | Wire.read());
  GyroX = (((int16_t)Wire.read()<<8) | Wire.read());
  GyroY = (((int16_t)Wire.read()<<8) | Wire.read());
  GyroZ = (((int16_t)Wire.read()<<8) | Wire.read());
}*/
  // auxilPushValue(temp, gyroX, gyroY, gyroZ)
#endif
}
#endif

void loop() {
  // Might actually move this whole thing into the accelerometer interrupt handler..
  // So the accelerometer interrupt will just push everything into FIFO that can cache about 2s of data
  // Here we swap and take from that array when it's full-ish
  
  // Routine to keep the WiFi going
  if (WiFi.status() != WL_CONNECTED) {
    if (connectingWiFi) {
      // Waiting to be connected
      delaySafe();
      Serial.print("W");
      return;
    }
    
    Serial.println();
    clockUp();
    // Serial.println(WiFi.status()); // 5 = WL_CONNECTION_LOST, 255 = WL_NO_SHIELD
    printWiFiStatus();
    WiFi.mode(WIFI_STA); // Disable AP
    Serial.print("Connecting to ");
    Serial.println(ssid);

    // Connect
    if (webSocketConnected) {
      // Close websocket
      webSocket.disconnect();
      webSocketConnected = false;
      webSocketConnecting = false;
    }
    if (timeConnected) {
      // Close time
      timeClient.end();
      timeConnected = false;
    }
    char ssidc[128];
    strcpy(ssidc, ssid);
    WiFi.begin(ssidc, password);
    connectingWiFi = true;
    return;
  }
  if (connectingWiFi) {
    connectingWiFi = false;

    // We are connected
    Serial.println("");
    printWiFiStatus();
    Serial.println("WiFi connected");
    Serial.println("IP address: ");
    Serial.println(WiFi.localIP());
    Serial.print("TCP_SND_BUF: ");
    Serial.println(TCP_SND_BUF);
    delayReset();
  }

  // Routine to bring up the NTP
  if (!timeConnected) {
    // Start up time client
    clockUp();
    timeClient.begin();
    timeConnected = true;
    timeReady = false;
    refreshNtp = true;
  }
  unsigned long ntpPassed = millis() - ntpLast;
  if (refreshNtp || ntpPassed >= ntpRefresh) {
    // Refresh NTP
    clockUp();
    if (!refreshNtp) {
      // Serial.println("Update NTP");
    }
    // Serial.print("Passed: ");
    // Serial.println(ntpPassed);
    if (!timeClient.forceUpdate()) { // Need to do the refresh timing manually since we throttle the clock
      Serial.print("T");
      // timeReady = false;
      refreshNtp = true;
      delaySafe();
      return;
    }
    ntpLast = millis();
    Serial.println("NTP Updated");
    refreshNtp = false;
    checkDrift = true;
    checkSampleDrift = true;
    delayReset();
  }
  if (!timeReady) {
    // Time is ready now, realign timestamp with NTP
    clockUp();
    Serial.print("Time: ");
    Serial.println(timeClient.getFormattedTime());
    Serial.print("Epoch: ");
    Serial.println(timeClient.getEpochTime());
    microsLast = micros();
    ntpOffset = getEpochTimeMillis() * 1000;
    microsLast = (microsLast + (int64_t)micros()) >> 1; // Average before and after
    Serial.print("Timestamp: ");
    Serial.println(PriUint64<DEC>(currentTimestamp()));
    timeReady = true;
    checkDrift = true;
    checkSampleDrift = true;
  }
  if (checkDrift) {
    // Kick in case of large time drift
    clockUp();
    checkDrift = false;
    int64_t timestamp = currentTimestamp();
    int64_t ntpTimestamp = getEpochTimeMillis() * 1000;
    timestamp = (timestamp + currentTimestamp()) >> 1; // Average before and after
    int64_t timestampDrift = abs(ntpTimestamp - timestamp);
    if (timestampDrift > 1100000) { // Needs to stay within 1.1s drift
      Serial.println("Drift on clock, retime");
      Serial.print("Timestamp: ");
      Serial.println(PriUint64<DEC>(timestamp));
      Serial.print("NTP Timestamp: ");
      Serial.println(PriUint64<DEC>(ntpTimestamp));
      Serial.print("Drift: ");
      Serial.println(PriUint64<DEC>(timestampDrift));
      timeReady = false;
#if AUXIL_SENSOR_EN
      // Close temperature stream, since it follows the system clock
      auxilStreamProblem = true;
#endif
      return;
    }
  }

  // Routine to bring up the web socket
  if (webSocketConnecting) {
    webSocket.loop();
    if (!webSocketConnected) {
      // delaySafe();
      delay(safeTimeout);
      Serial.print("S");
      return;
    }
    Serial.println("Web socket connected");
    Serial.print("WEBSOCKETS_MAX_HEADER_SIZE: ");
    Serial.print((int)buffers.frame.any - (int)buffers.hdr);
    Serial.print(" ("); // Should be WEBSOCKETS_MAX_HEADER_SIZE (14)
    Serial.print(WEBSOCKETS_MAX_HEADER_SIZE);
    Serial.println(")");
    webSocketConnecting = false;
    delayReset();
    // TODO: Flag WS stream to restart from the next timestamp here!
  }
  if (!webSocketConnected) {
    clockUp();
    if (accelStreamOpen) {
      // Close accel stream
      accelStreamOpen = false;
      // accelStreamProblem = false;
      if (sensorChecked) {
        accelReset();
      }
    }
#if AUXIL_SENSOR_EN
    if (auxilStreamOpen) {
      auxilStreamOpen = false;
      if (sensorChecked) {
        auxilReset();
      }
    }
#endif
    webSocket.begin(serverAddress, serverPort, "/", "wobble1");
    webSocket.onEvent(webSocketEvent);
    webSocketConnecting = true;
    Serial.print("Connecting to ws://");
    Serial.print(serverAddress);
    Serial.print(":");
    Serial.println(serverPort);
    return;
  }
  webSocket.loop();
  if (webSocketProblem) {
    clockUp();
    webSocketProblem = false;
    webSocket.disconnect();
    return;
  }
  if (!webSocketConnected) {
    clockUp();
    return;
  }

  // Check sensor
  if (!sensorChecked) {
    clockUp();
    digitalWrite(LED_BUILTIN, HIGH); // Turn off LED
#if (SENSOR == SENSOR_LIS3DHH)
    LIS3DHHStatusTypeDef res;

    // Check ID
    Serial.println();
    Serial.print("Sensor ID: ");
    uint8_t id;
    res = sensor->ReadID(&id);
    Serial.println(id);
    if (res != LIS3DHH_STATUS_OK || id != 17) {
      Serial.println("Not OK!");
      delaySafe();
      return;
    }

    // Write settings
    lis3dhh_reg_t reg;
    // ctrl_reg1, int1_ctrl, int2_ctrl, ctrl_reg4, ctrl_reg5, status, fifo_ctrl, fifo_src

    res = sensor->Disable_X();
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed Disable_X!"); delaySafe(); return; }

    // Enable FIFO
    reg.byte = 0;
    reg.ctrl_reg4.not_used_01 = 1; // Must be 1
    reg.ctrl_reg4.fifo_en = 1; // Enable FIFO
    // dsp = 0 (440Hz bw), st = 0 (235Hz bw)
    res = sensor->WriteReg(LIS3DHH_CTRL_REG4, reg.byte);
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed WriteReg LIS3DHH_CTRL_REG4!"); delaySafe(); return; }

    // Set FIFO options
    reg.byte = 0;
    reg.fifo_ctrl.fth = 24; // 12; // Threshold 12 / 32 fifo samples
    reg.fifo_ctrl.fmode = LIS3DHH_FIFO_MODE;
    res = sensor->WriteReg(LIS3DHH_FIFO_CTRL, reg.byte);
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed WriteReg LIS3DHH_FIFO_CTRL!"); delaySafe(); return; }
    
    // Enable INT1 on FIFO threshold reached
    reg.byte = 0;
    // reg.int1_ctrl.int1_drdy = 1;
    reg.int1_ctrl.int1_fth = 1;
    res = sensor->WriteReg(LIS3DHH_INT1_CTRL, reg.byte);
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed WriteReg LIS3DHH_INT1_CTRL!"); delaySafe(); return; }
    
    // Enable INT2 on FIFO overrun
    reg.byte = 0;
    reg.int2_ctrl.int2_ovr = 1;
    res = sensor->WriteReg(LIS3DHH_INT2_CTRL, reg.byte);
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed WriteReg LIS3DHH_INT2_CTRL!"); delaySafe(); return; }

    // Flush FIFO
    reg.byte = 0;
    res = sensor->ReadReg(LIS3DHH_FIFO_SRC, &reg.byte);
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed ReadReg LIS3DHH_FIFO_SRC!"); delaySafe(); return; }
    Serial.print("FTH: ");
    Serial.println(reg.fifo_src.fth);
    Serial.print("OVRN: ");
    Serial.println(reg.fifo_src.ovrn);
    Serial.print("FSS: ");
    Serial.println(reg.fifo_src.fss);
    for (int i = 0; i < reg.fifo_src.fss; ++i) {
      int16_t sample[3];
      res = sensor->Get_X_AxesRaw(sample);
      Serial.print("X: ");
      Serial.print(sample[0]);
      Serial.print(", Y: ");
      Serial.print(sample[1]);
      Serial.print(", Z: ");
      Serial.println(sample[2]);
    }

    // Attach interrupt and flush FIFO to kick it into effect
    //attachInterrupt(digitalPinToInterrupt(INT1_PIN), accelRead, RISING);
    os_timer_setfn(&accelTimer, accelRead, NULL);
    os_timer_arm(&accelTimer, 4, true);
    // Interrupt with SPI not working reliably
    // Regular call not reliable either due to WiFi!
    
#if AUXIL_SENSOR_EN
    os_timer_setfn(&auxilTimer, auxilRead, NULL);
    os_timer_arm(&auxilTimer, AUXIL_TIMER_INTERVAL, true);
#endif
    
    res = sensor->Enable_X();
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed Enable_X!"); delaySafe(); return; }

    // OK!
    Serial.println("OK!");
    Serial.println();
#elif (SENSOR == SENSOR_MPU6050)
    Serial.println();
    Serial.print("Sensor...");
    
    // TODO: Verify that the sensor is connected!
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_SMPLRT_DIV, 0x07);
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_PWR_MGMT_1, 0x01);
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_PWR_MGMT_2, 0x00);
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_CONFIG, 0x00);
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_GYRO_CONFIG, 0x00);//set +/-250 degree/second full scale
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_ACCEL_CONFIG, 0x00);// set +/- 2g full scale
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_FIFO_EN, 0x00); // TODO: FIFO
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_INT_ENABLE, 0x01);
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_SIGNAL_PATH_RESET, 0x00);
    writeRegister(MPU6050_SLAVE_ADDRESS, MPU6050_REGISTER_USER_CTRL, 0x00);
    
    os_timer_setfn(&accelTimer, accelRead, NULL);
    os_timer_arm(&accelTimer, 4, true);

    // OK!
    Serial.println("OK!");
    Serial.println();
#endif
    sensorChecked = true;
    accelRead(NULL); // Quick first read
  }
  bool wsSent = false;

  if (accelFifoOverflow) {
    clockUp();
    accelReset();
#if (SENSOR == SENSOR_LIS3DHH)
    Serial.println();
    Serial.println("Restart accelerometer FIFO");
    LIS3DHHStatusTypeDef res;
    lis3dhh_reg_t reg;

    // Set FIFO options to LIS3DHH_BYPASS_MODE
    reg.byte = 0;
    reg.fifo_ctrl.fth = 24; // 12; // Threshold 12 / 32 fifo samples
    reg.fifo_ctrl.fmode = LIS3DHH_BYPASS_MODE;
    res = sensor->WriteReg(LIS3DHH_FIFO_CTRL, reg.byte);
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed WriteReg LIS3DHH_FIFO_CTRL!"); delaySafe(); return; }

    // Set FIFO options to LIS3DHH_FIFO_MODE
    reg.byte = 0;
    reg.fifo_ctrl.fth = 24; // 12; // Threshold 12 / 32 fifo samples
    reg.fifo_ctrl.fmode = LIS3DHH_FIFO_MODE;
    res = sensor->WriteReg(LIS3DHH_FIFO_CTRL, reg.byte);
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed WriteReg LIS3DHH_FIFO_CTRL!"); delaySafe(); return; }

    // Flush FIFO
    reg.byte = 0;
    res = sensor->ReadReg(LIS3DHH_FIFO_SRC, &reg.byte);
    if (res != LIS3DHH_STATUS_OK) { Serial.println("Failed ReadReg LIS3DHH_FIFO_SRC!"); delaySafe(); return; }
    Serial.print("FTH: ");
    Serial.println(reg.fifo_src.fth);
    Serial.print("OVRN: ");
    Serial.println(reg.fifo_src.ovrn);
    Serial.print("FSS: ");
    Serial.println(reg.fifo_src.fss);
    for (int i = 0; i < reg.fifo_src.fss; ++i) {
      int16_t sample[3];
      res = sensor->Get_X_AxesRaw(sample);
      Serial.print("X: ");
      Serial.print(sample[0]);
      Serial.print(", Y: ");
      Serial.print(sample[1]);
      Serial.print(", Z: ");
      Serial.println(sample[2]);
    }

    Serial.println();
#elif (SENSOR == SENSOR_MPU6050)
    // TODO: MPU6050
#endif
    accelFifoOverflow = false;
  }

  // Routine to stream accelerometer samples
  if (accelStreamProblem) {
    clockUp();
    accelReset();
    if (accelStreamOpen) {
      Serial.println("Close accelerometer stream");
      messages.closeStream = (CloseStream)CloseStream_init_zero;
      messages.closeStream.message_type = MessageType_CLOSE_STREAM;
      messages.closeStream.alias = accelStreamAlias;
      pb_ostream_t stream = pb_ostream_from_buffer(buffers.frame.any, sizeof(buffers));
      if (!pb_encode(&stream, CloseStream_fields, &messages.closeStream)) {
        Serial.println("Failed to encode CloseStream");
        delaySafe();
        return;
      }
      if (!webSocket.sendBIN(buffers.hdr, stream.bytes_written, true)) {
        Serial.println("Failed to send CloseStream");
        delaySafe();
        return;
      }
      wsSent = true;
      accelStreamOpen = false;
    }
    accelStreamProblem = false;
    accelRead(NULL); // Quick read
  }
  if (!wsSent && accelOpenOrPublish(ACCEL_SAMPLE_BLOCK)) {
    clockUp();
    if (!accelStreamOpen) {
      int64_t timestamp;
      int32_t reads;
      if (accelReadValues(NULL, NULL, NULL, 0, &timestamp, &reads)) {
        Serial.print("Open accelerometer stream at ");
        Serial.print(PriUint64<DEC>(timestamp));
        Serial.print(", ");
        Serial.println(reads);
        accelOpenTs = timestamp;
        accelOpenReads = reads;
        messages.openStream = (OpenStream)OpenStream_init_zero;
        messages.openStream.message_type = MessageType_OPEN_STREAM;
        strcpy(messages.openStream.password, accelPassword);
        messages.openStream.has_info = true;
        strcpy(messages.openStream.info.name, accelName);
        messages.openStream.alias = accelStreamAlias;
        messages.openStream.info.channels = 3;
        messages.openStream.info.frequency = accelFreq;
        messages.openStream.info.bits = 16;
        messages.openStream.info.timestamp = timestamp; // The timestamp that was set when the sensor fifo was cleared, so the timestamp of the first sample
        strcpy(messages.openStream.info.description, accelDescription);
        messages.openStream.info.channel_descriptions_count = 3;
        strcpy(messages.openStream.info.channel_descriptions[0], "X");
        strcpy(messages.openStream.info.channel_descriptions[1], "Y");
        strcpy(messages.openStream.info.channel_descriptions[2], "Z");
        messages.openStream.info.timestamp_precision = 1000000; // 1s
        messages.openStream.info.sensor = SensorType_ACCELEROMETER;
        messages.openStream.info.center_count = 3;
        messages.openStream.info.center[0] = 0;
        messages.openStream.info.center[1] = 0;
#if (SENSOR == SENSOR_LIS3DHH)
        strcpy(messages.openStream.info.hardware, "LIS3DHH");
        messages.openStream.info.scale = 2.5f;
        messages.openStream.info.zoom = 32.0f;
        messages.openStream.info.center[2] = 13107; // 1g
#elif (SENSOR == SENSOR_MPU6050)
        strcpy(messages.openStream.info.hardware, "MPU6050");
        messages.openStream.info.scale = 2.0f;
        messages.openStream.info.zoom = 25.6f;
        messages.openStream.info.center[2] = 16384; // 1g
#endif
        messages.openStream.info.unit = Unit_G;
        messages.openStream.info.latitude = latitude;
        messages.openStream.info.longitude = longitude;
        pb_ostream_t stream = pb_ostream_from_buffer(buffers.frame.any, sizeof(buffers));
        if (!pb_encode(&stream, OpenStream_fields, &messages.openStream)) {
          Serial.println("Failed to encode OpenStream");
          delaySafe();
          return;
        }
        if (!webSocket.sendBIN(buffers.hdr, stream.bytes_written, true)) {
          Serial.println("Failed to send OpenStream");
          delaySafe();
          return;
        }
        wsSent = true;
        accelStreamOpen = true;
        accelStreamProblem = false;
        accelSamplesSent = 0;
      }
    }
    if (accelStreamOpen) {
      messages.writeFrame = (WriteFrame)WriteFrame_init_zero;
      if (accelReadValues(
          messages.writeFrame.channels[0].data,
          messages.writeFrame.channels[1].data,
          messages.writeFrame.channels[2].data,
          ACCEL_SAMPLE_BLOCK, NULL)) {
        messages.writeFrame.message_type = MessageType_WRITE_FRAME;
        messages.writeFrame.alias = accelStreamAlias;
        messages.writeFrame.channels_count = 3;
        messages.writeFrame.channels[0].data_count = ACCEL_SAMPLE_BLOCK;
        messages.writeFrame.channels[1].data_count = ACCEL_SAMPLE_BLOCK;
        messages.writeFrame.channels[2].data_count = ACCEL_SAMPLE_BLOCK;
        pb_ostream_t stream = pb_ostream_from_buffer(buffers.frame.any, sizeof(buffers));
        if (!pb_encode(&stream, WriteFrame_fields, &messages.writeFrame)) {
          Serial.println("Failed to encode WriteFrame");
          accelStreamProblem = true;
          delaySafe();
          return;
        }
        if (!webSocket.sendBIN(buffers.hdr, stream.bytes_written, true)) {
          Serial.println("Failed to send WriteFrame");
          if (accelBackoutRead(ACCEL_SAMPLE_BLOCK)) {
            Serial.println("Backed out of frame, reattempt WriteFrame");
            delaySafe();
          } else {
            accelStreamProblem = true;
            delaySafe();
          }
          return;
        }
        wsSent = true;
        accelSamplesSent += ACCEL_SAMPLE_BLOCK;
      }
      
      // Check for drift on the sensor timing
      int64_t streamReads = (int64_t)accelRefReads - (int64_t)accelOpenReads;
      int64_t calcTimestamp = accelOpenTs + (1000000LL * streamReads / accelFreq);
      int64_t refTimestamp = accelRefTs;
      int64_t timestampDrift = abs(calcTimestamp - refTimestamp);
      if (timestampDrift > 1100000) { // Needs to stay within 1.1s drift
        Serial.println("Drift on sensor timing, retime");
        Serial.print("Current frequency: ");
        Serial.println(accelFreq);
        int64_t streamTime = refTimestamp - accelOpenTs;
        int64_t nextFreq = streamReads * 1000000LL / streamTime;
        Serial.print("Next frequency: ");
        Serial.println((int32_t)nextFreq);
        accelFreq = nextFreq;
        accelStreamProblem = true;
        return;
      }
    }
  }

#if AUXIL_SENSOR_EN
  // Routine to stream temperature samples
  if (auxilStreamProblem) {
    clockUp();
    auxilReset();
    if (auxilStreamOpen) {
      Serial.println("Close temperature stream");
      messages.closeStream = (CloseStream)CloseStream_init_zero;
      messages.closeStream.message_type = MessageType_CLOSE_STREAM;
      messages.closeStream.alias = auxilStreamAlias;
      pb_ostream_t stream = pb_ostream_from_buffer(buffers.frame.any, sizeof(buffers));
      if (!pb_encode(&stream, CloseStream_fields, &messages.closeStream)) {
        Serial.println("Failed to encode CloseStream");
        delaySafe();
        return;
      }
      if (!webSocket.sendBIN(buffers.hdr, stream.bytes_written, true)) {
        Serial.println("Failed to send CloseStream");
        delaySafe();
        return;
      }
      wsSent = true;
      auxilStreamOpen = false;
    }
    auxilStreamProblem = false;
  }
  if (!wsSent && auxilOpenOrPublish(AUXIL_SAMPLE_BLOCK)) {
    clockUp();
    if (!auxilStreamOpen) {
      int64_t timestamp;
      if (auxilReadValues(NULL,  0, &timestamp)) {
        Serial.print("Open temperature stream at ");
        Serial.println(PriUint64<DEC>(timestamp));
        messages.openStream = (OpenStream)OpenStream_init_zero;
        messages.openStream.message_type = MessageType_OPEN_STREAM;
        strcpy(messages.openStream.password, tempPassword);
        messages.openStream.has_info = true;
        strcpy(messages.openStream.info.name, tempName);
        messages.openStream.alias = auxilStreamAlias;
        messages.openStream.info.channels = 1;
        messages.openStream.info.frequency = 50;
        messages.openStream.info.bits = 12;
        messages.openStream.info.timestamp = timestamp; // The timestamp that was set when the sensor fifo was cleared, so the timestamp of the first sample
        strcpy(messages.openStream.info.description, tempDescription);
        messages.openStream.info.channel_descriptions_count = 1;
        strcpy(messages.openStream.info.channel_descriptions[0], "Sensor");
        messages.openStream.info.timestamp_precision = 1000000; // 1s
        messages.openStream.info.sensor = SensorType_TEMPERATURE;
        strcpy(messages.openStream.info.hardware, "LIS3DHH");
        messages.openStream.info.unit = Unit_CELSIUS;
        messages.openStream.info.scale = 128.0f; // 16 bitcounts per unit
        messages.openStream.info.zoom = 128.0f / 50.0f;
        messages.openStream.info.zero_count = 1;
        messages.openStream.info.zero[0] = -25 * 16;
        messages.openStream.info.latitude = latitude;
        messages.openStream.info.longitude = longitude;
        pb_ostream_t stream = pb_ostream_from_buffer(buffers.frame.any, sizeof(buffers));
        if (!pb_encode(&stream, OpenStream_fields, &messages.openStream)) {
          Serial.println("Failed to encode OpenStream");
          delaySafe();
          return;
        }
        if (!webSocket.sendBIN(buffers.hdr, stream.bytes_written, true)) {
          Serial.println("Failed to send OpenStream");
          delaySafe();
          return;
        }
        wsSent = true;
        auxilStreamOpen = true;
        auxilStreamProblem = false;
      }
    }
    if (auxilStreamOpen) {
      messages.writeFrame = (WriteFrame)WriteFrame_init_zero;
      if (auxilReadValues(
          messages.writeFrame.channels[0].data,
          AUXIL_SAMPLE_BLOCK, NULL)) {
        messages.writeFrame.message_type = MessageType_WRITE_FRAME;
        messages.writeFrame.alias = auxilStreamAlias;
        messages.writeFrame.channels_count = 1;
        messages.writeFrame.channels[0].data_count = AUXIL_SAMPLE_BLOCK;
        pb_ostream_t stream = pb_ostream_from_buffer(buffers.frame.any, sizeof(buffers));
        if (!pb_encode(&stream, WriteFrame_fields, &messages.writeFrame)) {
          Serial.println("Failed to encode WriteFrame");
          auxilStreamProblem = true;
          delaySafe();
          return;
        }
        if (!webSocket.sendBIN(buffers.hdr, stream.bytes_written, true)) {
          Serial.println("Failed to send WriteFrame");
          auxilStreamProblem = true;
          delaySafe();
          return;
        }
        wsSent = true;
      }
    }
  }
#endif

  // Clock down when we're done!
  clockDown();
  delayReset();
}

/* end of file */
