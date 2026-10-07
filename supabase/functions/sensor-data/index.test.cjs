const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

// Execute the actual Edge handler without network access or a Deno installation.
const source = stripTypeScriptTypes(
  fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
    .replace(/^import .*createClient.*;\r?\n/, ''),
  { mode: 'strip' }
);
const sample = (x = 1) => ({ Date: '2026-10-07', Time: '09:00:00', X: x, Y: 0, Z: 0, Battery: 13.2 });
const upstream = (data = [sample()], towerId = 'TWR-01', truncated = false) => new Response(JSON.stringify({
  ok: true, data, meta: { towerId, truncated }
}));

function harness() {
  let handler;
  let now = Date.parse('2026-10-07T02:00:00Z');
  let timerSequence = 0;
  let fetchHandler = async () => upstream();
  const timers = new Map();
  const requests = [];
  const users = new Map([['owner', 'owner'], ['operator', 'operator'], ['viewer', 'viewer']]);
  const authCalls = [];
  const roleCalls = [];
  const env = {
    SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    GOOGLE_APPS_SCRIPT_URL: 'https://script.google.com/macros/s/deployment-one/exec',
    GOOGLE_APPS_SCRIPT_SHARED_SECRET: 'secret-one',
    SENSOR_DATA_ALLOWED_ORIGINS: 'https://tower.example,https://other.example'
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    Date: ClockDate, Request, Response, Headers, AbortController, DOMException,
    console: { error() {} },
    Deno: { env: { get: key => env[key] }, serve: value => { handler = value; } },
    createClient() {
      return {
        auth: { async getUser(jwt) {
          authCalls.push(jwt);
          return users.has(jwt) ? { data: { user: { id: jwt } }, error: null }
            : { data: { user: null }, error: new Error('Invalid token') };
        } },
        from(table) {
          assert.equal(table, 'profiles');
          return { select(columns) {
            assert.equal(columns, 'role');
            return { eq(column, id) {
              assert.equal(column, 'id');
              return { async maybeSingle() {
                roleCalls.push(id);
                return { data: { role: users.get(id) }, error: null };
              } };
            } };
          } };
        }
      };
    },
    fetch(url, options) {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return fetchHandler(url, options);
    },
    setTimeout(callback, delay) {
      const id = ++timerSequence;
      timers.set(id, { due: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, context, { filename: 'index.ts' });
  return {
    env, users, requests, authCalls, roleCalls,
    respond(callback) { fetchHandler = callback; },
    async settle() { await new Promise(setImmediate); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.due <= now) { timers.delete(id); timer.callback(); }
      }
    },
    request(towerId, jwt = 'owner', origin = 'https://tower.example') {
      const payload = arguments.length === 0 ? { towerId: 'TWR-01' }
        : towerId === undefined ? {} : { towerId };
      return handler(new Request('https://project.supabase.co/functions/v1/sensor-data', {
        method: 'POST', headers: { origin, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }));
    }
  };
}

test('authorized overlapping reads share one upstream execution and each receives its data', async () => {
  const h = harness();
  let release;
  h.respond(() => new Promise(resolve => { release = resolve; }));
  const first = h.request();
  await h.settle();
  const second = h.request('TWR-01', 'operator', 'https://other.example');
  await h.settle();
  assert.equal(h.requests.length, 1);
  release(upstream());
  const responses = await Promise.all([first, second]);
  assert.deepEqual((await responses[0].json()).data, [sample()]);
  assert.deepEqual((await responses[1].json()).data, [sample()]);
  assert.equal(responses[0].headers.get('access-control-allow-origin'), 'https://tower.example');
  assert.equal(responses[1].headers.get('access-control-allow-origin'), 'https://other.example');
  assert.deepEqual(h.authCalls, ['owner', 'operator']);
  assert.deepEqual(h.roleCalls, ['owner', 'operator']);
});

test('successful reads are briefly cached but every hit still authenticates and checks the current role', async () => {
  const h = harness();
  await h.request();
  const response = await h.request();
  assert.deepEqual((await response.json()).data, [sample()]);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.authCalls, ['owner', 'owner']);
  assert.deepEqual(h.roleCalls, ['owner', 'owner']);
  h.users.set('owner', 'viewer');
  assert.equal((await h.request()).status, 403);
  assert.equal((await h.request('TWR-01', 'expired')).status, 401);
  assert.equal((await h.request('TWR-01', 'operator', 'https://evil.example')).status, 403);
  assert.equal(h.requests.length, 1);
});

test('cache entries expire and a later read returns new upstream measurements', async () => {
  const h = harness();
  await h.request();
  h.advance(3500);
  h.respond(async () => upstream([sample(2)]));
  const result = await (await h.request()).json();
  assert.deepEqual(result.data, [sample(2)]);
  assert.equal(h.requests.length, 2);
});

test('tower IDs, fallback requests, and changed upstream configuration never share cached data', async () => {
  const h = harness();
  h.respond(async (_url, options) => {
    const { towerId, token } = JSON.parse(options.body);
    return upstream([sample(towerId === 'TWR-01' ? token === 'secret-one' ? 1 : 3 : 2)], towerId || 'Fallback');
  });
  assert.equal((await (await h.request()).json()).data[0].X, 1);
  assert.equal((await (await h.request('twr-01')).json()).data[0].X, 2);
  assert.equal((await (await h.request(undefined)).json()).meta.towerId, 'Fallback');
  assert.equal((await (await h.request(null)).json()).ok, false);
  h.env.GOOGLE_APPS_SCRIPT_SHARED_SECRET = 'secret-two';
  assert.equal((await (await h.request()).json()).data[0].X, 3);
  h.env.GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/deployment-two/exec';
  assert.equal((await h.request()).status, 200);
  h.env.SUPABASE_URL = 'https://other-project.supabase.co';
  assert.equal((await h.request()).status, 200);
  h.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-two';
  assert.equal((await h.request()).status, 200);
  assert.equal(h.requests.length, 7);
  assert.equal(h.requests[6].url, h.env.GOOGLE_APPS_SCRIPT_URL);
});

test('upstream errors and malformed or invalid payloads never poison a later read', async () => {
  const failures = [
    () => new Response('busy', { status: 503 }),
    () => new Response('<html>invalid</html>'),
    () => new Response(JSON.stringify({ ok: false, errorCode: 'SHEET_NOT_FOUND', error: 'Missing' })),
    () => upstream([{ ...sample(), Date: 'invalid' }]),
    () => upstream(Array.from({ length: 20001 }, () => sample()))
  ];
  for (const failure of failures) {
    const h = harness();
    h.respond(async () => failure());
    assert.notEqual((await h.request()).status, 200);
    h.respond(async () => upstream([sample(2)]));
    assert.deepEqual((await (await h.request()).json()).data, [sample(2)]);
    assert.equal(h.requests.length, 2);
  }
});

test('an upstream request may finish after 10 seconds but a 25-second timeout returns a distinct error', async () => {
  const h = harness();
  h.respond((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const pending = h.request();
  await h.settle();
  h.advance(11000);
  assert.equal(h.requests[0].options.signal.aborted, false);
  h.advance(15000);
  const response = await pending;
  assert.equal(response.status, 504);
  assert.equal((await response.json()).errorCode, 'UPSTREAM_TIMEOUT');
  h.respond(async () => upstream());
  assert.equal((await h.request()).status, 200);
  assert.equal(h.requests.length, 2);
});

test('a failed shared read is removed so the next request can recover without automatic POST retries', async () => {
  const h = harness();
  let release;
  h.respond(() => new Promise(resolve => { release = resolve; }));
  const first = h.request();
  await h.settle();
  const second = h.request();
  await h.settle();
  assert.equal(h.requests.length, 1);
  release(new Response('busy', { status: 503 }));
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [502, 502]);
  h.respond(async () => upstream());
  assert.equal((await h.request()).status, 200);
  assert.equal(h.requests.length, 2);
});

test('retained cache entries are bounded and old towers are fetched again after eviction', async () => {
  const h = harness();
  for (let index = 0; index < 5; index++) await h.request(`TWR-${index}`);
  await h.request('TWR-4');
  assert.equal(h.requests.length, 5, 'the newest tower is cached');
  await h.request('TWR-0');
  assert.equal(h.requests.length, 6, 'the oldest tower was evicted');
});

test('concurrent different towers keep separate upstream requests and payloads', async () => {
  const h = harness();
  const releases = new Map();
  h.respond((_url, options) => new Promise(resolve => { releases.set(JSON.parse(options.body).towerId, resolve); }));
  const first = h.request('TWR-01');
  const second = h.request('TWR-02');
  await h.settle();
  assert.equal(h.requests.length, 2);
  releases.get('TWR-02')(upstream([sample(2)], 'TWR-02'));
  releases.get('TWR-01')(upstream([sample(1)], 'TWR-01'));
  assert.equal((await (await first).json()).data[0].X, 1);
  assert.equal((await (await second).json()).data[0].X, 2);
});

test('retained payload storage is bounded independently of the entry count', async () => {
  const h = harness();
  h.respond(async (_url, options) => upstream(Array.from({ length: 20000 }, () => sample(1)), JSON.parse(options.body).towerId));
  for (const tower of ['TWR-A', 'TWR-B', 'TWR-C']) {
    await h.request(tower);
    await h.request(tower);
  }
  assert.equal(h.requests.length, 3, 'each successful payload is cached initially');
  await h.request('TWR-A');
  assert.equal(h.requests.length, 4, 'large payloads evict older data before four entries accumulate');
});

test('in-flight bookkeeping stays bounded while overflow requests still complete', async () => {
  const h = harness();
  const releases = [];
  h.respond((_url, options) => new Promise(resolve => { releases.push(() => resolve(upstream([], JSON.parse(options.body).towerId))); }));
  const pending = Array.from({ length: 17 }, (_, index) => h.request(`TWR-${index}`));
  await h.settle();
  pending.push(h.request('TWR-0'), h.request('TWR-16'));
  await h.settle();
  assert.equal(h.requests.length, 18, 'tracked towers share a read; overflow keys are not retained');
  for (const release of releases) release();
  assert.ok((await Promise.all(pending)).every(response => response.status === 200));
});

test('the response preserves the upstream history limit flag without deriving it from duplicates', async () => {
  const h = harness();
  h.respond(async () => upstream([sample()], 'TWR-01', true));
  assert.equal((await (await h.request()).json()).meta.truncated, true);
  assert.equal((await (await h.request()).json()).meta.truncated, true, 'cache hits preserve the flag');
  h.advance(3500);
  h.respond(async () => new Response(JSON.stringify({ ok: true, data: [sample()], meta: { towerId: 'TWR-01', omitted: 3, truncated: false } })));
  assert.equal((await (await h.request()).json()).meta.truncated, false);
});
