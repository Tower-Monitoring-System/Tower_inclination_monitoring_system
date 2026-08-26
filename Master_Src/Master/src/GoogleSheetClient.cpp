#include "GoogleSheetClient.h"

#include <WiFiClientSecure.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ArduinoJson.h"
#include "HttpClient/HttpClient.h"

namespace {

const char GOOGLE_SCRIPT_HOST[] = "script.google.com";
const uint16_t HTTPS_PORT = 443;
const uint32_t HTTP_TIMEOUT_MS = 12000UL;
const uint8_t MAX_REDIRECTS = 3;
const uint8_t REDIRECT_GET_ATTEMPTS_PER_SEND = 2;
const uint32_t REDIRECT_FIRST_ATTEMPT_DELAY_MS = 250UL;
const uint32_t REDIRECT_RETRY_DELAY_MS = 750UL;
const uint32_t PENDING_REDIRECT_MAX_AGE_MS = 300000UL;
const size_t MAX_PAYLOAD_LENGTH = 512;
const size_t MAX_SCRIPT_PATH_LENGTH = 384;
const size_t MAX_REDIRECT_HOST_LENGTH = 128;
const size_t MAX_LOCATION_LENGTH = 768;
const size_t MAX_RESPONSE_LENGTH = 512;

// Google Trust Services GTS Root R1, valid until 2036-06-22.
// Source: https://good.gtsr1.demosite.pki.goog/
const char GOOGLE_ROOT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw
CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU
MBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw
MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp
Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUA
A4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo
27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7w
Cl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjw
TcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0Pfybl
qAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaH
szVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8
Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmk
MiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92
wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70p
aDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrN
VjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQID
AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E
FgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibb
C5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe
QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuy
h6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM4
7HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8J
ZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6Ef
MgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/
Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT
6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ
0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm
2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bb
bP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c
-----END CERTIFICATE-----
)EOF";

struct HttpResponse {
  int statusCode;
  bool bodyTruncated;
  bool chunked;
  char location[MAX_LOCATION_LENGTH];
  char body[MAX_RESPONSE_LENGTH];
};

// Cac buffer nay duoc dat trong RAM tinh thay vi stack cua FreeRTOS task.
// HTTPS/TLS da can nhieu stack; de cac mang 384..768 byte trong chuoi ham
// send() -> performRequest() tung lam tran stack loopTask tren ESP32.
// Master chi co mot upload worker nen bo buffer nay khong can re-entrant.
struct GoogleSheetIoBuffers {
  HttpResponse response;
  char payload[MAX_PAYLOAD_LENGTH];
  char scriptPath[MAX_SCRIPT_PATH_LENGTH];
  char redirectHost[MAX_REDIRECT_HOST_LENGTH];
  char redirectPath[MAX_LOCATION_LENGTH];
  char headerLine[MAX_LOCATION_LENGTH];
  bool confirmationPending;
  uint32_t confirmationCreatedAt;
  char confirmationRequestId[SENSOR_REQUEST_ID_CAPACITY];
};

GoogleSheetIoBuffers ioBuffers = {};

GoogleSheetSendResult makeResult(GoogleSheetSendStatus status, int httpStatus,
                                 const char *message,
                                 bool duplicate = false) {
  GoogleSheetSendResult result = {};
  result.status = status;
  result.httpStatus = httpStatus;
  result.duplicate = duplicate;
  snprintf(result.message, sizeof(result.message), "%s",
           message ? message : "Unknown error.");
  return result;
}

bool startsWith(const char *value, const char *prefix) {
  if (!value || !prefix) {
    return false;
  }
  return strncmp(value, prefix, strlen(prefix)) == 0;
}

bool startsWithIgnoreCase(const char *value, const char *prefix) {
  while (*prefix) {
    if (!*value || tolower(static_cast<unsigned char>(*value)) !=
                       tolower(static_cast<unsigned char>(*prefix))) {
      return false;
    }
    ++value;
    ++prefix;
  }
  return true;
}

bool containsIgnoreCase(const char *value, const char *needle) {
  if (!value || !needle || !*needle) {
    return false;
  }

  for (; *value; ++value) {
    if (startsWithIgnoreCase(value, needle)) {
      return true;
    }
  }
  return false;
}

