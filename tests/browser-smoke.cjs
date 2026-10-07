// Optional full DOM smoke: node tests/browser-smoke.cjs [path-to-playwright]
// All external calls are intercepted; no real accounts, Sheets, or emails.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.argv[2] || 'playwright');
const root = path.resolve(__dirname, '..');
const sdk = `export function createClient() {
  return { auth: {
    async getUser() { return { data: { user: { id: 'smoke-user' } } }; },
    async getSession() { return { data: { session: { access_token: 'smoke-token' } } }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async signOut() { return {}; }
  }, from() { return { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { id: 'smoke-user', username: 'smoke', display_name: 'Smoke Test', role: 'operator' } }; }
  }; } };
}`;
new (require('node:vm').Script)(sdk.replace('export function', 'function'));
const initialRows = [
  { Date: '2026-10-07', Time: '10:08:10', X: 2.65, Y: 3.76, Z: .79, Battery: 13.41 },
  { Date: '2026-10-07', Time: '10:08:20', X: 2.79, Y: 3.79, Z: .81, Battery: 13.41 },
  { Date: '2026-10-07', Time: '10:08:30', X: 2.84, Y: 3.82, Z: .86, Battery: 13.41 }
];

(async () => {
  const server = http.createServer(async (request, response) => {
    const file = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep) || !/\.(html|js|css|png|jpg|svg)$/.test(file)) {
      response.writeHead(404).end(); return;
    }
    try {
      response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      response.end(await fs.readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  let browser;
  let page;
  const consoleErrors = [];
  const errors = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.argv[3] || undefined });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    await context.addInitScript(() => {
      localStorage.setItem('tower-monitor.tower-registry.v1', JSON.stringify({ version: 1, towers: [
        { id: 'TWR-01', name: 'Trạm 1', location: 'Test', addedAt: '2026-10-07T00:00:00Z' },
        { id: 'TWR-02', name: 'Trạm 2', location: 'Test', addedAt: '2026-10-07T00:00:01Z' }
      ] }));
    });
    let releaseInitial;
    const initialGate = new Promise(resolve => { releaseInitial = resolve; });
    let rows = initialRows;
    let fail = false;
    const calls = [];
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith(origin)) return route.continue();
      if (url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/')) {
        return route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: sdk });
      }
      if (url.includes('/functions/v1/sensor-data')) {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204,
          headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
        const towerId = route.request().postDataJSON().towerId;
        calls.push(towerId);
        if (calls.length === 1) await initialGate;
        const data = towerId === 'TWR-02' ? [{ Date: '2026-10-07', Time: '10:08:30', X: 0, Y: 0, Z: 0, Battery: 12.5 }] : rows;
        return route.fulfill({ status: fail ? 502 : 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify(fail ? { ok: false, error: 'Sensor data source is unavailable.' }
            : { ok: true, data, meta: { towerId, generatedAt: new Date().toISOString() } }) });
      }
      // Fonts and unrelated CDNs are intentionally offline in this smoke run.
      return route.fulfill({ contentType: 'text/css', body: '' });
    });
    page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#towerSelect')?.value === 'TWR-01');
    for (const view of ['List', 'Alerts', 'Towers']) {
      await page.locator(`[data-nav-target="${view}"]`).first().click();
    }
    releaseInitial();
    await page.waitForFunction(() => document.querySelector('#towerCurrentX')?.textContent === '2.76°');
    assert.equal(calls.length, 1, 'first load and navigation must share one source request');
    await page.locator('[data-nav-target="Alerts"]').first().click();
    assert.equal(await page.locator('#alertsTableBody > tr:not(.alerts-detail-row)').count(), 1);
    await page.locator('[data-nav-target="List"]').first().click();
    assert.equal(await page.locator('#sensorTableBody > tr').count(), 3);

    rows = [...rows, { Date: '2026-10-07', Time: '10:08:40', X: 3.12, Y: 3.88, Z: .92, Battery: 13.40 }];
    // Wait on the actual 15-second poll, with no MQTT or manual navigation.
    await page.waitForFunction(() => document.querySelector('#sensorTableBody')?.textContent.includes('10:08:40'), null, { timeout: 25000 });
    await page.locator('[data-nav-target="Towers"]').first().click();
    await page.waitForFunction(() => document.querySelector('#towerCurrentX')?.textContent === '2.92°');

    fail = true;
    await page.locator('#towerRefreshButton').click();
    await page.waitForFunction(() => !document.querySelector('#towerErrorBanner').hidden);
    assert.equal(await page.locator('#towerCurrentX').textContent(), '2.92°');
    fail = false;
    await page.locator('#towerRefreshButton').click();
    await page.waitForFunction(() => document.querySelector('#towerErrorBanner').hidden);
    await page.locator('#towerSelect').selectOption('TWR-02');
    await page.waitForFunction(() => document.querySelector('#towerCurrentBattery')?.textContent === '12.50 V');
    assert.equal(await page.locator('#towerCurrentX').textContent(), '0.00°');
    await page.locator('#towerSelect').selectOption('TWR-01');
    await page.waitForFunction(() => document.querySelector('#towerCurrentX')?.textContent === '2.92°');
    assert.deepEqual(errors, []);
    console.log('BROWSER_SMOKE_OK: first load, navigation, polling, stale retention, recovery, tower switching; source requests=' + calls.length);
  } catch (error) {
    console.error('BROWSER_DIAGNOSTICS', consoleErrors);
    console.error('BROWSER_PAGE', page?.url());
    console.error('BROWSER_ERRORS', errors);
    console.error('BROWSER_STATE', await page?.evaluate(() => ({ ready: document.readyState,
      auth: document.documentElement.className, towerOptions: document.querySelector('#towerSelect')?.innerHTML,
      modules: [...document.querySelectorAll('script')].map(script => script.src) })));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
