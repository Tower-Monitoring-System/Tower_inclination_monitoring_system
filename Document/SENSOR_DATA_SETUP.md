# Google Sheets & Apps Script Sensor Data Setup

This document guides you through setting up Google Sheets, the Google Apps Script Web App, Supabase Edge Functions, and EmailJS alerts for the **Tower Inclination Monitoring System**.

---

## 1. System Architecture & Data Paths

The system utilizes two distinct communication paths:

### A. Telemetry Write Path (Hardware/LoRa Master -> Google Sheets)
```text
ESP32 LoRa Master Node --(HTTP POST)--> Google Apps Script Web App (/exec)
                                        ├── Appends row to Google Sheets (TWR-01)
                                        ├── Tracks deduplication (__TELEMETRY_DEDUP)
                                        └── Evaluates alerts & dispatches EmailJS alert
```

### B. Telemetry Read Path (Dashboard Browser -> Google Sheets)
```text
Authenticated Web Browser --(HTTPS POST)--> Supabase sensor-data Edge Function
                                            --(HTTPS POST)--> Google Apps Script (/exec)
                                                              └── Reads Google Sheets rows
```

*The browser never receives the Google Apps Script URL or the shared secret directly.*

---

## 2. Prepare Google Sheets

1. Create a new Google Spreadsheet or open an existing one.
2. Copy the **Spreadsheet ID** from the browser URL:
   ```text
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
   ```
3. Set the spreadsheet time zone to your local deployment zone (e.g., `GMT+07:00 Ho Chi Minh City`) via **File > Settings > Calculation / Time zone**.
4. Each Tower is mapped to an individual sheet tab. The tab name must **exactly match** the Tower ID configured in **System Settings > Tower Management** (e.g., `TWR-01`).
5. Ensure the sheet has the required 6 columns in row 1:
   ```text
   Date | Time | X | Y | Z | Battery
   ```
   - **Date:** Date format (`YYYY-MM-DD` or `DD/MM/YYYY`).
   - **Time:** Time format (`HH:mm:ss` or `HH:mm`).
   - **X, Y, Z:** Numeric tilt degrees from `-180` to `180`.
   - **Battery:** Numeric voltage from `0` to `24` V.

*(Tip: You can let `setupTelemetryService()` create the tab, headers, and deduplication sheet automatically in Step 3).*

---

## 3. Configure and Deploy Google Apps Script

