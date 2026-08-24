# Tower_inclination_monitoring_system
- Developer: Phạm Ngọc Luật
- Developer: Trần Hữu Danh
- Developer: Trần Thanh Quang
- Major: Electronics and Communication Engineering
- School: CAN THO UNIVERSITY
- Email: pnluat@ctu.edu.vn
-----------------------------------------------------

## Project Structure

```text
Tower_inclination_monitoring_system/
│
├── index.html
├── sign-in.html
│
├── css/
│   ├── global.css
│   ├── dashboard.css
│   ├── components.css
│   ├── sign-in.css
│   ├── list.css
│   ├── alerts.css
│   ├── towers.css
│   └── settings.css
│
├── js/
│   ├── app.js
│   ├── sign-in.js
│   │
│   ├── core/
│   │   ├── store.js
│   │   ├── config.js
│   │   ├── supabaseConfig.js
│   │   ├── constants.js
│   │   └── settingsDefaults.js
│   │
│   ├── models/
│   │   ├── Station.js
│   │   └── SensorData.js
│   │
│   ├── services/
│   │   ├── apiService.js
│   │   ├── supabaseClient.js
│   │   ├── mqttService.js
│   │   ├── authService.js
│   │   ├── sensorDataService.js
│   │   ├── alertService.js
│   │   ├── settingsRepository.js
│   │   ├── settingsService.js
│   │   ├── esp32SettingsAdapter.js
│   │   ├── towerHistoryService.js
│   │   ├── towerRegistryRepository.js
│   │   └── towerRegistryService.js
│   │
│   ├── logic/
│   │   ├── tiltProcessor.js
│   │   ├── warningProcessor.js
│   │   ├── stationProcessor.js
│   │   ├── sensorDataProcessor.js
│   │   ├── alertProcessor.js
│   │   ├── settingsValidation.js
│   │   ├── towerMonitoringProcessor.js
│   │   └── towerRegistryValidation.js
│   │
│   ├── pages/
│   │   ├── listPage.js
│   │   ├── alertsPage.js
│   │   ├── towersPage.js
│   │   └── settingsPage.js
│   │
│   ├── utils/
│   │   └── xlsxExporter.js
│   │
│   └── components/
│       ├── Dashboard.js
│       ├── TiltChart.js
│       ├── TowerTrendChart.js
│       ├── TowerVectorChart.js
│       ├── StationCard.js
│       └── AlertPanel.js
│
├── supabase/
│   ├── config.toml
│   ├── schema.sql
│   │
│   └── functions/
│       ├── username-login/
│       │   └── index.ts
│       └── sensor-data/
│           └── index.ts
│
├── google-apps-script/
│   └── Code.gs
└── assets/
```
---

## Authentication

Authentication is handled by Supabase Auth and the `username-login` Edge Function. Passwords are not stored in the frontend source or in `public.profiles`.

See `SUPABASE_SETUP.md` for setup and deployment instructions.

## Sensor Data List

The List page reads validated Google Sheets data through an authenticated Supabase Edge Function. It supports Day/Month/Custom date-range filtering, Date/Time sorting, pagination, resilient polling, battery warnings, and native `.xlsx` export.

See `SENSOR_DATA_SETUP.md` for the complete Google Sheets, Apps Script, and Supabase deployment guide.

## Alerts

The Alerts page derives battery and tower-inclination events from the same authenticated sensor-data feed. Consecutive readings that violate the same rule remain one event; a safe reading resolves that event, and a later violation starts a new event. No sample alert records are embedded in the frontend.

Applied battery and per-axis inclination thresholds come from the shared System Settings service. The polling interval, page size, history limit, and fallback tower ID are in `js/core/config.js` under `ALERT_CONFIG`. Change `sourceTowerId` when the Google Sheet represents a different tower.

## System Settings

The System Settings page manages MPU6050 calibration, X/Y/Z alert thresholds, the battery warning threshold, ESP32 Wi-Fi/AP settings, and the shared Tower Registry. Tower records are validated and persisted through a repository/service boundary; Tower ID is the exact Google Sheet tab name. Wi-Fi and AP passwords are never written to browser storage.

## Tower Monitoring

The Towers page builds Select Tower only from the shared Tower Registry. Selecting a Tower forwards its ID through `TowerHistoryService`, the authenticated Supabase Edge Function, and Google Apps Script so the matching Sheet tab is read dynamically. No sample Tower is inserted into the selector.

Day/Month/Custom filtering is applied once and shared by the current X/Y/Z/resultant/battery values, the interactive X/Y trend, and the 3-axis orientation view. `TOWERS_CONFIG.maximumHistoryPointsPerTower` bounds retained history, while switching or deleting a Tower cancels stale requests and prevents readings from being mixed across Tower IDs.
