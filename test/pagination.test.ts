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
const { parsePage, pageMeta, parseDateBound, parseDateRange, parseDayRange, likeContains, PAGE_SIZE } = require('../src/utils/paginate');
const { parseOrderListQuery } = require('../src/services/orderList.service');

// ---- the helpers ------------------------------------------------------------------------------
test('parsePage: missing is page 1; whole numbers from 1 are accepted; everything else is refused', () => {
  assert.deepEqual(parsePage(undefined), { page: 1 });
  assert.deepEqual(parsePage('1'), { page: 1 });
  assert.deepEqual(parsePage(' 7 '), { page: 7 });
  for (const bad of ['0', '-1', '1.5', 'abc', '', ' ', '1e3', '99999999999999999999', ['1', '2']]) {
    assert.match(parsePage(bad).error, /page must be an integer of at least 1/, JSON.stringify(bad));
  }
});

test('pageMeta: totals, page flags and the fixed limit', () => {
  assert.equal(PAGE_SIZE, 50);
  assert.deepEqual(pageMeta({ page: 2, total: 120, filters: { a: 1 } }), { page: 2, limit: 50, total: 120, totalPages: 3, hasNextPage: true, hasPrevPage: true, filters: { a: 1 } });
  assert.deepEqual(pageMeta({ page: 3, total: 120 }), { page: 3, limit: 50, total: 120, totalPages: 3, hasNextPage: false, hasPrevPage: true, filters: {} });
  assert.deepEqual(pageMeta({ page: 1, total: 0 }), { page: 1, limit: 50, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false, filters: {} });
  assert.equal(pageMeta({ page: 1, total: 50 }).totalPages, 1);
  assert.equal(pageMeta({ page: 1, total: 51 }).totalPages, 2);
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
    req: (query) => ({ query: { employeeEmail: 'asha@example.com', ...query } }),
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

  test(`${ep.name}: page 1 - exactly 50 per page, { success, data, meta }`, async (t) => {
    const find = stub(t);
    const res = await get({});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.length, 3);
    const args = find.mock.calls[0].arguments[0];
    assert.equal(args.limit, 50);
    assert.equal(args.offset, 0);
    assert.deepEqual(
      { ...res.body.meta, filters: undefined },
      { page: 1, limit: 50, total: 120, totalPages: 3, hasNextPage: true, hasPrevPage: false, filters: undefined }
    );
    assert.equal(typeof res.body.meta.filters, 'object');
  });

  test(`${ep.name}: page 3 reads rows 100-149; the last page has no next page`, async (t) => {
    const find = stub(t);
    const res = await get({ page: '3' });
    assert.equal(find.mock.calls[0].arguments[0].offset, 100);
    assert.equal(res.body.meta.page, 3);
    assert.equal(res.body.meta.hasNextPage, false);
    assert.equal(res.body.meta.hasPrevPage, true);
  });

  test(`${ep.name}: a page past the end is 200 with empty data and correct meta`, async (t) => {
    stub(t, { rows: [], count: 120 });
    const res = await get({ page: '9' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.meta.total, 120);
    assert.equal(res.body.meta.totalPages, 3);
    assert.equal(res.body.meta.hasPrevPage, true);
  });

  test(`${ep.name}: a bad page is 400 and the database is never read`, async (t) => {
    const find = stub(t);
    for (const page of ['0', '-1', '1.5', 'abc', '', ['1', '2']]) {
      const res = await get({ page });
      assert.equal(res.statusCode, 400, JSON.stringify(page));
      assert.equal(res.body.success, false);
      assert.match(res.body.message, /^page must be/);
    }
    assert.equal(find.mock.callCount(), 0);
  });

  test(`${ep.name}: there is no page-size parameter`, async (t) => {
    const find = stub(t);
    await get({ pageSize: '1000', limit: '1000' });
    assert.equal(find.mock.calls[0].arguments[0].limit, 50);
  });

  test(`${ep.name}: nothing found is an empty first page`, async (t) => {
    stub(t, { rows: [], count: 0 });
    const res = await get({});
    assert.deepEqual(res.body.data, []);
    assert.deepEqual([res.body.meta.total, res.body.meta.totalPages, res.body.meta.hasNextPage, res.body.meta.hasPrevPage], [0, 0, false, false]);
  });

  test(`${ep.name}: a database failure goes to the error handler`, async (t) => {
    t.mock.method(ep.model, 'findAndCountAll', async () => { throw new Error('db down'); });
    await assert.rejects(() => get({}), /db down/);
  });
}

// ---- endpoint-specific filters ------------------------------------------------------------------------
test('dashboard orders: employeeEmail is required and must be an email', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [], count: 0 }));
  for (const employeeEmail of [undefined, '', 'nope', 'a@b', 'x'.repeat(260) + '@y.co']) {
    const res = await call(dashboard.getOrders, { query: employeeEmail === undefined ? {} : { employeeEmail } });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /valid employeeEmail/);
  }
  assert.equal(find.mock.callCount(), 0);
});

