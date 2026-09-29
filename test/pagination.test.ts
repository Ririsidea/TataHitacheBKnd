// The shared pagination contract (src/utils/paginate.js) and every list endpoint that follows it.
process.env.SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'test.myshopify.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { Order, WebhookLog, User, DailyExport } = require('../src/models');
const dashboard = require('../src/controllers/dashboard.controller');
const adminOrders = require('../src/controllers/adminOrders.controller');
const admin = require('../src/controllers/admin.controller');
const sap = require('../src/controllers/sap.controller');
const { parseCursor, pageInfo, parseDateBound, parseDateRange, parseDayRange, likeContains, DEFAULT_LIMIT } = require('../src/utils/paginate');
const { parseOrderListQuery } = require('../src/services/orderList.service');

// A cursor is opaque to callers - tests decode it only to check the offset it points at.
function cursorOffset(cursor) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
}

// ---- the helpers ------------------------------------------------------------------------------
test('parseCursor: missing limit/after/before is limit 50, offset 0', () => {
  assert.deepEqual(parseCursor(), { limit: 50, offset: 0 });
  assert.deepEqual(parseCursor({}), { limit: 50, offset: 0 });
  assert.equal(DEFAULT_LIMIT, 50);
});

test('parseCursor: limit must be a positive integer, at most 100', () => {
  assert.deepEqual(parseCursor({ limit: '10' }), { limit: 10, offset: 0 });
  for (const bad of ['0', '-1', '1.5', 'abc', '', ' ', '1e3', '101', '99999999999999999999']) {
    assert.match(parseCursor({ limit: bad }).error, /limit must be/, JSON.stringify(bad));
  }
  assert.equal(parseCursor({ limit: '100' }).limit, 100);
});

test('parseCursor: after/before decode to the offset they were issued for; malformed cursors are refused', () => {
  const info = pageInfo({ limit: 50, offset: 50, total: 200 });
  assert.deepEqual(parseCursor({ after: info.nextCursor }), { limit: 50, offset: 100 });
  assert.deepEqual(parseCursor({ before: info.previousCursor }), { limit: 50, offset: 0 });
  for (const bad of ['not-base64!!', 'eyJvIjotMX0', 'eyJub3RvIjoxfQ']) {
    assert.match(parseCursor({ after: bad }).error, /after is not a valid cursor/, bad);
  }
  assert.match(parseCursor({ after: 'x', before: 'y' }).error, /after and before cannot both be given/);
});

test('pageInfo: total, hasNextPage/hasPreviousPage and the cursors that follow them', () => {
  const first = pageInfo({ limit: 50, offset: 0, total: 120, filters: { a: 1 } });
  assert.equal(first.limit, 50);
  assert.equal(first.total, 120);
  assert.equal(first.hasNextPage, true);
  assert.equal(first.hasPreviousPage, false);
  assert.equal(first.previousCursor, null);
  assert.equal(cursorOffset(first.nextCursor), 50);
  assert.deepEqual(first.filters, { a: 1 });

  const middle = pageInfo({ limit: 50, offset: 50, total: 120 });
  assert.equal(middle.hasNextPage, true);
  assert.equal(middle.hasPreviousPage, true);
  assert.equal(cursorOffset(middle.nextCursor), 100);
  assert.equal(cursorOffset(middle.previousCursor), 0);

  const last = pageInfo({ limit: 50, offset: 100, total: 120 });
  assert.equal(last.hasNextPage, false);
  assert.equal(last.nextCursor, null);
  assert.equal(last.hasPreviousPage, true);
  assert.equal(cursorOffset(last.previousCursor), 50);

  const empty = pageInfo({ limit: 50, offset: 0, total: 0 });
  assert.equal(empty.hasNextPage, false);
  assert.equal(empty.hasPreviousPage, false);
});

