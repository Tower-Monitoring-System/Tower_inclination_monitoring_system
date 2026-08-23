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
│   └── alerts.css
│
├── js/
│   ├── app.js
│   ├── sign-in.js
│   │
│   ├── core/
│   │   ├── store.js
│   │   ├── config.js
│   │   ├── supabaseConfig.js
│   │   └── constants.js
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
│   │   └── alertService.js
│   │
│   ├── logic/
│   │   ├── tiltProcessor.js
│   │   ├── warningProcessor.js
│   │   ├── stationProcessor.js
│   │   ├── sensorDataProcessor.js
│   │   └── alertProcessor.js
│   │
│   ├── pages/
│   │   ├── listPage.js
│   │   └── alertsPage.js
│   │
│   ├── utils/
│   │   └── xlsxExporter.js
│   │
│   └── components/
│       ├── Dashboard.js
│       ├── TiltChart.js
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

The List page reads validated Google Sheets data through an authenticated Supabase Edge Function. It supports Day/Month filtering, Date/Time sorting, pagination, resilient polling, battery warnings, and native `.xlsx` export.

See `SENSOR_DATA_SETUP.md` for the complete Google Sheets, Apps Script, and Supabase deployment guide.

## Alerts

The Alerts page derives battery and tower-inclination events from the same authenticated sensor-data feed. Consecutive readings that violate the same rule remain one event; a safe reading resolves that event, and a later violation starts a new event. No sample alert records are embedded in the frontend.

Thresholds are centralized in `js/core/constants.js` under `ALERT_THRESHOLDS`. The polling interval, page size, history limit, and fallback tower ID are in `js/core/config.js` under `ALERT_CONFIG`. Change `sourceTowerId` when the Google Sheet represents a different tower.
