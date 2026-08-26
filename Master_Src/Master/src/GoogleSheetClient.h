#ifndef GOOGLE_SHEET_CLIENT_H
#define GOOGLE_SHEET_CLIENT_H

#include <Arduino.h>

#include "SensorData.h"

enum class GoogleSheetSendStatus : uint8_t {
  SUCCESS,
  CONFIRMATION_PENDING,
  RETRYABLE_ERROR,
  REJECTED,
  CONFIG_ERROR
};

struct GoogleSheetSendResult {
  GoogleSheetSendStatus status;
  int httpStatus;
  bool duplicate;
  char message[128];

  bool success() const { return status == GoogleSheetSendStatus::SUCCESS; }
};

class GoogleSheetClient {
public:
  GoogleSheetClient(const char *deploymentId, const char *sharedSecret);

  bool isConfigured() const;
  bool hasPendingConfirmation(const SensorReading &reading) const;
  GoogleSheetSendResult send(const SensorReading &reading) const;

private:
  const char *_deploymentId;
  const char *_sharedSecret;
};

#endif
