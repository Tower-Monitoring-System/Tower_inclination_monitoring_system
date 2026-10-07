const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('https://cdn.jsdelivr.net/npm/@supabase/')) {
      return { url: 'test:supabase-sdk', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === 'test:supabase-sdk') return { format: 'module', shortCircuit: true,
      source: 'export function createClient() { throw new Error("Provide a test auth client"); }' };
    return next(url, context);
  }
});
const serviceModule = import(pathToFileURL(path.resolve('js/services/sensorDataService.js')).href);
const flush = () => new Promise(resolve => setImmediate(resolve));
const row = (time = '10:08:30', x = 2.84) => ({ Date: '2026-10-07', Time: time, X: x, Y: 3.82, Z: .86, Battery: 13.41 });
const response = (data = [row()], status = 200) => ({ ok: status === 200, status,
  async json() { return status === 200 ? { ok: true, data, meta: { towerId: 'TWR-01' } }
    : { ok: false, error: 'Sensor data source is unavailable.' }; } });

async function harness(fetchImpl) {
  const { SensorDataService } = await serviceModule;
  const timers = new Map();
  let sequence = 0;
  const documentRef = new EventTarget();
  documentRef.hidden = false;
  const windowRef = new EventTarget();
  Object.assign(windowRef, { console: { log() {}, error() {}, warn() {} }, AbortController, setTimeout(fn, ms) { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  global.window = windowRef;
  global.document = documentRef;
  const calls = [];
  const service = new SensorDataService({ windowRef, documentRef,
    client: { auth: { async getSession() { return { data: { session: { access_token: 'test-token' } } }; } } },
    config: { edgeFunctionName: 'sensor-data', requestTimeoutMs: 35000, pollingIntervalMs: 15000,
      cacheTtlMs: 15000, maximumRecords: 20000 },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return fetchImpl ? fetchImpl(url, options) : response(); } });
  return { service, calls, timers, windowRef, documentRef,
    async runTimer(ms) { const found = [...timers.entries()].find(([, value]) => value.ms === ms);
      assert.ok(found, `expected a ${ms}ms scheduled update`); timers.delete(found[0]); found[1].fn(); await flush(); } };
}

test('same tower concurrent requests share transport and a later navigation uses cached data', async t => {
  const h = await harness(); t.after(() => h.service.destroy());
  const [a, b] = await Promise.all([h.service.fetchReadings({ towerId: 'TWR-01' }), h.service.fetchReadings({ towerId: 'TWR-01' })]);
  const c = await h.service.fetchReadings({ towerId: 'TWR-01' });
  assert.equal(h.calls.length, 1);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(c.readings[0].x, 2.84);
});

test('closing one page only cancels its wait and reopening receives the ongoing shared load', async t => {
  let resolveFetch;
  const h = await harness(() => new Promise(resolve => { resolveFetch = resolve; }));
  t.after(() => h.service.destroy());
  const controller = new AbortController();
  const closingPage = h.service.fetchReadings({ towerId: 'TWR-01', signal: controller.signal });
  const otherPage = h.service.fetchReadings({ towerId: 'TWR-01' });
  await flush(); controller.abort();
  const reopening = h.service.fetchReadings({ towerId: 'TWR-01' });
  assert.equal(h.calls[0].options.signal.aborted, false, 'a view cannot cancel shared transport');
  await assert.rejects(closingPage, { name: 'AbortError' });
  resolveFetch(response());
  assert.equal((await otherPage).readings.length, 1);
  assert.equal((await reopening).readings.length, 1);
  assert.equal(h.calls.length, 1);
});

test('different tower loads do not abort or mix each other', async t => {
  const h = await harness(async (_, options) => {
    await flush();
    if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return response([row('10:08:30', JSON.parse(options.body).towerId === 'TWR-01' ? 1 : 2)]);
  });
  t.after(() => h.service.destroy());
  const [a, b] = await Promise.all(['TWR-01', 'TWR-02'].map(towerId => h.service.fetchReadings({ towerId })));
  assert.equal(a.readings[0].x, 1); assert.equal(b.readings[0].x, 2);
});

test('manual refresh bypasses cache and failed refresh cannot replace the valid snapshot', async t => {
  let status = 200;
  const h = await harness(() => response([row()], status)); t.after(() => h.service.destroy());
  const first = await h.service.fetchReadings({ towerId: 'TWR-01' });
  const updates = [];
  h.service.subscribe('TWR-01', update => updates.push(update));
  status = 502;
  await assert.rejects(h.service.fetchReadings({ towerId: 'TWR-01', force: true }), { status: 502 });
  assert.equal(updates.at(-1).result, first);
  status = 200;
  const next = await h.service.fetchReadings({ towerId: 'TWR-01', force: true });
  assert.equal(next.readings, first.readings, 'unchanged data preserves array identity for derived caches');
});

test('shared subscriptions continuously publish new readings without MQTT or page navigation', async t => {
  let data = [row()];
  const h = await harness(() => response(data)); t.after(() => h.service.destroy());
  const seen = [[], [], []];
  const cleanups = seen.map(updates => h.service.subscribe('TWR-01', update => updates.push(update)));
  await flush();
  assert.equal(h.calls.length, 1);
  seen.forEach(updates => assert.equal(updates.at(-1).result.readings.length, 1));
  data = [...data, row('10:08:40', 3)];
  await h.runTimer(15000);
  assert.equal(h.calls.length, 2);
  seen.forEach(updates => assert.equal(updates.at(-1).result.readings.length, 2));
  cleanups.forEach(cleanup => cleanup());
  assert.equal(h.timers.size, 0);
});

test('initial upstream failure automatically recovers with backoff and no click', async t => {
  let attempts = 0;
  const h = await harness(() => response([row()], ++attempts === 1 ? 502 : 200));
  t.after(() => h.service.destroy());
  const updates = [];
  h.service.subscribe('TWR-01', update => updates.push(update));
  await flush(); assert.equal(updates.at(-1).error.status, 502);
  await h.runTimer(2000);
  assert.equal(updates.at(-1).result.readings[0].x, 2.84);
});

test('hidden tab pauses polling and visibility or online resumes with one fresh load', async t => {
  const h = await harness(); t.after(() => h.service.destroy());
  h.service.subscribe('TWR-01', () => {}); await flush();
  h.documentRef.hidden = true; h.documentRef.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.timers.size, 0);
  h.documentRef.hidden = false; h.documentRef.dispatchEvent(new Event('visibilitychange'));
  h.windowRef.dispatchEvent(new Event('online')); await flush();
  assert.equal(h.calls.length, 2);
});

test('destroy cancels owned transport and removes monitoring timers', async () => {
  const h = await harness((_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort',
    () => reject(options.signal.reason), { once: true })));
  const pending = h.service.fetchReadings({ towerId: 'TWR-01' }); await flush();
  h.service.destroy();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.timers.size, 0);
});

