const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const headers = ['Date', 'Time', 'X', 'Y', 'Z', 'Battery'];
function sample(index, x = 1) {
  const timestamp = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
  return [timestamp.slice(0, 10), timestamp.slice(11, 19), x, 0, 0, 13.2];
}
function harness(rows, sheetHeaders = headers) {
  const ranges = [];
  let opens = 0;
  const properties = { SENSOR_DATA_SHARED_SECRET: 'secret', SENSOR_SHEET_ID: 'sheet', SENSOR_SHEET_NAME: 'TWR-01' };
  const sheet = {
    getName: () => 'TWR-01', getLastRow: () => rows.length + 1, getLastColumn: () => sheetHeaders.length,
    getRange(start, column, count, width) {
      ranges.push({ start, column, count, width });
      return { getValues() {
        return [sheetHeaders, ...rows].slice(start - 1, start - 1 + count)
          .map(row => row.slice(column - 1, column - 1 + width));
      } };
    }
  };
  const context = vm.createContext({
    console: { error() {}, log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties[name] || null }) },
    SpreadsheetApp: { openById(id) {
      opens++;
      assert.equal(id, 'sheet');
      return {
        getSheetByName: name => name === 'TWR-01' ? sheet : null,
        getSheets: () => [sheet], getSpreadsheetTimeZone: () => 'Asia/Ho_Chi_Minh'
      };
    } },
    Session: { getScriptTimeZone: () => 'Asia/Ho_Chi_Minh' },
    Utilities: { formatDate(value, _zone, format) {
      const local = new Date(value.getTime() + 7 * 3600_000).toISOString();
      return format === 'yyyy-MM-dd' ? local.slice(0, 10) : local.slice(11, 19);
    } },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: content => ({
      setMimeType() { return this; }, getContent: () => content
    }) },
    UrlFetchApp: { fetch() { throw new Error('Read requests must never send email'); } },
    LockService: { getScriptLock() { throw new Error('Read requests must not acquire the ingestion lock'); } }
  });
  vm.runInContext(source, context, { filename: 'Code.gs' });
  return {
    ranges, properties, get opens() { return opens; },
    read(payload = { token: 'secret', towerId: 'TWR-01' }) {
      return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
    }
  };
}

test('reads the latest 20000 valid timestamps across all chunks despite out-of-order rows', () => {
  const rows = Array.from({ length: 20030 }, (_, index) => sample(index)).reverse();
  rows.push(sample(20029, 9), sample(30, 11), ['2030-01-01', '00:00:00', 'invalid', 0, 0, 13.2]);
  rows.push(['', '', '', '', '', '']);
  const h = harness(rows);
  const result = h.read();
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 20000);
  assert.deepEqual(result.data[0], { Date: '2026-01-01', Time: '00:30:00', X: 11, Y: 0, Z: 0, Battery: 13.2 });
  assert.deepEqual(result.data.at(-1), { Date: '2026-01-14', Time: '21:49:00', X: 9, Y: 0, Z: 0, Battery: 13.2 });
  assert.equal(result.meta.rejected, 1);
  assert.equal(result.meta.towerId, 'TWR-01');
  assert.equal(result.meta.truncated, true);
  assert.ok(h.ranges.some(range => range.start > 20001), 'rows after the former hard cutoff are read');
  assert.ok(h.ranges.every(range => range.count <= 20000), 'bulk reads stay bounded');
});

test('newer readings appended beyond the previous cutoff replace the oldest retained timestamps', () => {
  const h = harness(Array.from({ length: 40001 }, (_, index) => sample(index)));
  const result = h.read();
  assert.equal(result.data.length, 20000);
  assert.deepEqual(result.data[0], { Date: '2026-01-14', Time: '21:21:00', X: 1, Y: 0, Z: 0, Battery: 13.2 });
  assert.deepEqual(result.data.at(-1), { Date: '2026-01-28', Time: '18:40:00', X: 1, Y: 0, Z: 0, Battery: 13.2 });
  assert.equal(result.meta.omitted, 20001);
  assert.equal(result.meta.truncated, true);
  assert.ok(h.ranges.length <= 4, 'one header read and bulk data reads avoid excess Sheet round trips');
});

test('last valid physical duplicate wins and an invalid later row cannot hide it', () => {
  const h = harness([sample(2, 3), sample(0, 1), sample(2, 7), sample(2, 'invalid'), sample(1, 2)]);
  const result = h.read();
  assert.deepEqual(result.data.map(row => row.X), [1, 2, 7]);
  assert.equal(result.meta.rejected, 1);
  assert.equal(result.meta.truncated, false);
});

test('duplicate rows beyond the physical 20000-row boundary do not mark history as truncated', () => {
  const rows = Array.from({ length: 20000 }, (_, index) => sample(index));
  rows.push(sample(100, 4), sample(19999, 5));
  const result = harness(rows).read();
  assert.equal(result.data.length, 20000);
  assert.equal(result.meta.omitted, 2);
  assert.equal(result.meta.truncated, false);
  assert.equal(result.data[100].X, 4);
  assert.equal(result.data.at(-1).X, 5);
});

test('data reads include only the necessary column span while reordered headers remain supported', () => {
  const sheetHeaders = ['Notes', 'Battery', 'Y', 'Date', 'Z', 'Time', 'X', ...Array(100).fill('Unused')];
  const h = harness([['ignored', '13,2', 2, '07/10/2026', 3, '09:00', 1]], sheetHeaders);
  const result = h.read();
  assert.deepEqual(result.data, [{ Date: '2026-10-07', Time: '09:00:00', X: 1, Y: 2, Z: 3, Battery: 13.2 }]);
  assert.ok(h.ranges.filter(range => range.start > 1).every(range => range.column === 2 && range.width === 6));
  assert.ok(h.ranges.some(range => range.start > 1), 'header and data reads are separate');
});

test('unauthorized reads never open Sheets and missing tower or headers retain explicit error codes', () => {
  const h = harness([sample(1)]);
  assert.equal(h.read({ token: 'wrong', towerId: 'TWR-01' }).errorCode, 'UNAUTHORIZED');
  assert.equal(h.opens, 0);
  assert.equal(h.read({ token: 'secret', towerId: 'TWR-02' }).errorCode, 'SHEET_NOT_FOUND');
  assert.equal(h.read({ token: 'secret', towerId: 'bad/name' }).errorCode, 'INVALID_TOWER_ID');
  assert.equal(harness([], ['Date', 'Time']).read().errorCode, 'INVALID_SHEET_HEADERS');
});

test('fallback requests, empty sheets, and native Sheet dates and numeric times still normalize', () => {
  assert.deepEqual(harness([]).read({ token: 'secret' }).data, []);
  const h = harness([[new Date('2026-10-06T17:00:00Z'), 0.375, 1, 2, 3, 13.2]]);
  assert.deepEqual(h.read().data, [{ Date: '2026-10-07', Time: '09:00:00', X: 1, Y: 2, Z: 3, Battery: 13.2 }]);
});