test('date filters: a whole UTC day, or an exact ISO instant; impossible dates are refused', () => {
  assert.equal(parseDateBound('fromDate', '2026-09-25', 'start').date.toISOString(), '2026-09-25T00:00:00.000Z');
  assert.equal(parseDateBound('toDate', '2026-09-25', 'end').date.toISOString(), '2026-09-25T23:59:59.999Z');
  assert.equal(parseDateBound('fromDate', '2026-09-24T18:30:00.000Z', 'start').date.toISOString(), '2026-09-24T18:30:00.000Z');
  assert.equal(parseDateBound('fromDate', '2026-09-25T00:00:00+05:30', 'start').date.toISOString(), '2026-09-24T18:30:00.000Z');
  for (const bad of ['2026-02-31', '2026-13-01', '25/09/2026', 'yesterday', '', '2026-09-25T10:00', '2026-09-25 10:00:00']) {
    assert.match(parseDateBound('fromDate', bad, 'start').error, /fromDate must be a date/, bad);
  }
  assert.match(parseDateRange({ fromDate: '2026-09-26', toDate: '2026-09-25' }, 'fromDate', 'toDate').error, /fromDate must not be after toDate/);
  assert.deepEqual(parseDayRange({ from: '2026-09-01', to: '2026-09-30' }, 'from', 'to'), { from: '2026-09-01', to: '2026-09-30' });
  assert.match(parseDayRange({ from: '2026-09-01T00:00:00Z' }, 'from', 'to').error, /from must be a date \(YYYY-MM-DD\)/);
  assert.match(parseDayRange({ from: '2026-10-01', to: '2026-09-30' }, 'from', 'to').error, /from must not be after to/);
});

test('likeContains escapes wildcard characters', () => {
  assert.equal(likeContains('50%_off'), '%50\\%\\_off%');
});

// ---- endpoint harness ---------------------------------------------------------------------------
function respond() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
async function call(handler, req) {
  const res = respond();
  let error;
  await handler(req, res, (err) => { error = err; });
  if (error) throw error;
  return res;
}
const orderRow = (id, extra = {}) => ({ id, status: 'open', fulfillmentStatus: null, closedAt: null, toJSON: () => ({ id, lineItems: [] }), ...extra });
const plainRows = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, email: `e${i}@x.co`, name: `E${i}` }));

// One suite per endpoint: same contract, endpoint-specific filters below.
const ENDPOINTS = [
  {
    name: 'GET /api/dashboard/orders',
    model: Order,
    handler: dashboard.getOrders,
    req: (query) => ({ query: { email: 'asha@example.com', ...query } }),
    rows: (n) => Array.from({ length: n }, (_, i) => orderRow(i + 1)),
  },
  {
    name: 'GET /api/admin/orders',
    model: Order,
    handler: adminOrders.listOrders,
    req: (query) => ({ query }),
    rows: (n) => Array.from({ length: n }, (_, i) => orderRow(i + 1)),
  },
  {
    name: 'GET /api/dashboard/events',
    model: WebhookLog,
    handler: dashboard.getEvents,
    req: (query) => ({ query }),
    rows: plainRows,
  },
  {
    name: 'GET /api/admin/employees',
    model: User,
    handler: admin.listEmployees,
    req: (query) => ({ query }),
    rows: plainRows,
  },
  {
    name: 'GET /api/sap/daily-exports',
    model: DailyExport,
    handler: sap.listDailyExports,
    req: (query) => ({ query, user: { email: 'asha@example.com' } }),
    rows: plainRows,
  },
];