function pageDocument(h) {
  const nodes = new Map();
  function node() {
    const value = new EventTarget();
    return Object.assign(value, { value: '', dataset: {}, hidden: false, textContent: '',
      classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, append() {},
      replaceChildren() {}, getContext() { return null; } });
  }
  return Object.assign(h.documentRef, { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    querySelectorAll() { return []; }, createDocumentFragment: node, createElement: node });
}

async function pages(h) {
  const [list, alerts, towers, alertService, history] = await Promise.all([
    import(pathToFileURL(path.resolve('js/pages/listPage.js')).href),
    import(pathToFileURL(path.resolve('js/pages/alertsPage.js')).href),
    import(pathToFileURL(path.resolve('js/pages/towersPage.js')).href),
    import(pathToFileURL(path.resolve('js/services/alertService.js')).href),
    import(pathToFileURL(path.resolve('js/services/towerHistoryService.js')).href),
  ]);
  // Keep controller/data processing real; rendering is covered by browser smoke.
  class List extends list.ListPage { render() {} }
  class Alerts extends alerts.AlertsPage { render() {} }
  class Towers extends towers.TowersPage { render() {} }
  const towerRegistryService = { getState: () => ({ towers: [{ id: 'TWR-01', name: 'Trạm 1' }], initialized: true }), subscribe: () => () => {} };
  const options = { documentRef: pageDocument(h), windowRef: h.windowRef, towerRegistryService };
  const listPage = new List(h.service, options);
  const alertsPage = new Alerts(new alertService.AlertService(h.service), { ...options, monitorWhenInactive: true });
  const towersPage = new Towers({ ...options, historyService: new history.TowerHistoryService(h.service) });
  return { listPage, alertsPage, towersPage, destroy() { listPage.destroy(); alertsPage.destroy(); towersPage.destroy(); } };
}

test('first Towers load and inactive Alerts share data without first visiting List', async t => {
  const h = await harness(); const p = await pages(h);
  t.after(() => { p.destroy(); h.service.destroy(); });
  p.towersPage.open(); await flush();
  assert.equal(p.towersPage.currentReadings().at(-1).x, 2.84);
  assert.equal(p.alertsPage.alerts.length, 1);
  assert.equal(p.listPage.records.length, 1, 'inactive view adopts the shared snapshot');
  assert.equal(h.calls.length, 1);
});

