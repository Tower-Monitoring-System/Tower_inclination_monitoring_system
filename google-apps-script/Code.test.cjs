const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const MINUTE = 60_000;

// Run the real Apps Script source; only Google services and wall-clock time
// are substituted so tests never send email or modify a live spreadsheet.
function harness(overrides = {}) {
  let now = Date.parse('2026-10-07T09:00:00+07:00');
  let sequence = 0;
  let messageId = 0;
  let responseCode = 200;
  let onFetch = null;
  let locked = false;
  const sent = [];
  const triggers = [];
  const sheetRows = [];
  const sheetCalls = { reads: 0 };
  let sheetError = null;
  let sheetAvailable = true;
  const headers = ['Date', 'Time', 'X', 'Y', 'Z', 'Battery'];
  const propertyCalls = { reads: 0, writes: 0 };
  const values = {
    EMAIL_ALERT_ENABLED: 'true',
    EMAILJS_SERVICE_ID: 'service-test',
    EMAILJS_TEMPLATE_ID: 'template-test',
    EMAILJS_PUBLIC_KEY: 'public-test',
    ALERT_EMAIL_TO: 'owner@example.com',
    SENSOR_SHEET_ID: 'sheet-test',
    ...overrides,
  };
  const properties = {
    getProperty(key) { propertyCalls.reads++; return values[key] ?? null; },
    getProperties() { propertyCalls.reads++; return { ...values }; },
    setProperty(key, value) { propertyCalls.writes++; values[key] = String(value); return this; },
    setProperties(updates) { propertyCalls.writes++; Object.assign(values, updates); return this; },
    deleteProperty(key) { delete values[key]; return this; },
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: ClockDate,
    console: { log() {}, error() {} },
    PropertiesService: { getScriptProperties: () => properties },
    LockService: {
      getScriptLock: () => ({
        tryLock() { if (locked) return false; locked = true; return true; },
        releaseLock() { locked = false; },
      }),
    },
    Utilities: {
      getUuid: () => `event-${++sequence}`,
      formatDate(value, zone, format) {
        const local = new Date(value.getTime() + 7 * 60 * MINUTE).toISOString();
        return format === 'yyyy-MM-dd' ? local.slice(0, 10)
          : format === 'HH:mm:ss' ? local.slice(11, 19)
            : `${local.slice(0, 10)} ${local.slice(11, 19)}`;
      },
    },
    Session: { getScriptTimeZone: () => 'Asia/Ho_Chi_Minh' },
    SpreadsheetApp: {
      openById(id) {
        if (sheetError) throw new Error(sheetError);
        assert.equal(id, 'sheet-test');
        return {
          getSpreadsheetTimeZone: () => 'Asia/Ho_Chi_Minh',
          getSheetByName(name) {
            assert.equal(name, 'TWR-01');
            if (!sheetAvailable) return null;
            return {
              getLastRow: () => sheetRows.length + 1,
              getMaxColumns: () => 6,
              getRange(start, column, count, columns) {
                return {
                  getValues() {
                    sheetCalls.reads++;
                    return [headers, ...sheetRows].slice(start - 1, start - 1 + count)
                      .map(row => row.slice(column - 1, column - 1 + columns));
                  },
                  getDisplayValues() { return this.getValues().map(row => row.map(String)); },
                };
              },
            };
          },
        };
      },
    },
    UrlFetchApp: {
      fetch(url, options) {
        assert.equal(locked, false, 'HTTP must happen outside the telemetry lock');
        assert.equal(url, 'https://api.emailjs.com/api/v1.0/email/send');
        sent.push(JSON.parse(options.payload).template_params);
        if (onFetch) onFetch();
        return { getResponseCode: () => responseCode, getContentText: () => 'test response' };
      },
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger(trigger) { triggers.splice(triggers.indexOf(trigger), 1); },
      newTrigger(handler) {
        let minutes;
        return {
          timeBased() { return this; },
          everyMinutes(value) { minutes = value; return this; },
          create() {
            const trigger = { getHandlerFunction: () => handler, minutes };
            triggers.push(trigger);
            return trigger;
          },
        };
      },
    },
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  function reading(fields = {}) {
    const local = new Date(now + 7 * 60 * MINUTE).toISOString();
    return {
      towerId: 'TWR-01', nodeId: 1, messageId: ++messageId,
      date: local.slice(0, 10), time: local.slice(11, 19),
      x: 0, y: 0, z: 0, battery: 13.2, ...fields,
    };
  }
  return {
    context, properties, values, sent, triggers, reading, propertyCalls, sheetRows, sheetCalls,
    advance(ms) { now += ms; },
    failEmail(code) { responseCode = code; },
    onFetch(callback) { onFetch = callback; },
    process(fields) {
      const sample = reading(fields);
      sheetRows.push([sample.date, sample.time, sample.x, sample.y, sample.z, sample.battery]);
      context.processTelemetryForEmailAlerts_(sample);
    },
    failSheet(error) { sheetError = error; },
    hideSheet() { sheetAvailable = false; },
    send() { return context.deliverNextPendingEmailAlert_(); },
    tick() { return context.retryPendingEmailAlerts(); },
  };
}

test('normal readings never send email', () => {
  const h = harness();
  h.process();
  h.send();
  h.advance(120 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 0);
});

test('normal to warning sends once, repeats at 60 minutes using latest values', () => {
  const h = harness();
  h.process({ battery: 12.5 });
  h.send();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].severity, 'WARNING');
  h.advance(59 * MINUTE);
  h.process({ battery: 11.5 });
  h.tick();
  assert.equal(h.sent.length, 1);
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].battery, '11.50');
  assert.equal(h.sent[1].detected_at, '2026-10-07 09:59:00');
  h.advance(60 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 3, 'a timer must work without a new telemetry request');
});