test('dashboard orders: employee, status and date range become the query, newest first', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [orderRow(2), orderRow(1)], count: 2 }));
  const res = await call(dashboard.getOrders, {
    query: { employeeEmail: ' Asha@Example.com ', status: 'OPEN', fromDate: '2026-09-01', toDate: '2026-09-25' },
  });
  const args = find.mock.calls[0].arguments[0];
  const [base, statusCondition] = args.where[Op.and];
  assert.equal(base.employeeEmail, 'asha@example.com');
  assert.equal(base.createdAt[Op.gte].toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(base.createdAt[Op.lte].toISOString(), '2026-09-25T23:59:59.999Z');
  assert.ok(statusCondition, 'a status condition is added');
  assert.deepEqual(args.order, [['createdAt', 'DESC'], ['id', 'DESC']]);
  assert.equal(args.distinct, true);
  assert.deepEqual(res.body.meta.filters, { employeeEmail: 'asha@example.com', status: 'open', fromDate: '2026-09-01', toDate: '2026-09-25' });
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
    const res = await call(dashboard.getOrders, { query: { employeeEmail: 'a@b.co', ...query } });
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.match(res.body.message, message);
  }
  assert.equal(find.mock.callCount(), 0);
});

test('dashboard orders: a client can send its own local-day boundaries as ISO date-times', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [], count: 0 }));
  await call(dashboard.getOrders, { query: { employeeEmail: 'a@b.co', fromDate: '2026-09-24T18:30:00.000Z', toDate: '2026-09-25T18:29:59.999Z' } });
  const base = find.mock.calls[0].arguments[0].where[Op.and][0];
  assert.equal(base.createdAt[Op.gte].toISOString(), '2026-09-24T18:30:00.000Z');
  assert.equal(base.createdAt[Op.lte].toISOString(), '2026-09-25T18:29:59.999Z');
});

test('admin orders: q, optional employeeEmail and the same status / date filters', async (t) => {
  const find = t.mock.method(Order, 'findAndCountAll', async () => ({ rows: [], count: 0 }));
  const res = await call(adminOrders.listOrders, { query: { q: '  9001 ', status: 'cancelled', employeeEmail: 'a@b.co' } });
  const conditions = find.mock.calls[0].arguments[0].where[Op.and];
  assert.equal(conditions.length, 3); // base + status + q
  assert.deepEqual(res.body.meta.filters, { employeeEmail: 'a@b.co', status: 'cancelled', fromDate: null, toDate: null, q: '9001' });
  assert.equal((await call(adminOrders.listOrders, { query: { q: 'x'.repeat(101) } })).statusCode, 400);
  assert.equal((await call(adminOrders.listOrders, { query: { employeeEmail: 'nope' } })).statusCode, 400);
});

test('parseOrderListQuery: q is only honoured where search is allowed', () => {
  assert.equal(parseOrderListQuery({ employeeEmail: 'a@b.co', q: 'x' }, { employeeRequired: true }).params.q, null);
  assert.equal(parseOrderListQuery({ q: 'x' }, { allowSearch: true }).params.q, 'x');
});

test('admin employees: q searches name and email', async (t) => {
  const find = t.mock.method(User, 'findAndCountAll', async () => ({ rows: plainRows(2), count: 2 }));
  const res = await call(admin.listEmployees, { query: { q: ' asha ' } });
  const where = find.mock.calls[0].arguments[0].where;
  assert.equal(where[Op.or].length, 2);
  assert.deepEqual(res.body.meta.filters, { q: 'asha' });
  find.mock.resetCalls();
  await call(admin.listEmployees, { query: {} });
  assert.deepEqual(find.mock.calls[0].arguments[0].where, {});
  assert.equal((await call(admin.listEmployees, { query: { q: 'x'.repeat(101) } })).statusCode, 400);
});

test('sap daily exports: scoped to the signed-in employee, from / to on the export date', async (t) => {
  const find = t.mock.method(DailyExport, 'findAndCountAll', async () => ({ rows: plainRows(1), count: 1 }));
  const res = await call(sap.listDailyExports, { query: { from: '2026-09-01', to: '2026-09-30' }, user: { email: 'asha@example.com' } });
  const args = find.mock.calls[0].arguments[0];
  assert.equal(args.where.employeeEmail, 'asha@example.com');
  assert.equal(args.where.exportDate[Op.gte], '2026-09-01');
  assert.equal(args.where.exportDate[Op.lte], '2026-09-30');
  assert.deepEqual(args.order, [['exportDate', 'DESC'], ['id', 'DESC']]);
  assert.deepEqual(res.body.meta.filters, { from: '2026-09-01', to: '2026-09-30' });
  for (const query of [{ from: '2026-02-31' }, { to: 'x' }, { from: '2026-10-01', to: '2026-09-01' }]) {
    const bad = await call(sap.listDailyExports, { query, user: { email: 'a@b.co' } });
    assert.equal(bad.statusCode, 400, JSON.stringify(query));
  }
});
