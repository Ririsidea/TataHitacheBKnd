// The error contract: every error is { success:false, message, requestId } with a status from
// 200/201 (success) or 400, 401, 404, 409, 429, 500, 502 (errors) - never 207, 403, 410 or 503 -
// and server-side problems are answered with a generic 500 while being logged and alerted.
process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';
process.env.MAP_API_KEY = 'test-key';
process.env.JWT_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = 'admin@test.co';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');
const express = require('express');
const jwt = require('jsonwebtoken');
const { map } = require('../src/config/env');
const alert = require('../src/services/alert');
const shopify = require('../src/services/shopify/client');
const { Order, DailyExport } = require('../src/models');
const app = require('../src/app');
const requestId = require('../src/middleware/requestId');
const { classify } = require('../src/middleware/errorHandler');
const { ConfigError, GENERIC_MESSAGE, UNAVAILABLE_MESSAGE, CLIENT_STATUSES } = require('../src/utils/errors');

const GENERIC = 'Something went wrong. Please try again later.';
const KEY = { 'x-api-key': 'test-key' };
const token = (email) => jwt.sign({ userId: 1, email }, 'test-secret');

// Runs `fn(baseUrl)` against an ephemeral server for `application`.
async function serve(application, fn) {
  const server = http.createServer(application);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
async function call(path, { headers = {}, method = 'GET', body } = {}) {
  return serve(app, async (base) => {
    const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body });
    return { status: res.status, headers: res.headers, body: await res.json() };
  });
}
const quiet = (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
};
const alerts = (t) => t.mock.method(alert, 'alertServerError', async () => {});

function assertError(res, status, message) {
  assert.equal(res.status, status);
  assert.equal(res.body.success, false);
  if (message !== undefined) assert.equal(res.body.message, message);
  assert.match(res.body.requestId, /^[A-Za-z0-9._-]{8,64}$/, 'requestId in the body');
  assert.equal(res.headers.get('x-request-id'), res.body.requestId, 'the same id in the X-Request-Id header');
}

// ---- requestId ---------------------------------------------------------------------------------------
test('every error carries a requestId (body + header): 404 route, 401 key, 400 input', async (t) => {
  quiet(t);
  assertError(await call('/api/no-such-route'), 404);
  assertError(await call('/api/map/stock'), 401, 'API key required');
  assertError(await call('/api/map/stock', { headers: { 'x-api-key': 'wrong' } }), 401, 'Invalid API key');
  assertError(await call('/api/map/stock?limit=0', { headers: KEY }), 400);
  assertError(await call('/api/auth/me'), 401);
});

test('a caller-supplied X-Request-Id is kept when it looks like an id, otherwise replaced', async (t) => {
  quiet(t);
  const kept = await call('/api/no-such-route', { headers: { 'x-request-id': 'support-ticket-42' } });
  assert.equal(kept.body.requestId, 'support-ticket-42');
  for (const bad of ['short', 'has spaces in it', 'x'.repeat(65), 'bad/chars?']) {
    const res = await call('/api/no-such-route', { headers: { 'x-request-id': bad } });
    assert.notEqual(res.body.requestId, bad);
    assert.match(res.body.requestId, /^[0-9a-f-]{36}$/);
  }
});

test('a success response has no requestId in the body but still has the header', async () => {
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.requestId, undefined);
  assert.ok(res.headers.get('x-request-id'));
});

test('the requestId is written to the log with the failure', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const res = await call('/api/no-such-route', { headers: { 'x-request-id': 'trace-me-please' } });
  assert.equal(res.body.requestId, 'trace-me-please');
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes('[trace-me-please]')));
});