void captureResponseHeader(const char *line, HttpResponse &response) {
  const char locationPrefix[] = "Location:";
  if (startsWithIgnoreCase(line, locationPrefix)) {
    const char *value = line + strlen(locationPrefix);
    while (*value == ' ' || *value == '\t') {
      ++value;
    }
    snprintf(response.location, sizeof(response.location), "%s", value);
    return;
  }

  const char transferEncodingPrefix[] = "Transfer-Encoding:";
  if (startsWithIgnoreCase(line, transferEncodingPrefix)) {
    response.chunked = containsIgnoreCase(
        line + strlen(transferEncodingPrefix), "chunked");
  }
}

bool readHeaders(HttpClient &http, HttpResponse &response) {
  char *line = ioBuffers.headerLine;
  size_t lineLength = 0;
  bool lineOverflow = false;
  uint32_t lastDataAt = millis();

  while (!http.endOfHeadersReached() &&
         millis() - lastDataAt < HTTP_TIMEOUT_MS) {
    if (http.available()) {
      const int value = http.readHeader();
      if (value < 0) {
        continue;
      }
      lastDataAt = millis();
      const char character = static_cast<char>(value);

      if (character == '\n') {
        if (!lineOverflow) {
          while (lineLength > 0 &&
                 (line[lineLength - 1] == '\r' ||
                  line[lineLength - 1] == '\n')) {
            --lineLength;
          }
          line[lineLength] = '\0';
          captureResponseHeader(line, response);
        }
        lineLength = 0;
        lineOverflow = false;
      } else if (!lineOverflow) {
        if (lineLength + 1 < MAX_LOCATION_LENGTH) {
          line[lineLength++] = character;
        } else {
          lineOverflow = true;
        }
      }
    } else {
      if (!http.connected()) {
        break;
      }
      delay(1);
    }
  }

  return http.endOfHeadersReached();
}

int readByteWithTimeout(HttpClient &http) {
  const uint32_t startedAt = millis();
  while (millis() - startedAt < HTTP_TIMEOUT_MS) {
    if (http.available()) {
      return http.read();
    }
    if (!http.connected()) {
      return -1;
    }
    delay(1);
  }
  return -1;
}

bool readChunkLine(HttpClient &http, char *line, size_t lineSize) {
  size_t length = 0;
  while (length + 1 < lineSize) {
    const int value = readByteWithTimeout(http);
    if (value < 0) {
      return false;
    }
    if (value == '\n') {
      line[length] = '\0';
      return true;
    }
    if (value != '\r') {
      line[length++] = static_cast<char>(value);
    }
  }
  return false;
}

bool readChunkedBody(HttpClient &http, HttpResponse &response) {
  size_t bodyLength = 0;
  size_t totalReceived = 0;

  while (totalReceived <= 8192) {
    char chunkHeader[32];
    if (!readChunkLine(http, chunkHeader, sizeof(chunkHeader))) {
      return false;
    }

    char *extension = strchr(chunkHeader, ';');
    if (extension) {
      *extension = '\0';
    }
    char *sizeEnd = nullptr;
    const unsigned long chunkSize = strtoul(chunkHeader, &sizeEnd, 16);
    if (sizeEnd == chunkHeader || *sizeEnd != '\0') {
      return false;
    }

    if (chunkSize == 0) {
      // Consume optional trailer headers up to the empty line.
      do {
        if (!readChunkLine(http, chunkHeader, sizeof(chunkHeader))) {
          return false;
        }
      } while (chunkHeader[0] != '\0');

      response.body[bodyLength] = '\0';
      return bodyLength > 0;
    }
    if (totalReceived + chunkSize > 8192) {
      return false;
    }

    for (unsigned long index = 0; index < chunkSize; ++index) {
      const int value = readByteWithTimeout(http);
      if (value < 0) {
        return false;
      }
      if (bodyLength + 1 < sizeof(response.body)) {
        response.body[bodyLength++] = static_cast<char>(value);
      } else {
        response.bodyTruncated = true;
      }
    }
    totalReceived += chunkSize;

    // Every chunk payload is followed by CRLF.
    const int carriageReturn = readByteWithTimeout(http);
    const int lineFeed = readByteWithTimeout(http);
    if (carriageReturn != '\r' || lineFeed != '\n') {
      return false;
    }
  }
  return false;
}

