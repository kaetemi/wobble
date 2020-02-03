
/*
 * Wobble.
 */

// Boards Manager URLs:
// https://dl.espressif.com/dl/package_esp32_index.json (esp32)
// https://arduino.esp8266.com/stable/package_esp8266com_index.json (esp8266)

// Dependencies:
// https://github.com/Links2004/arduinoWebSockets
// https://github.com/arduino-libraries/NTPClient
// https://github.com/yoursunny/PriUint64/

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

#include "wobble_protocol.pb.h"
#include "wifi_setup.h"

bool clockedUp = false;
bool connectingWiFi = false;
bool timeConnected = false;
bool timeReady = false;

WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP); // ntpUDP, "europe.pool.ntp.org", 3600, 60000

WebSocketsClient webSocket;

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

const int testStreamAlias = 1;
bool testStreamOpen = false;
bool testStreamProblem = false;
int64_t lastTestStreamTimestamp = 0;
int32_t samplesSent = 0;

union {
  OpenStream openStream;
  CloseStream closeStream;
  WriteFrame writeFrame;
} messages;

union {
  uint8_t any[1];
  uint8_t openStream[OpenStream_size];
  uint8_t closeStream[CloseStream_size];
  uint8_t writeFrame[WriteFrame_size];
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
}

void delaySafe(int32_t maxTimeout = 1000) {
  delay(safeTimeout);
  if (safeTimeout < maxTimeout) {
    safeTimeout *= 2;
  }
}

void delayReset() {
  safeTimeout = 10;
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

int64_t currentTimestamp() {
  const unsigned long currentMicros = micros();
  const unsigned long deltaMicros = currentMicros - microsLast;
  ntpOffset += deltaMicros;
  microsLast = currentMicros;
  return ntpOffset;
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
      delaySafe();
      Serial.print("T");
      timeReady = false;
      refreshNtp = true;
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
      Serial.println("Drift, retime");
      Serial.print("Timestamp: ");
      Serial.println(PriUint64<DEC>(timestamp));
      Serial.print("NTP Timestamp: ");
      Serial.println(PriUint64<DEC>(ntpTimestamp));
      Serial.print("Drift: ");
      Serial.println(PriUint64<DEC>(timestampDrift));
      timeReady = false;
      // // TODO: Close all streams EDIT: No need, only close streams when sensor frequency drifts!
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
    webSocketConnecting = false;
    delayReset();
    // TODO: Flag WS stream to restart from the next timestamp here!
  }
  if (!webSocketConnected) {
    clockUp();
    if (testStreamOpen) {
      // Close test stream
      testStreamOpen = false;
      testStreamProblem = false;
    }
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

  // Routine to submit test stream
  // if moredata...
  if (testStreamProblem) {
    // TODO: Close stream
    clockUp();
  }
  if (!testStreamOpen) {
    clockUp();
    Serial.println("Open test stream");
    lastTestStreamTimestamp = currentTimestamp();
    messages.openStream = (OpenStream)OpenStream_init_zero;
    messages.openStream.message_type = MessageType_OPEN_STREAM;
    strcpy(messages.openStream.password, "teststreampwd");
    messages.openStream.has_info = true;
    strcpy(messages.openStream.info.name, "teststreamname");
    messages.openStream.alias = testStreamAlias;
    messages.openStream.info.channels = 2;
    messages.openStream.info.frequency = 1100;
    messages.openStream.info.bits = 13;
    messages.openStream.info.timestamp = lastTestStreamTimestamp; // Should use the timestamp that was set when the sensor fifo was cleared
    strcpy(messages.openStream.info.description, "Test Stream");
    messages.openStream.info.channel_descriptions_count = 1;
    strcpy(messages.openStream.info.channel_descriptions[0], "Test Channel 0");
    messages.openStream.info.timestamp_precision = 1000000; // 1s
    messages.openStream.info.sensor = SensorType_ACCELEROMETER;
    strcpy(messages.openStream.info.hardware, "TestHW");
    messages.openStream.info.unit = Unit_G;
    messages.openStream.info.scale = 2.5f;
    messages.openStream.info.latitude = latitude;
    messages.openStream.info.longitude = longitude;
    pb_ostream_t stream = pb_ostream_from_buffer(buffers.any, sizeof(buffers));
    if (!pb_encode(&stream, OpenStream_fields, &messages.openStream)) {
      Serial.println("Failed to encode OpenStream");
      delaySafe();
      return;
    }
    if (!webSocket.sendBIN(buffers.any, stream.bytes_written)) {
      Serial.println("Failed to send OpenStream");
      delaySafe();
      return;
    }
    testStreamOpen = true;
    testStreamProblem = false;
    samplesSent = 0;
    // freq 11000, send 1100 samples each 100ms
    // cut stream every minute for testing purposes
  }
  if (testStreamOpen) {
    uint64_t timestamp = currentTimestamp();
    if (lastTestStreamTimestamp - timestamp >= 100000) {
      clockUp();
      lastTestStreamTimestamp += 100000;
      messages.writeFrame = (WriteFrame)WriteFrame_init_zero;
      messages.writeFrame.message_type = MessageType_WRITE_FRAME;
      messages.writeFrame.alias = testStreamAlias;
      messages.writeFrame.channels_count = 2;
      messages.writeFrame.channels[0].data_count = 110;
      messages.writeFrame.channels[1].data_count = 110;
      for (int i = 0; i < 110; ++i) {
        messages.writeFrame.channels[0].data[i] = i * 100;
        messages.writeFrame.channels[1].data[i] = -i * 100;
      }
      pb_ostream_t stream = pb_ostream_from_buffer(buffers.any, sizeof(buffers));
      if (!pb_encode(&stream, WriteFrame_fields, &messages.writeFrame)) {
        Serial.println("Failed to encode WriteFrame");
        testStreamProblem = true;
        delaySafe();
        return;
      }
      if (!webSocket.sendBIN(buffers.any, stream.bytes_written)) {
        Serial.println("Failed to send WriteFrame");
        testStreamProblem = true;
        delaySafe();
        return;
      }
    }
    samplesSent += 110;
  }

  // Clock down when we're done!
  clockDown();
  delayReset();
}

/* end of file */