// ---- no 503: misconfiguration is a generic 500 that is logged and alerted -------------------------------
test('no MAP_API_KEY: 500 generic (never 503), the reason is alerted, nothing leaks', async (t) => {
  quiet(t);
  const alerted = alerts(t);
  const saved = map.apiKey;
  map.apiKey = undefined;
  try {
    const res = await call('/api/map/stock', { headers: KEY });
    assertError(res, 500, GENERIC);
    assert.ok(!JSON.stringify(res.body).includes('MAP_API_KEY'));
    assert.equal(alerted.mock.callCount(), 1);
    const arg = alerted.mock.calls[0].arguments[0];
    assert.match(arg.title, /MAP_API_KEY is not set/);
    assert.equal(arg.requestId, res.body.requestId);
  } finally {
    map.apiKey = saved;
  }
});

test('a missing webhook secret is a misconfiguration too', async (t) => {
  quiet(t);
  const alerted = alerts(t);
  const { shopify: cfg } = require('../src/config/env');
  const saved = cfg.webhookSecret;
  cfg.webhookSecret = undefined;
  try {
    const res = await call('/orders/create', { method: 'POST', headers: { 'X-Shopify-Hmac-SHA256': 'x' }, body: '{}' });
    assertError(res, 500, GENERIC);
    assert.equal(alerted.mock.callCount(), 1);
  } finally {
    cfg.webhookSecret = saved;
  }
});

// ---- 500: unexpected failures never leak their cause ---------------------------------------------------------
test('an unexpected failure is a generic 500 with a requestId, logged and alerted', async (t) => {
  quiet(t);
  const alerted = alerts(t);
  t.mock.method(Order, 'findAndCountAll', async () => {
    throw new Error("SQL: SELECT secret FROM orders (password='hunter2')");
  });
  const res = await call('/api/dashboard/orders?email=a@b.co', { headers: KEY });
  assertError(res, 500, GENERIC);
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
  assert.equal(alerted.mock.callCount(), 1);
  assert.equal(alerted.mock.calls[0].arguments[0].requestId, res.body.requestId);
});

test('a malformed JSON body is a 400, not a 500', async (t) => {
  quiet(t);
  assertError(await call('/api/map/create-order', { method: 'POST', headers: KEY, body: '{ nope' }), 400, 'Invalid JSON body');
});

// ---- 502 only when Shopify is down ------------------------------------------------------------------------------
test('Shopify unreachable / erroring / throttling -> 502 with the standard message', async (t) => {
  quiet(t);
  alerts(t);
  const failures = [
    new axios.AxiosError('socket hang up', 'ECONNRESET'),
    Object.assign(new axios.AxiosError('bad gateway'), { response: { status: 502 } }),
    Object.assign(new axios.AxiosError('slow down'), { response: { status: 429 } }),
  ];
  for (const failure of failures) {
    const mocked = t.mock.method(shopify, 'listProductsCatalog', async () => { throw failure; });
    assertError(await call('/api/map/stock', { headers: KEY }), 502, UNAVAILABLE_MESSAGE);
    mocked.mock.restore();
  }
});

test('Shopify rejecting OUR credentials is our misconfiguration: 500 + alert, not a 502', async (t) => {
  quiet(t);
  const alerted = alerts(t);
  t.mock.method(shopify, 'listProductsCatalog', async () => { throw Object.assign(new axios.AxiosError('unauthorized'), { response: { status: 401 } }); });
  assertError(await call('/api/map/stock', { headers: KEY }), 500, GENERIC);
  assert.match(alerted.mock.calls[0].arguments[0].title, /Shopify rejected/);
});

// ---- no 403 / 410 -----------------------------------------------------------------------------------------------------
test('a signed-in non-admin calling an admin route gets 404, not 403', async (t) => {
  quiet(t);
  assertError(await call('/api/admin/employees', { headers: { authorization: `Bearer ${token('someone@test.co')}` } }), 404);
});