1. Open [Google Apps Script](https://script.google.com/) and create a new project.
2. Replace `Code.gs` with the repository file [`google-apps-script/Code.gs`](../google-apps-script/Code.gs).
3. Open **Project Settings > Script Properties** and add the required properties:

### Core Telemetry Properties

| Property | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `SENSOR_DATA_SHARED_SECRET` | **Yes** | Cryptographically secure secret (minimum 32 characters) shared with Supabase and Master Node. | `random_secret_32_chars_long` |
| `SENSOR_SHEET_ID` | **Yes** | Google Spreadsheet ID copied in Step 2. | `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms` |
| `SENSOR_SHEET_NAME` | No | Fallback sheet tab name when no tower is specified. | `TWR-01` |

### EmailJS & Alert Properties

| Property | Required | Description | Example |
| :--- | :---: | :--- | :--- |
| `EMAIL_ALERT_ENABLED` | **Yes** | Enable or disable automated email alerts (`true` / `false`). | `true` |
| `EMAILJS_SERVICE_ID` | **Yes** | EmailJS Service ID. | `service_xxxxxxx` |
| `EMAILJS_TEMPLATE_ID` | **Yes** | EmailJS Template ID. | `template_xxxxxxx` |
| `EMAILJS_PUBLIC_KEY` | **Yes** | EmailJS Public Key (Account user ID). | `user_public_key_xxx` |
| `EMAILJS_PRIVATE_KEY` | No | EmailJS Private Access Token (if strict mode is enabled). | `access_token_xxx` |
| `ALERT_EMAIL_TO` | **Yes** | Recipient email address for alert notifications. | `operator@ctu.edu.vn` |
| `ALERT_INITIAL_X` | No | Initial baseline calibration for X-axis (default: `0`). | `0.04` |
| `ALERT_INITIAL_Y` | No | Initial baseline calibration for Y-axis (default: `0`). | `3.28` |
| `ALERT_INITIAL_Z` | No | Initial baseline calibration for Z-axis (default: `0`). | `0.0` |
| `ALERT_TILT_X` | No | Tilt warning threshold for X-axis in degrees (default: `0.5`). | `0.5` |
| `ALERT_TILT_Y` | No | Tilt warning threshold for Y-axis in degrees (default: `0.5`). | `0.5` |
| `ALERT_TILT_Z` | No | Tilt warning threshold for Z-axis in degrees (default: `0.5`). | `0.5` |
| `ALERT_BATTERY_WARNING` | No | Low battery warning threshold in Volts (default: `12.8`). | `12.8` |
| `ALERT_BATTERY_CRITICAL` | No | Critical battery threshold in Volts (default: `10.0`). | `10.0` |

4. **Initialize Sheets & Dedup Table:**
   - In the Apps Script code editor, select the function `setupTelemetryService` from the function dropdown and click **Run**.
   - Grant the required Google Spreadsheet read/write permissions.
   - This automatically verifies headers and creates the hidden deduplication sheet `__TELEMETRY_DEDUP`.
5. **(Optional) Test EmailJS Connection:**
   - Run the function `testEmailJsConnection` to confirm that EmailJS credentials and email delivery are working properly.
6. **Deploy Web App:**
   - Click **Deploy > New deployment**.
   - Select type: **Web app**.
   - Description: `Tower Telemetry Production`.
   - **Execute as:** `Me` (your Google account).
   - **Who has access:** `Anyone` (Supabase Edge Function and ESP32 Master authenticate using the shared secret).
   - Click **Deploy** and copy the **Web app URL** ending in `/exec`.
7. **Verify Deployment (Health Check):**
   - Paste the `/exec` URL into your browser address bar.
   - It will return a health check JSON object:
     ```json
     {
       "ok": true,
       "service": "tower-telemetry-v5-email-alerts",
       "towerId": "TWR-01",
       "nodeId": 1,
       "secretConfigured": true,
       "sheetConfigured": true,
       "towerSheetFound": true,
       "headersValid": true,
       "emailAlertsEnabled": true,
       "emailJsConfigured": true
     }
     ```
   - Ensure all `*Configured` and `headersValid` fields are `true`.

---

## 4. Configure and Deploy Supabase Edge Functions

1. Install and login to Supabase CLI:
   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```
2. Set Edge Function secrets (server-side only, never expose to frontend):
   ```bash
   supabase secrets set GOOGLE_APPS_SCRIPT_URL="https://script.google.com/macros/s/DEPLOYMENT_ID/exec"
   supabase secrets set GOOGLE_APPS_SCRIPT_SHARED_SECRET="YOUR_RANDOM_SECRET_KEY"
   supabase secrets set SENSOR_DATA_ALLOWED_ORIGINS="https://YOUR_DOMAIN.example,http://localhost:8000"
   ```
   *Note: `SENSOR_DATA_ALLOWED_ORIGINS` is a comma-separated list of allowed web origins without trailing slashes.*
3. Deploy the `sensor-data` Edge Function:
   ```bash
   supabase functions deploy sensor-data
   ```
4. Verify in `supabase/config.toml` that `verify_jwt = true` is set for `sensor-data`.

---

## 5. Hardware (Master Node) Ingestion Format

The ESP32 Master node sends HTTP POST requests directly to the Google Apps Script Web App URL (`/exec`).

### Single Record Payload (`action: "appendTelemetry"`):
```json
{
  "action": "appendTelemetry",
  "token": "YOUR_SHARED_SECRET",
  "towerId": "TWR-01",
  "nodeId": 1,
  "messageId": 1042,
  "date": "2026-10-07",
  "time": "10:08:30",
  "x": 2.84,
  "y": 3.82,
  "z": 0.86,
  "battery": 13.41,
  "temp": 32.5
}
```

### Batch Records Payload (`action: "appendTelemetryBatch"`):
```json
{
  "action": "appendTelemetryBatch",
  "token": "YOUR_SHARED_SECRET",
  "towerId": "TWR-01",
  "nodeId": 1,
  "records": [
    { "messageId": 1043, "date": "2026-10-07", "time": "10:09:00", "x": 2.85, "y": 3.80, "z": 0.85, "battery": 13.40 },
    { "messageId": 1044, "date": "2026-10-07", "time": "10:09:30", "x": 2.86, "y": 3.81, "z": 0.86, "battery": 13.39 },
    { "messageId": 1045, "date": "2026-10-07", "time": "10:10:00", "x": 2.84, "y": 3.82, "z": 0.86, "battery": 13.40 }
  ]
}
```

---

## 6. Frontend Client Configuration

The frontend configuration resides in [`js/core/config.js`](../js/core/config.js):

- `SENSOR_DATA_CONFIG`:
  - `edgeFunctionName`: Deployed Edge Function name (default: `"sensor-data"`).
  - `requestTimeoutMs`: Request timeout in milliseconds (default: `35000`).
  - `pollingIntervalMs`: Background polling interval when the tab is active (default: `15000` / 15 seconds).
  - `cacheTtlMs`: Client-side cache time-to-live (default: `15000`).
  - `pageSize`: Number of rows per page in Sensor Data List (default: `20`).
  - `maximumRecords`: Maximum historical records requested (default: `20000`).
- `ALERT_CONFIG`:
  - `pageSize`: Alerts table page size (default: `10`).
  - `maximumAlerts`: Maximum active/historical alerts tracked in memory (default: `5000`).

*(Note: Dynamic calibration offsets, tilt thresholds, and battery warning voltages are managed directly in the browser via **System Settings** and synced across modules).*

---

## 7. Verification & Troubleshooting Checklist

1. **Check Apps Script Health Check:** Open the `/exec` URL in your browser. All checks must pass with `"ok": true`.
2. **Sign In to Dashboard:** Login via `sign-in.html` with an authorized account (`owner` or `operator`).
3. **Register Tower:** In **System Settings > Tower Management**, add a Tower whose ID exactly matches the Google Sheet tab name (e.g., `TWR-01`).
4. **View Monitoring & List:** Open **Towers** or **List** to verify real-time 3D vector orientation and data tables.
5. **Check Supabase Edge Function Logs:** In Supabase Dashboard > **Edge Functions > sensor-data > Logs**, check for upstream 200 OK responses.