bool readBody(HttpClient &http, HttpResponse &response) {
  if (response.chunked) {
    return readChunkedBody(http, response);
  }

  size_t bodyLength = 0;
  uint32_t lastDataAt = millis();
  const int expectedLength = http.contentLength();

  while (millis() - lastDataAt < HTTP_TIMEOUT_MS) {
    while (http.available()) {
      const int value = http.read();
      if (value < 0) {
        break;
      }
      lastDataAt = millis();

      if (bodyLength + 1 < sizeof(response.body)) {
        response.body[bodyLength++] = static_cast<char>(value);
      } else {
        response.bodyTruncated = true;
      }
    }

    if (expectedLength > 0 &&
        bodyLength >= static_cast<size_t>(expectedLength)) {
      break;
    }
    if (!http.connected() && !http.available()) {
      break;
    }
    delay(1);
  }

  response.body[bodyLength] = '\0';
  return bodyLength > 0;
}

bool performRequest(const char *host, const char *path, const char *method,
                    const char *payload, size_t payloadLength,
                    HttpResponse &response) {
  response = {};

  WiFiClientSecure secureClient;
  secureClient.setCACert(GOOGLE_ROOT_CA);
  secureClient.setTimeout(HTTP_TIMEOUT_MS);

  HttpClient http(secureClient);
  http.setHttpResponseTimeout(HTTP_TIMEOUT_MS);
  http.beginRequest();

  const int startResult = http.startRequest(host, HTTPS_PORT, path, method,
                                            "ESP32-Tower-Master/1.0");
  if (startResult != HTTP_SUCCESS) {
    http.stop();
    response.statusCode = startResult;
    return false;
  }

  http.sendHeader("Accept", "application/json");
  http.sendHeader("Accept-Encoding", "identity");
  if (payload && payloadLength > 0) {
    http.sendHeader("Content-Type", "application/json; charset=utf-8");
    http.sendHeader(HTTP_HEADER_CONTENT_LENGTH,
                    static_cast<int>(payloadLength));
    if (http.write(reinterpret_cast<const uint8_t *>(payload), payloadLength) !=
        payloadLength) {
      http.stop();
      response.statusCode = HTTP_ERROR_CONNECTION_FAILED;
      return false;
    }
  }
  http.endRequest();

  response.statusCode = http.responseStatusCode();
  if (response.statusCode < 0 || !readHeaders(http, response)) {
    http.stop();
    return false;
  }

  if (response.statusCode >= 300 && response.statusCode < 400) {
    http.stop();
    return response.location[0] != '\0';
  }

  const bool hasCompleteBody = readBody(http, response);
  http.stop();
  return hasCompleteBody;
}

bool parseHttpsUrl(const char *url, char *host, size_t hostSize, char *path,
                   size_t pathSize) {
  const char scheme[] = "https://";
  if (!startsWith(url, scheme)) {
    return false;
  }

  const char *hostStart = url + strlen(scheme);
  const char *pathStart = strchr(hostStart, '/');
  const size_t hostLength =
      pathStart ? static_cast<size_t>(pathStart - hostStart) : strlen(hostStart);

  if (hostLength == 0 || hostLength >= hostSize ||
      memchr(hostStart, ':', hostLength)) {
    return false;
  }

  memcpy(host, hostStart, hostLength);
  host[hostLength] = '\0';
  snprintf(path, pathSize, "%s", pathStart ? pathStart : "/");
  return strlen(pathStart ? pathStart : "/") < pathSize;
}

void clearPendingConfirmation() {
  ioBuffers.confirmationPending = false;
  ioBuffers.confirmationCreatedAt = 0;
  ioBuffers.confirmationRequestId[0] = '\0';
  ioBuffers.redirectHost[0] = '\0';
  ioBuffers.redirectPath[0] = '\0';
}

bool pendingConfirmationMatches(const char *requestId) {
  return ioBuffers.confirmationPending && requestId && requestId[0] &&
         strcmp(ioBuffers.confirmationRequestId, requestId) == 0 &&
         millis() - ioBuffers.confirmationCreatedAt <
             PENDING_REDIRECT_MAX_AGE_MS;
}