test('normal to critical sends immediately and continues reminders', () => {
  const h = harness();
  h.process({ battery: 9.5 });
  h.send();
  assert.equal(h.sent[0].severity, 'CRITICAL');
  h.advance(60 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].severity, 'CRITICAL');
});

test('battery warning to critical sends immediately and restarts the reminder clock', () => {
  const h = harness();
  h.process({ battery: 12.5 });
  h.send();
  h.advance(10 * MINUTE);
  h.process({ battery: 9.5 });
  h.send();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].severity, 'CRITICAL');
  h.advance(50 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
  h.advance(10 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 3);
});

test('critical to warning sends no immediate mail, warning to critical sends again', () => {
  const h = harness();
  h.process({ battery: 9.5 });
  h.send();
  h.advance(2 * MINUTE);
  h.process({ battery: 12 });
  h.send();
  assert.equal(h.sent.length, 1);
  h.advance(2 * MINUTE);
  h.process({ battery: 9 });
  h.send();
  assert.equal(h.sent.length, 2);
});

test('uses overall severity rather than notifying each component separately', () => {
  const h = harness();
  h.process({ x: 0.6 });
  h.send();
  h.advance(2 * MINUTE);
  h.process({ x: 0.6, battery: 12 });
  h.send();
  assert.equal(h.sent.length, 1, 'the tower remains WARNING');
  h.advance(2 * MINUTE);
  h.process({ x: 0.6, battery: 9 });
  h.send();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].severity, 'CRITICAL');
  assert.match(h.sent[1].subject, /^\[CRITICAL\]/);
  assert.equal(h.sent[1].alert_count, '2');
});

test('return to normal cancels an undelivered warning and stops reminders', () => {
  const h = harness();
  h.process({ battery: 12 });
  h.advance(2 * MINUTE);
  h.process({ battery: 13.2 });
  h.send();
  h.advance(60 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 0);
  h.process({ battery: 9 });
  h.send();
  assert.equal(h.sent.length, 1, 'a new abnormal episode sends immediately');
});

test('normal recovery cancels failed retries', () => {
  const h = harness();
  h.failEmail(503);
  h.process({ battery: 12 });
  assert.throws(() => h.send(), /EmailJS HTTP 503/);
  h.process({ battery: 13.2 });
  h.failEmail(200);
  h.advance(60 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 1);
});

test('a failed email retries with current values, then starts its reminder clock', () => {
  const h = harness();
  h.failEmail(503);
  h.process({ battery: 12.5 });
  assert.throws(() => h.send(), /EmailJS HTTP 503/);
  h.advance(MINUTE);
  h.process({ battery: 11.5 });
  h.failEmail(200);
  h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].battery, '11.50');
  h.advance(59 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 3);
});