for (const ep of ENDPOINTS) {
  const stub = (t, { count = 120, rows = ep.rows(3) } = {}) => t.mock.method(ep.model, 'findAndCountAll', async () => ({ rows, count }));
  const get = (query) => call(ep.handler, ep.req(query));

  test(`${ep.name}: first page - limit 50 by default, { success, data, pageInfo }`, async (t) => {
    const find = stub(t);
    const res = await get({});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.length, 3);
    const args = find.mock.calls[0].arguments[0];
    assert.equal(args.limit, 50);
    assert.equal(args.offset, 0);
    assert.deepEqual(
      { ...res.body.pageInfo, filters: undefined },
      { limit: 50, offset: 0, total: 120, hasNextPage: true, hasPreviousPage: false, nextCursor: res.body.pageInfo.nextCursor, previousCursor: null, filters: undefined }
    );
    assert.equal(typeof res.body.pageInfo.filters, 'object');
    assert.equal(typeof res.body.pageInfo.nextCursor, 'string');
  });

  test(`${ep.name}: following nextCursor reads the next block; hasPreviousPage becomes true`, async (t) => {
    const find = stub(t, { count: 120 });
    const first = await get({});
    const second = await get({ after: first.body.pageInfo.nextCursor });
    assert.equal(find.mock.calls[1].arguments[0].offset, 50);
    assert.equal(second.body.pageInfo.hasPreviousPage, true);
  });

  test(`${ep.name}: a cursor at the last block has no next page`, async (t) => {
    const find = stub(t, { count: 120, rows: [] });
    const cursor = pageInfo({ limit: 50, offset: 50, total: 120 }).nextCursor; // -> offset 100
    const res = await get({ after: cursor });
    assert.equal(find.mock.calls[0].arguments[0].offset, 100);
    assert.equal(res.body.pageInfo.hasNextPage, false);
    assert.equal(res.body.pageInfo.nextCursor, null);
  });

  test(`${ep.name}: following previousCursor steps back`, async (t) => {
    const find = stub(t, { count: 120 });
    const cursor = pageInfo({ limit: 50, offset: 50, total: 120 }).previousCursor;
    const res = await get({ before: cursor });
    assert.equal(find.mock.calls[0].arguments[0].offset, 0);
    assert.equal(res.body.pageInfo.hasPreviousPage, false);
  });

  test(`${ep.name}: a bad limit/after/before is 400 and the database is never read`, async (t) => {
    const find = stub(t);
    for (const query of [{ limit: '0' }, { limit: '-1' }, { limit: '1.5' }, { limit: 'abc' }, { limit: '101' }, { after: 'not-a-cursor' }, { before: 'not-a-cursor' }, { limit: ['1', '2'] }]) {
      const res = await get(query);
      assert.equal(res.statusCode, 400, JSON.stringify(query));
      assert.equal(res.body.success, false);
    }
    assert.equal(find.mock.callCount(), 0);
  });

  test(`${ep.name}: there is no page= parameter any more - it is silently ignored`, async (t) => {
    const find = stub(t);
    await get({ page: '3' });
    assert.equal(find.mock.calls[0].arguments[0].offset, 0);
    assert.equal(find.mock.calls[0].arguments[0].limit, 50);
  });

  test(`${ep.name}: a custom limit is honoured and capped at 100`, async (t) => {
    const find = stub(t);
    await get({ limit: '10' });
    assert.equal(find.mock.calls[0].arguments[0].limit, 10);
  });

  test(`${ep.name}: nothing found is an empty first page`, async (t) => {
    stub(t, { rows: [], count: 0 });
    const res = await get({});
    assert.deepEqual(res.body.data, []);
    assert.deepEqual(
      [res.body.pageInfo.total, res.body.pageInfo.hasNextPage, res.body.pageInfo.hasPreviousPage, res.body.pageInfo.nextCursor, res.body.pageInfo.previousCursor],
      [0, false, false, null, null]
    );
  });

  test(`${ep.name}: a database failure goes to the error handler`, async (t) => {
    t.mock.method(ep.model, 'findAndCountAll', async () => { throw new Error('db down'); });
    await assert.rejects(() => get({}), /db down/);
  });
}

// ---- endpoint-specific filters ------------------------------------------------------------------------
test('dashboard orders: email is required and must be an email', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [], count: 0 }));
  for (const email of [undefined, '', 'nope', 'a@b', 'x'.repeat(260) + '@y.co']) {
    const res = await call(dashboard.getOrders, { query: email === undefined ? {} : { email } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /valid email/);
  }
  assert.equal(find.mock.callCount(), 0);
});

test('dashboard orders: employee, status and date range become the query, newest first', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [orderRow(2), orderRow(1)], count: 2 }));
  const res = await call(dashboard.getOrders, {
    query: { email: ' Asha@Example.com ', status: 'OPEN', fromDate: '2026-09-01', toDate: '2026-09-25' },
  });
  const args = find.mock.calls[0].arguments[0];
  const [base, statusCondition] = args.where[Op.and];
  assert.equal(base.email, 'asha@example.com');
  assert.equal(base.createdAt[Op.gte].toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(base.createdAt[Op.lte].toISOString(), '2026-09-25T23:59:59.999Z');
  assert.ok(statusCondition, 'a status condition is added');
  assert.deepEqual(args.order, [['createdAt', 'DESC'], ['id', 'DESC']]);
  assert.equal(args.distinct, true);
  assert.deepEqual(res.body.pageInfo.filters, { email: 'asha@example.com', status: 'open', fromDate: '2026-09-01', toDate: '2026-09-25' });
  // every row carries the derived flags
  assert.equal(res.body.data[0].canCancel, true);
  assert.equal(res.body.data[0].stage, 'pending');
});

test('dashboard orders: bad filters are 400', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [], count: 0 }));
  const bad = [
    [{ fromDate: '2026-02-31' }, /fromDate must be a date/],
    [{ toDate: 'yesterday' }, /toDate must be a date/],
    [{ fromDate: '2026-09-26', toDate: '2026-09-25' }, /fromDate must not be after toDate/],
    [{ status: 'x'.repeat(51) }, /status must be at most 50/],
    [{ status: ['open', 'closed'] }, /status must be given once/],
  ];
  for (const [query, message] of bad) {
    const res = await call(dashboard.getOrders, { query: { email: 'a@b.co', ...query } });
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.match(res.body.message, message);
  }
  assert.equal(find.mock.callCount(), 0);
});