test("someone else's export answers 404, and a missing export file 404 (not 403 / 410)", async (t) => {
  quiet(t);
  t.mock.method(DailyExport, 'findByPk', async () => ({ id: 1, email: 'owner@test.co', fileName: 'nope-does-not-exist.csv' }));
  const other = { authorization: `Bearer ${token('intruder@test.co')}` };
  assertError(await call('/api/sap/daily-exports/1/view', { headers: other }), 404, 'Export not found');
  assertError(await call('/api/sap/daily-exports/1/download', { headers: other }), 404, 'Export not found');
  const owner = { authorization: `Bearer ${token('owner@test.co')}` };
  assertError(await call('/api/sap/daily-exports/1/view', { headers: owner }), 404, 'Export file is no longer available');
  assertError(await call('/api/sap/daily-exports/1/download', { headers: owner }), 404, 'Export file is no longer available');
});

// ---- the status whitelist is enforced mechanically ------------------------------------------------------------------------
test('a handler that tries a status outside the contract (403 / 410 / 503 / 207 error bodies) sends 500 instead', async (t) => {
  quiet(t);
  const probe = express();
  probe.use(requestId);
  for (const status of [403, 410, 422, 503]) probe.get(`/s${status}`, (req, res) => res.status(status).json({ success: false, message: `leak ${status}` }));
  probe.get('/ok', (req, res) => res.status(201).json({ success: true }));
  await serve(probe, async (base) => {
    for (const status of [403, 410, 422, 503]) {
      const res = await fetch(`${base}/s${status}`);
      const body = await res.json();
      assert.equal(res.status, 500, `status ${status}`);
      assert.equal(body.message, GENERIC);
      assert.ok(body.requestId);
    }
    assert.equal((await fetch(`${base}/ok`)).status, 201);
  });
});

test('the contract is exactly the agreed set', () => {
  assert.deepEqual([...CLIENT_STATUSES].sort((a, b) => a - b), [400, 401, 404, 409, 429, 500, 502]);
});

// ---- classify ---------------------------------------------------------------------------------------------------------------------
test('classify: deliberate 4xx keep their message; 502 is the standard message; everything else is a generic 500', () => {
  const err = (statusCode, message = 'msg') => Object.assign(new Error(message), { statusCode });
  for (const code of [400, 401, 404, 409, 429]) assert.deepEqual(classify(err(code, 'mine')), { status: code, message: 'mine' });
  assert.deepEqual(classify(err(502, 'Could not reach Shopify')), { status: 502, message: UNAVAILABLE_MESSAGE });
  for (const code of [403, 410, 500, 503, undefined]) {
    const c = classify(err(code, 'internal detail'));
    assert.equal(c.status, 500, String(code));
    assert.equal(c.message, GENERIC_MESSAGE);
  }
  assert.equal(classify(Object.assign(err(415), { expose: true })).status, 400);
  assert.equal(classify(new ConfigError('x')).status, 500);
  assert.equal(classify(Object.assign(new Error('x'), { type: 'entity.too.large' })).status, 400);
});

test('the alert is logged, and pushed to the webhook at most once a minute per problem', async (t) => {
  const { alert: cfg } = require('../src/config/env');
  const logged = t.mock.method(console, 'error', () => {});
  const post = t.mock.method(axios, 'post', async () => ({ status: 200 }));
  cfg.webhookUrl = 'https://hooks.example.test/x';
  try {
    await alert.alertServerError({ key: 'k-throttle', title: 'boom', requestId: 'req-12345678' });
    await alert.alertServerError({ key: 'k-throttle', title: 'boom', requestId: 'req-12345679' });
    await alert.alertServerError({ key: 'k-other', title: 'other', requestId: 'req-12345680' });
  } finally {
    cfg.webhookUrl = undefined;
  }
  assert.equal(logged.mock.callCount(), 3, 'every alert is logged');
  assert.equal(post.mock.callCount(), 2, 'the second boom is throttled');
  assert.deepEqual(post.mock.calls[0].arguments[1], { text: '[THCM MAP] boom (requestId req-12345678)' });
});