test('changes to the recheck property apply without reinstalling the trigger', () => {
  const h = harness({ ALERT_EMAIL_RECHECK_MINUTES: '15' });
  h.process({ battery: 12 });
  h.send();
  h.advance(15 * MINUTE - 1);
  h.tick();
  assert.equal(h.sent.length, 1);
  h.advance(1);
  h.tick();
  assert.equal(h.sent.length, 2);
  h.properties.setProperty('ALERT_EMAIL_RECHECK_MINUTES', '30');
  h.advance(15 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
  h.advance(15 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 3);
});

test('rejects invalid recheck durations', () => {
  for (const value of ['0', '-1', 'NaN', 'Infinity']) {
    const h = harness({ ALERT_EMAIL_RECHECK_MINUTES: value });
    assert.throws(() => h.context.getEmailAlertConfig_(h.properties), /ALERT_EMAIL_RECHECK_MINUTES/);
  }
});

test('setup installs one checker, preserves configured duration, replaces legacy retry trigger', () => {
  const h = harness({ ALERT_EMAIL_RECHECK_MINUTES: '15' });
  h.triggers.push({ getHandlerFunction: () => 'retryPendingEmailAlerts' });
  h.triggers.push({ getHandlerFunction: () => 'unrelatedTask' });
  h.context.setupEmailAlertService();
  h.context.setupEmailAlertService();
  assert.equal(h.values.ALERT_EMAIL_RECHECK_MINUTES, '15');
  assert.deepEqual(h.triggers.map(t => t.getHandlerFunction()).sort(), ['recheckEmailAlerts', 'unrelatedTask']);
  assert.equal(h.triggers.find(t => t.getHandlerFunction() === 'recheckEmailAlerts').minutes, 1);
});

test('disabled alerts never send reminders or queued emails', () => {
  const h = harness();
  h.process({ battery: 12 });
  h.context.disableEmailAlertService();
  h.advance(60 * MINUTE);
  h.tick();
  h.send();
  assert.equal(h.sent.length, 0);
});

test('duplicates and older telemetry cannot change the latest reminder measurements', () => {
  const h = harness();
  const first = h.reading({ battery: 12 });
  h.sheetRows.push([first.date, first.time, first.x, first.y, first.z, first.battery]);
  h.context.processTelemetryForEmailAlerts_(first);
  h.send();
  h.context.processTelemetryForEmailAlerts_({ ...first, battery: 13.2 });
  h.context.processTelemetryForEmailAlerts_(h.reading({ time: '08:00:00', battery: 13.2 }));
  h.advance(60 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].battery, '12.00');
});

test('a batch ending normal cancels earlier warning emails in the same batch', () => {
  const h = harness();
  h.context.processTelemetryBatchForEmailAlerts_([
    h.reading({ battery: 12 }), h.reading({ battery: 9 }), h.reading({ battery: 13.2 }),
  ]);
  h.send();
  assert.equal(h.sent.length, 0);
});

test('reminder reevaluates the latest readings using changed thresholds', () => {
  const h = harness();
  h.process({ battery: 12 });
  h.send();
  h.properties.setProperty('ALERT_BATTERY_WARNING', '11');
  h.advance(60 * MINUTE);
  h.tick();
  assert.equal(h.sent.length, 1);
});

test('an escalation supersedes a failed in-flight warning without duplicate deliveries', () => {
  const h = harness();
  h.process({ battery: 12 });
  h.failEmail(503);
  h.onFetch(() => {
    h.onFetch(null);
    h.advance(2000);
    h.process({ battery: 9 });
    h.send();
    assert.equal(h.sent.length, 1, 'an active lease prevents an overlapping HTTP send');
  });
  assert.throws(() => h.send(), /EmailJS HTTP 503/);
  h.failEmail(200);
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].severity, 'CRITICAL');
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2, 'a superseded failed warning must not send again');
});

test('an expired send lease is superseded by the latest queued escalation', () => {
  const h = harness();
  h.process({ battery: 12 });
  h.context.leaseNextEmailAlert_(h.properties); // Simulate an execution stopping before HTTP.
  h.advance(30_000);
  h.process({ battery: 9 });
  h.advance(30_000);
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].severity, 'CRITICAL');
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 1);
});

test('inclination critical to warning to critical has no episode latch', () => {
  const h = harness();
  h.process({ x: 0.9 });
  h.send();
  assert.equal(h.sent[0].severity, 'CRITICAL');
  for (let i = 0; i < 3; i++) {
    h.advance(MINUTE);
    h.process({ x: 0.6 });
  }
  h.send();
  assert.equal(h.sent.length, 1);
  h.advance(MINUTE);
  h.process({ x: 1.2 }); // Latest average (0.6 + 0.6 + 1.2) / 3 = 0.8.
  h.send();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].severity, 'CRITICAL');
  assert.equal(h.sent[1].avg_x, '0.80');
  assert.equal(h.sent[1].current_x, '1.20');
});

