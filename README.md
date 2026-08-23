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
│   └── sign-in.css
│
├── js/
│   ├── app.js
│   │
│   ├── core/
│   │   ├── store.js
│   │   ├── config.js
│   │   └── constants.js
│   │
│   ├── models/
│   │   ├── Station.js
│   │   └── SensorData.js
│   │
│   ├── services/
│   │   ├── apiService.js
│   │   ├── mqttService.js
│   │   └── authService.js
│   │
│   ├── logic/
│   │   ├── tiltProcessor.js
│   │   ├── warningProcessor.js
│   │   └── stationProcessor.js
│   │
│   └── components/
│       ├── Dashboard.js
│       ├── TiltChart.js
│       ├── StationCard.js
│       └── AlertPanel.js
│
└── assets/
```