void savePendingConfirmation(const char *requestId) {
  ioBuffers.confirmationPending = true;
  ioBuffers.confirmationCreatedAt = millis();
  snprintf(ioBuffers.confirmationRequestId,
           sizeof(ioBuffers.confirmationRequestId), "%s", requestId);
}

bool followPendingConfirmation(HttpResponse &response) {
  for (uint8_t attempt = 0; attempt < REDIRECT_GET_ATTEMPTS_PER_SEND;
       ++attempt) {
    delay(attempt == 0 ? REDIRECT_FIRST_ATTEMPT_DELAY_MS
                       : REDIRECT_RETRY_DELAY_MS);
    if (performRequest(ioBuffers.redirectHost, ioBuffers.redirectPath,
                       HTTP_METHOD_GET, nullptr, 0, response)) {
      return true;
    }
  }
  return false;
}

bool isRetryableHttpStatus(int statusCode) {
  return statusCode < 0 || (statusCode >= 300 && statusCode < 400) ||
         statusCode == 408 || statusCode == 425 || statusCode == 429 ||
         statusCode >= 500;
}

bool isAllowedGoogleRedirectHost(const char *host) {
  return strcmp(host, "script.googleusercontent.com") == 0 ||
         strcmp(host, GOOGLE_SCRIPT_HOST) == 0;
}

bool isValidTowerId(const char *towerId) {
  if (!towerId) {
    return false;
  }
  const size_t length = strlen(towerId);
  if (length == 0 || length >= SENSOR_TOWER_ID_CAPACITY ||
      towerId[0] == '\'' || towerId[length - 1] == '\'') {
    return false;
  }
  return strpbrk(towerId, ":\\/?*[]") == nullptr;
}

} // namespace

GoogleSheetClient::GoogleSheetClient(const char *deploymentId,
                                     const char *sharedSecret)
    : _deploymentId(deploymentId),
      _sharedSecret(sharedSecret) {}

bool GoogleSheetClient::isConfigured() const {
  return _deploymentId && _deploymentId[0] && _sharedSecret &&
         _sharedSecret[0] && !startsWith(_deploymentId, "REPLACE_") &&
         !startsWith(_sharedSecret, "REPLACE_");
}

bool GoogleSheetClient::hasPendingConfirmation(
    const SensorReading &reading) const {
  return pendingConfirmationMatches(reading.requestId);
}