test('idle minute checker stays within the daily properties service budget', () => {
  const h = harness();
  h.process();
  h.propertyCalls.reads = 0;
  h.propertyCalls.writes = 0;
  h.tick();
  // Under 20 operations/minute leaves room beneath 50,000/day for telemetry.
  const operations = h.propertyCalls.reads + h.propertyCalls.writes;
  assert.ok(operations <= 20, `idle timer used ${operations} property service operations`);
  assert.equal(h.sent.length, 0);
});

test('timer reads existing Sheet data after setup without any telemetry POST', () => {
  const h = harness({
    ALERT_EMAIL_RECHECK_MINUTES: '1', ALERT_INITIAL_X: '0,04',
    ALERT_INITIAL_Y: '3,28', ALERT_INITIAL_Z: '-1,63',
    ALERT_TILT_X: '0.3', ALERT_TILT_Y: '0.3', ALERT_TILT_Z: '0.3',
  });
  h.sheetRows.push(
    ['02/10/2026', '21:00:00', '-0,73', '0,00', '0,73', '13,43'],
    ['02/10/2026', '22:00:00', '-0,72', '0,00', '0,72', '13,42'],
    ['02/10/2026', '23:00:00', '-0,74', '0,00', '0,74', '13,41'],
  );
  h.context.setupEmailAlertService();
  h.tick();
  assert.equal(h.sent.length, 1, 'setup must not leave the timer blind to existing Sheet data');
  assert.equal(h.sent[0].severity, 'CRITICAL');
  assert.match(h.sent[0].alert_message, /Y-axis inclination reached 3\.28/);
  assert.equal(h.sent[0].battery, '13.41');
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
});

test('reminder reads manual Sheet changes and stops when the latest window is normal', () => {
  const h = harness({ ALERT_EMAIL_RECHECK_MINUTES: '1' });
  h.process({ battery: 12 });
  h.send();
  h.sheetRows[0][5] = 11.25;
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent[1].battery, '11.25');
  h.sheetRows[0][5] = 13.2;
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
});

test('selects newest timestamps despite out-of-order rows and skips invalid rows', () => {
  const h = harness({ ALERT_EMAIL_RECHECK_MINUTES: '1' });
  h.sheetRows.push(
    ['2026-10-02', '23:00:00', 0.9, 0, 0, 13.2],
    ['2026-10-02', '21:00:00', 0.9, 0, 0, 13.2],
    ['2026-10-02', '22:00:00', 0.9, 0, 0, 13.2],
    ['2026-10-02', '16:00:00', 0, 0, 0, 13.2],
    ['2026-10-03', '23:00:00', 'invalid', 0, 0, 13.2],
  );
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].avg_x, '0.90');
  assert.equal(h.sent[0].detected_at, '2026-10-02 23:00:00');
  assert.equal(h.sheetCalls.reads, 1, 'a timer snapshot should use one bulk Sheet read');
});

test('latest sample gap over 90 minutes resets the Sheet averaging window', () => {
  const h = harness();
  h.sheetRows.push(
    ['2026-10-02', '16:00:00', 5, 0, 0, 13.2],
    ['2026-10-02', '17:00:00', 5, 0, 0, 13.2],
    ['2026-10-02', '23:00:00', 0, 0, 0, 13.2],
  );
  h.tick();
  assert.equal(h.sent.length, 0);
  const diagnostic = h.context.diagnoseEmailAlertService();
  assert.equal(diagnostic.currentLevel, 'normal');
  assert.equal(diagnostic.sampleCount, 1);
  assert.equal(diagnostic.reason, 'NORMAL');
});

test('Sheet Date objects, fractional times and duplicate timestamps normalize consistently', () => {
  const h = harness();
  h.sheetRows.push(
    [new Date('2026-10-02T00:00:00+07:00'), 21 / 24, 0, 0, 0, 13.2],
    [new Date('2026-10-02T00:00:00+07:00'), 21 / 24, 0.9, 0, 0, 13.2],
  );
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].avg_x, '0.90', 'a timestamp counts once, keeping its last valid row');
  assert.equal(h.sent[0].detected_at, '2026-10-02 21:00:00');
});