test('switching Towers to List to Alerts during a slow request never aborts the source', async t => {
  let resolveFetch;
  const h = await harness(() => new Promise(resolve => { resolveFetch = resolve; }));
  const p = await pages(h); t.after(() => { p.destroy(); h.service.destroy(); });
  p.towersPage.open(); await flush(); p.towersPage.close(); p.listPage.open(); p.listPage.close(); p.alertsPage.open();
  resolveFetch(response()); await flush(); p.towersPage.open(); await flush();
  assert.equal(p.towersPage.currentReadings().length, 1);
  assert.equal(p.alertsPage.alerts.length, 1);
  assert.equal(p.listPage.records.length, 1);
  assert.equal(h.calls.length, 1);
});

test('Towers stays fresh after its initial load while another page is active', async t => {
  let data = [row()];
  const h = await harness(() => response(data)); const p = await pages(h);
  t.after(() => { p.destroy(); h.service.destroy(); });
  p.towersPage.open(); await flush(); p.towersPage.close(); p.listPage.open(); await flush();
  data = [...data, row('10:08:40', 3.12)]; await h.runTimer(15000);
  assert.equal(p.towersPage.currentReadings().at(-1).x, 3.12);
  assert.equal(p.listPage.records.length, 2);
  p.towersPage.open(); await flush(); assert.equal(h.calls.length, 2);
});

test('a failed update keeps readings and its error visible when reopening a cached page', async t => {
  let status = 200;
  const h = await harness(() => response([row()], status)); const p = await pages(h);
  t.after(() => { p.destroy(); h.service.destroy(); });
  p.towersPage.open(); await flush(); status = 502;
  await h.service.fetchReadings({ towerId: 'TWR-01', force: true }).catch(() => {});
  p.listPage.open(); await flush();
  assert.equal(p.listPage.records.length, 1);
  assert.ok(p.listPage.error, 'cached data must not hide a known outage');
  assert.equal(p.towersPage.currentReadings().length, 1);
});

test('an authorization failure does not repeatedly retry in the background', async t => {
  const h = await harness(() => response([], 403)); t.after(() => h.service.destroy());
  const updates = [];
  h.service.subscribe('TWR-01', update => updates.push(update)); await flush();
  assert.equal(updates.at(-1).error.status, 403);
  assert.equal(h.timers.size, 0, 'access denial needs authentication, not automatic retries');
});

test('removing and re-adding a tower restores unchanged cached history', async t => {
  const h = await harness(); const p = await pages(h);
  t.after(() => { p.destroy(); h.service.destroy(); });
  p.towersPage.open(); await flush();
  p.towersPage.handleRegistryState({ towers: [], initialized: true });
  p.towersPage.handleRegistryState({ towers: [{ id: 'TWR-01', name: 'Trạm 1' }], initialized: true });
  await flush();
  assert.equal(p.towersPage.currentReadings().length, 1);
  assert.equal(p.towersPage.currentReadings()[0].x, 2.84);
});

test('a missing Sheet preserves valid List and Alerts history during a failed refresh', async t => {
  let status = 200;
  const h = await harness(() => response([row()], status)); const p = await pages(h);
  t.after(() => { p.destroy(); h.service.destroy(); });
  p.towersPage.open(); await flush(); status = 404;
  await Promise.all([p.listPage.refresh(), p.alertsPage.refresh()]);
  assert.equal(p.listPage.records.length, 1);
  assert.equal(p.alertsPage.alerts.length, 1);
  assert.ok(p.listPage.error); assert.ok(p.alertsPage.error);
});

test('cached tower calculations follow settings, date filters and new measurements', async t => {
  let data = [row()];
  const h = await harness(() => response(data)); const p = await pages(h);
  t.after(() => { p.destroy(); h.service.destroy(); });
  p.towersPage.open(); await flush();
  const first = p.towersPage.getViewModel();
  assert.ok(Math.abs(first.latest.x - 2.84) < 1e-9);
  assert.equal(p.towersPage.getViewModel(), first, 'unchanged renders reuse orientation calculations');
  p.towersPage.settingsService = { getAlertConfiguration: () => ({
    calibration: { x: 2.84, y: 3.82, z: .86 },
    inclination: { x: .5, y: .5, z: .5, criticalMultiplier: 1.5 },
    battery: { warning: 12.8, critical: 10 }
  }) };
  assert.equal(p.towersPage.getViewModel().status, 'normal');
  p.towersPage.day = '2026-10-06';
  assert.equal(p.towersPage.getViewModel().latest, null);
  p.towersPage.day = '2026-10-07';
  data = [...data, row('10:08:40', 4)]; await h.runTimer(15000);
  assert.ok(Math.abs(p.towersPage.getViewModel().latest.x - 3.42) < 1e-9);
  assert.equal(p.towersPage.getViewModel().status, 'warning');
});