test('dashboard orders: a client can send its own local-day boundaries as ISO date-times', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [], count: 0 }));
  await call(dashboard.getOrders, { query: { email: 'a@b.co', fromDate: '2026-09-24T18:30:00.000Z', toDate: '2026-09-25T18:29:59.999Z' } });
  const base = find.mock.calls[0].arguments[0].where[Op.and][0];
  assert.equal(base.createdAt[Op.gte].toISOString(), '2026-09-24T18:30:00.000Z');
  assert.equal(base.createdAt[Op.lte].toISOString(), '2026-09-25T18:29:59.999Z');
});

test('admin orders: q, optional email and the same status / date filters', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [], count: 0 }));
  const res = await call(adminOrders.listOrders, { query: { q: '  9001 ', status: 'cancelled', email: 'a@b.co' } });
  const conditions = find.mock.calls[0].arguments[0].where[Op.and];
  assert.equal(conditions.length, 3); // base + status + q
  assert.deepEqual(res.body.pageInfo.filters, { email: 'a@b.co', status: 'cancelled', fromDate: null, toDate: null, q: '9001' });
  assert.equal((await call(adminOrders.listOrders, { query: { q: 'x'.repeat(101) } })).statusCode, 400);
  assert.equal((await call(adminOrders.listOrders, { query: { email: 'nope' } })).statusCode, 400);
});

test('parseOrderListQuery: q is only honoured where search is allowed', () => {
  assert.equal(parseOrderListQuery({ email: 'a@b.co', q: 'x' }, { employeeRequired: true }).params.q, null);
  assert.equal(parseOrderListQuery({ q: 'x' }, { allowSearch: true }).params.q, 'x');
});

test('dashboard orders require ?email=; admin orders retain the legacy alias', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [], count: 0 }));
  const missing = await call(dashboard.getOrders, { query: { employeeEmail: 'Old@Example.com' } });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.message, 'A valid email query parameter is required');

  const both = await call(adminOrders.listOrders, { query: { email: 'new@example.com', employeeEmail: 'old@example.com' } });
  assert.equal(both.body.pageInfo.filters.email, 'new@example.com');
  assert.equal(
    parseOrderListQuery({ employeeEmail: ['a@b.co', 'c@d.co'] }, { allowLegacyEmailAlias: true }).error,
    'employeeEmail must be given once'
  );
});

test('admin employees: q searches name and email', async (t) => {
  const find = t.mock.method(User, 'findAndCountAll', async () => ({ rows: plainRows(2), count: 2 }));
  const res = await call(admin.listEmployees, { query: { q: ' asha ' } });
  const where = find.mock.calls[0].arguments[0].where;
  assert.equal(where[Op.or].length, 2);
  assert.deepEqual(res.body.pageInfo.filters, { q: 'asha' });
  find.mock.resetCalls();
  await call(admin.listEmployees, { query: {} });
  assert.deepEqual(find.mock.calls[0].arguments[0].where, {});
  assert.equal((await call(admin.listEmployees, { query: { q: 'x'.repeat(101) } })).statusCode, 400);
});

test('sap daily exports: scoped to the signed-in employee, from / to on the export date', async (t) => {
  const find = t.mock.method(DailyExport, 'findAndCountAll', async () => ({ rows: plainRows(1), count: 1 }));
  const res = await call(sap.listDailyExports, { query: { from: '2026-09-01', to: '2026-09-30' }, user: { email: 'asha@example.com' } });
  const args = find.mock.calls[0].arguments[0];
  assert.equal(args.where.email, 'asha@example.com');
  assert.equal(args.where.exportDate[Op.gte], '2026-09-01');
  assert.equal(args.where.exportDate[Op.lte], '2026-09-30');
  assert.deepEqual(args.order, [['exportDate', 'DESC'], ['id', 'DESC']]);
  assert.deepEqual(res.body.pageInfo.filters, { from: '2026-09-01', to: '2026-09-30' });
  for (const query of [{ from: '2026-02-31' }, { to: 'x' }, { from: '2026-10-01', to: '2026-09-01' }]) {
    const bad = await call(sap.listDailyExports, { query, user: { email: 'a@b.co' } });
    assert.equal(bad.statusCode, 400, JSON.stringify(query));
  }
});
