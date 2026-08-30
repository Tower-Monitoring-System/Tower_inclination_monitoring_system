#ifndef GOOGLE_SHEET_CONFIG_H
#define GOOGLE_SHEET_CONFIG_H

#include "GoogleSheetUploader.h"

namespace GoogleSheetConfig {

// Thay hai gia tri REPLACE_* sau khi deploy Google Apps Script Web App.
constexpr char SCRIPT_URL[] =
    "https://script.google.com/macros/s/AKfycbwrAbRWXss1oLYyvL5FaFSbFAb13U5BRfvYgPIUNiCPNspENL1kW7wYkKdt2sTOVJs/exec";
constexpr char SHARED_SECRET[] = "ph5CC7YKt8QIZelCsIcAg5TGovQtTtjR/QHboHMF1Os=";
constexpr char TOWER_ID[] = "TWR-01";
constexpr uint16_t NODE_ID = 1U;

// De rong ROOT_CERTIFICATE de dung TLS insecure trong giai doan thu nghiem.
// Khi trien khai chinh thuc, nen gan CA hop le va dat ALLOW_INSECURE_TLS=false.
constexpr char ROOT_CERTIFICATE[] = "";
constexpr bool ALLOW_INSECURE_TLS = true;

// CONNECT timeout gioi han TCP/TLS handshake; WRITE timeout gioi han rieng
// cho moi lan gui tron header hoac payload. Uploader khong co response timeout.
constexpr uint32_t CONNECT_TIMEOUT_MS = 5000UL;
constexpr uint32_t WRITE_TIMEOUT_MS = 8000UL;
constexpr uint32_t INITIAL_RETRY_MS = 5000UL;
constexpr uint32_t MAXIMUM_RETRY_MS = 300000UL;

static const GoogleSheetUploaderConfig UPLOADER = {
    SCRIPT_URL,
    SHARED_SECRET,
    TOWER_ID,
    NODE_ID,
    ROOT_CERTIFICATE,
    ALLOW_INSECURE_TLS,
    CONNECT_TIMEOUT_MS,
    WRITE_TIMEOUT_MS,
    INITIAL_RETRY_MS,
    MAXIMUM_RETRY_MS,
};

}  // namespace GoogleSheetConfig

#endif