test('setup preserves an active reminder clock instead of erasing state', () => {
  const h = harness({ ALERT_EMAIL_RECHECK_MINUTES: '1' });
  h.process({ battery: 12 });
  h.send();
  h.advance(30_000);
  h.context.setupEmailAlertService();
  h.tick();
  assert.equal(h.sent.length, 1);
  h.advance(30_000);
  h.tick();
  assert.equal(h.sent.length, 2);
});

test('diagnostics identify missing configuration and empty data without sending email or leaking keys', () => {
  const h = harness({ EMAILJS_PRIVATE_KEY: 'private-secret', EMAILJS_TEMPLATE_ID: '' });
  const missing = h.context.diagnoseEmailAlertService();
  assert.equal(missing.reason, 'EMAILJS_NOT_CONFIGURED');
  assert.ok(missing.missingProperties.includes('EMAILJS_TEMPLATE_ID'));
  assert.equal(JSON.stringify(missing).includes('private-secret'), false);
  const empty = harness().context.diagnoseEmailAlertService();
  assert.equal(empty.reason, 'NO_VALID_SHEET_READINGS');
  assert.equal(h.sent.length, 0);
});

test('timer surfaces Sheet access failures rather than silently reporting a successful empty check', () => {
  const h = harness();
  h.failSheet('Sheet access denied');
  assert.throws(() => h.tick(), /Sheet access denied/);
  const diagnostic = h.context.diagnoseEmailAlertService();
  assert.equal(diagnostic.reason, 'SHEET_READ_FAILED');
  assert.equal(h.sent.length, 0);
  const absent = harness();
  absent.hideSheet();
  assert.throws(() => absent.tick(), /TWR-01/);
});

test('EmailJS payload fills name, time and reply email used by the supplied template', () => {
  const h = harness();
  h.context.testEmailJsConnection();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].name, 'Tower Inclination Monitoring System');
  assert.equal(h.sent[0].time, '2026-10-07 09:00:00');
  assert.equal(h.sent[0].email, 'owner@example.com');
});

test('timer keeps the current critical state beyond 20000 historical Sheet rows', () => {
  const h = harness({ ALERT_EMAIL_RECHECK_MINUTES: '1' });
  for (let i = 0; i < 20_000; i++) {
    h.sheetRows.push(['2026-09-14', '08:00:00', 0, 0, 0, 13.2]);
  }
  h.process({ x: 0.9 });
  h.send();
  assert.equal(h.sent[0].severity, 'CRITICAL');
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2, 'a history limit must not hide the current sample');
  assert.equal(h.sent[1].detected_at, '2026-10-07 09:00:00');
  assert.equal(h.sent[1].severity, 'CRITICAL');
});

test('different Message IDs at the same timestamp do not fabricate an inclination transition', () => {
  const h = harness();
  h.process({ time: '08:58:00', x: 0 });
  h.process({ time: '08:59:00', x: 0 });
  h.process({ time: '09:00:00', x: 0.8 });
  h.process({ time: '09:00:00', x: 0.8 });
  h.send();
  assert.equal(h.sent.length, 0, 'unique average is (0 + 0 + 0.8) / 3, below 0.5');
  h.tick();
  h.process({ time: '09:00:00', x: 0.8 });
  h.send();
  assert.equal(h.sent.length, 0);
});

test('a reused earlier row cannot override the last physical row at the same timestamp', () => {
  const h = harness({ ALERT_EMAIL_RECHECK_MINUTES: '1' });
  h.process({ x: 0.9 });
  h.send();
  const sample = h.reading({ x: 0 });
  // The writer may reuse an earlier blank, above an existing same-time row.
  h.sheetRows.unshift([sample.date, sample.time, sample.x, sample.y, sample.z, sample.battery]);
  h.context.processTelemetryForEmailAlerts_(sample);
  h.tick();
  assert.equal(h.sent.length, 1, 'a contradictory cached Normal must not restart the episode');
  h.advance(MINUTE);
  h.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].severity, 'CRITICAL');
});

test('a same-time critical payload written above the winning normal row sends no email', () => {
  const h = harness();
  h.process();
  const sample = h.reading({ battery: 9 });
  h.sheetRows.unshift([sample.date, sample.time, sample.x, sample.y, sample.z, sample.battery]);
  h.context.processTelemetryForEmailAlerts_(sample);
  h.send();
  h.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.context.diagnoseEmailAlertService().currentLevel, 'normal');
});