GoogleSheetSendResult
GoogleSheetClient::send(const SensorReading &reading) const {
  if (!isConfigured()) {
    return makeResult(GoogleSheetSendStatus::CONFIG_ERROR, 0,
                      "Chua cau hinh Apps Script deployment ID/shared secret.");
  }
  if (!isSensorReadingValid(reading) || !isValidTowerId(reading.towerId) ||
      !reading.requestId[0]) {
    return makeResult(GoogleSheetSendStatus::REJECTED, 0,
                      "Du lieu, towerId hoac requestId khong hop le.");
  }

  bool hasResponse = false;
  if (pendingConfirmationMatches(reading.requestId)) {
    if (!followPendingConfirmation(ioBuffers.response)) {
      return makeResult(
          GoogleSheetSendStatus::CONFIRMATION_PENDING,
          ioBuffers.response.statusCode,
          "POST da xu ly; chi thu lai URL xac nhan, khong gui lai du lieu.");
    }
    clearPendingConfirmation();
    hasResponse = true;
  } else {
    // URL xac nhan cu da het han hoac khong thuoc request dang cho.
    clearPendingConfirmation();
  }

  if (!hasResponse) {
    JsonDocument requestDocument;
    requestDocument["action"] = "append";
    requestDocument["token"] = _sharedSecret;
    requestDocument["towerId"] = reading.towerId;
    requestDocument["requestId"] = reading.requestId;
    requestDocument["x"] = reading.x;
    requestDocument["y"] = reading.y;
    requestDocument["z"] = reading.z;
    requestDocument["battery"] = reading.battery;

    const size_t payloadLength = serializeJson(
        requestDocument, ioBuffers.payload, sizeof(ioBuffers.payload));
    if (payloadLength == 0 ||
        payloadLength >= sizeof(ioBuffers.payload) - 1) {
      return makeResult(GoogleSheetSendStatus::REJECTED, 0,
                        "Khong tao duoc JSON request.");
    }

    const int pathLength = snprintf(ioBuffers.scriptPath,
                                    sizeof(ioBuffers.scriptPath),
                                    "/macros/s/%s/exec", _deploymentId);
    if (pathLength <= 0 ||
        static_cast<size_t>(pathLength) >= sizeof(ioBuffers.scriptPath)) {
      return makeResult(GoogleSheetSendStatus::CONFIG_ERROR, 0,
                        "Apps Script deployment ID qua dai.");
    }

    if (!performRequest(GOOGLE_SCRIPT_HOST, ioBuffers.scriptPath,
                        HTTP_METHOD_POST, ioBuffers.payload, payloadLength,
                        ioBuffers.response)) {
      return makeResult(GoogleSheetSendStatus::RETRYABLE_ERROR,
                        ioBuffers.response.statusCode,
                        "Khong nhan duoc phan hoi HTTPS hop le.");
    }
  }

  uint8_t redirectCount = 0;
  while (ioBuffers.response.statusCode >= 300 &&
         ioBuffers.response.statusCode < 400 &&
         redirectCount < MAX_REDIRECTS) {
    if (!parseHttpsUrl(ioBuffers.response.location, ioBuffers.redirectHost,
                       sizeof(ioBuffers.redirectHost), ioBuffers.redirectPath,
                       sizeof(ioBuffers.redirectPath))) {
      return makeResult(GoogleSheetSendStatus::RETRYABLE_ERROR,
                        ioBuffers.response.statusCode,
                        "Google tra ve redirect HTTPS khong hop le.");
    }
    if (!isAllowedGoogleRedirectHost(ioBuffers.redirectHost)) {
      clearPendingConfirmation();
      return makeResult(GoogleSheetSendStatus::REJECTED,
                        ioBuffers.response.statusCode,
                        "Google redirect den host khong duoc phep.");
    }

    savePendingConfirmation(reading.requestId);
    if (!followPendingConfirmation(ioBuffers.response)) {
      return makeResult(
          GoogleSheetSendStatus::CONFIRMATION_PENDING,
          ioBuffers.response.statusCode,
          "POST da xu ly; chi thu lai URL xac nhan, khong gui lai du lieu.");
    }
    clearPendingConfirmation();
    ++redirectCount;
  }

  if (ioBuffers.response.statusCode < 200 ||
      ioBuffers.response.statusCode >= 300) {
    return makeResult(isRetryableHttpStatus(ioBuffers.response.statusCode)
                          ? GoogleSheetSendStatus::RETRYABLE_ERROR
                          : GoogleSheetSendStatus::REJECTED,
                      ioBuffers.response.statusCode,
                      "Apps Script tra ve HTTP loi.");
  }
  if (ioBuffers.response.bodyTruncated) {
    return makeResult(GoogleSheetSendStatus::RETRYABLE_ERROR,
                      ioBuffers.response.statusCode,
                      "Phan hoi Apps Script qua dai.");
  }

  JsonDocument responseDocument;
  const DeserializationError jsonError =
      deserializeJson(responseDocument, ioBuffers.response.body);
  if (jsonError) {
    return makeResult(GoogleSheetSendStatus::RETRYABLE_ERROR,
                      ioBuffers.response.statusCode,
                      "Phan hoi Apps Script khong phai JSON.");
  }

  const bool ok = responseDocument["ok"] | false;
  const bool duplicate = responseDocument["duplicate"] | false;
  if (ok) {
    return makeResult(GoogleSheetSendStatus::SUCCESS,
                      ioBuffers.response.statusCode,
                      duplicate ? "Du lieu da duoc ghi truoc do."
                                : "Da ghi du lieu vao Google Sheet.",
                      duplicate);
  }

  const char *errorCode = responseDocument["errorCode"] | "";
  const char *errorMessage =
      responseDocument["error"] | "Apps Script tu choi request.";
  const bool retryable = strcmp(errorCode, "LOCK_TIMEOUT") == 0 ||
                         strcmp(errorCode, "TEMPORARY_UNAVAILABLE") == 0;
  return makeResult(retryable ? GoogleSheetSendStatus::RETRYABLE_ERROR
                               : GoogleSheetSendStatus::REJECTED,
                    ioBuffers.response.statusCode, errorMessage);
}
