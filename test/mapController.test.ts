// GET /api/map/stock, GET /api/map/product/:key, order status and cancel at the handler level (src/controllers/map.controller.ts).
process.env.SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'test.myshopify.com';

const test = require('node:test');
const assert = require('node:assert/strict');
import * as shopify from '../src/services/shopify/client';
import * as controller from '../src/controllers/map.controller';
import { sampleCatalog } from './support/fixtures';

function respond() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

async function call(handler, req) {
  const res = respond();
  let error;
  await handler(req, res, (err) => {
    error = err;
  });
  if (error) throw error;
  return res;
}

// The stock handler is fed a raw catalog through a mocked shopify.listProductsCatalog.
function withCatalog(t, raw = sampleCatalog()) {
  const list = t.mock.method(shopify, 'listProductsCatalog', async () => raw);
  return list;
}
const getStock = (query) => call(controller.getStock, { query });

test('stock: 200 with data + pageInfo for a plain list', async (t) => {
  withCatalog(t);
  const res = await getStock({});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.length, 7);
  assert.equal(res.body.pageInfo.total, 7);
  assert.equal(res.body.pageInfo.limit, 50);
  assert.equal(res.body.pageInfo.hasNextPage, false);
  assert.equal('facets' in res.body.pageInfo, false); // category/vendor/tags are already on each product row
});

test('stock: search, filters and sort go through', async (t) => {
  withCatalog(t);
  const res = await getStock({ q: 'black helmet', inStock: 'true' });
  assert.deepEqual(res.body.data.map((r) => r.sku), ['HEL-M-BLK']);
  assert.equal(res.body.pageInfo.filters.q, 'black helmet');
});

test('stock: a cursor past the end is 200 with empty data', async (t) => {
  withCatalog(t);
  const { pageInfo } = require('../src/utils/paginate');
  const staleCursor = pageInfo({ limit: 50, offset: 50, total: 500 }).nextCursor; // -> offset 100, past the 7 real rows
  const res = await getStock({ after: staleCursor });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.pageInfo.total, 7);
  assert.equal(res.body.pageInfo.hasNextPage, false);
  assert.equal(res.body.pageInfo.hasPreviousPage, true);
});

test('stock: every invalid parameter is a 400 with success:false and the catalog is never read', async (t) => {
  const list = withCatalog(t);
  const cases = [
    { limit: '0' }, { limit: '-1' }, { limit: 'x' }, { limit: '101' }, { after: 'not-a-cursor' }, { sort: 'nope' }, { order: 'sideways' },
    { minPrice: 'abc' }, { maxPrice: 'abc' }, { minPrice: '9', maxPrice: '1' }, { q: 'a'.repeat(101) },
  ];
  for (const query of cases) {
    const res = await getStock(query);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.equal(res.body.success, false);
    assert.equal(typeof res.body.message, 'string');
  }
  assert.equal(list.mock.callCount(), 0);
});

test('stock: fresh=true bypasses the cache, otherwise it is not asked for', async (t) => {
  const list = withCatalog(t);
  await getStock({});
  assert.deepEqual(list.mock.calls[0].arguments, [{ fresh: false }]);
  await getStock({ fresh: 'true' });
  assert.deepEqual(list.mock.calls[1].arguments, [{ fresh: true }]);
});

test('stock: a Shopify failure is passed to the error handler', async (t) => {
  t.mock.method(shopify, 'listProductsCatalog', async () => {
    throw new Error('Shopify is down');
  });
  await assert.rejects(() => getStock({}), /Shopify is down/);
});

test('stock: the same catalog copy is only indexed once', async (t) => {
  withCatalog(t);
  // rows are shared objects from one index build, so two searches return the very same row object
  const bySku = (await getStock({ sku: 'GLV-100' })).body.data[0];
  const byText = (await getStock({ q: 'glv' })).body.data[0];
  assert.equal(bySku, byText);
});

// ---- product lookup handler ------------------------------------------------------------------
const getProduct = (key) => call(controller.getProductDetail, { params: { key } });

test('product: an empty or blank key is 400', async () => {
  for (const key of ['', '   ', undefined]) {
    const res = await getProduct(key);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
  }
});

test('product: a key longer than 100 characters is 400', async () => {
  assert.equal((await getProduct('a'.repeat(101))).statusCode, 400);
});

test('product: unknown key is 404 "Product not found for \'XYZ\'"', async (t) => {
  t.mock.method(shopify, 'getProductDetail', async () => null);
  t.mock.method(shopify, 'findProductIdByVariantId', async () => null);
  t.mock.method(shopify, 'findVariantRefBySku', async () => null);
  t.mock.method(shopify, 'findProductIdByHandle', async () => null);
  const res = await getProduct(' XYZ ');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { success: false, message: "Product not found for 'XYZ'" });
});

test('product: found by SKU returns the full product with matchedBy / matchedVariantId', async (t) => {
  const node = { id: 'gid://shopify/ProductVariant/9', title: 'M', sku: 'ABC', price: '10.00', compareAtPrice: '12.00', inventoryQuantity: 3, selectedOptions: [{ name: 'Size', value: 'M' }] };
  t.mock.method(shopify, 'findVariantRefBySku', async () => ({ productId: '5', variantId: '9' }));
  t.mock.method(shopify, 'getProductDetail', async () => ({
    id: 'gid://shopify/Product/5', title: 'Tee', handle: 'tee', descriptionHtml: '<p>Soft</p>', productType: 'Apparel', vendor: 'V', tags: ['a'], status: 'ACTIVE',
    images: { edges: [] }, variants: { edges: [{ node }] },
  }));
  const res = await getProduct('ABC');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.matchedBy, 'sku');
  assert.equal(res.body.data.matchedVariantId, '9');
  assert.equal(res.body.data.variants[0].variantId, '9');
  assert.equal(res.body.data.variants[0].compareAtPrice, '12.00');
  assert.equal(res.body.data.description, 'Soft');
});

// ---- order status / cancel: the Shopify order id only ------------------------------------------
import { Order } from '../src/models';

const orderRow = { id: 70, shopifyOrderId: '7189529821424', status: 'open', financialStatus: 'pending', fulfillmentStatus: null, deliveryStatus: null, trackingNumber: null, trackingUrl: null, carrier: null };
const getOrderStatus = (shopifyOrderId) => call(controller.getOrderStatus, { params: { shopifyOrderId } });
const cancel = (shopifyOrderId) => call(controller.cancelOrder, { params: { shopifyOrderId } });

test('order status: looked up by shopify_order_id only, never by the internal id', async (t) => {
  const findOne = t.mock.method(Order, 'findOne', async ({ where }) => (where.shopifyOrderId === orderRow.shopifyOrderId ? orderRow : null));
  const findByPk = t.mock.method(Order, 'findByPk', async () => orderRow);

  const ok = await getOrderStatus('7189529821424');
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.body.data, orderRow);

  const internal = await getOrderStatus('70');
  assert.equal(internal.statusCode, 404);
  assert.equal(internal.body.message, 'Order not found');

  assert.equal(findByPk.mock.callCount(), 0);
  assert.deepEqual(findOne.mock.calls.map((c) => c.arguments[0].where), [{ shopifyOrderId: '7189529821424' }, { shopifyOrderId: '70' }]);
});

test('order status and cancel: a non-numeric id is 400 and nothing is looked up', async (t) => {
  const findOne = t.mock.method(Order, 'findOne', async () => orderRow);
  for (const handler of [getOrderStatus, cancel]) {
    for (const bad of ['abc', '12a', '-5', '1.5']) {
      const res = await handler(bad);
      assert.equal(res.statusCode, 400, bad);
      assert.equal(res.body.message, 'Shopify order id must be numeric');
    }
  }
  assert.equal(findOne.mock.callCount(), 0);
});

test('cancel: an unknown Shopify order id (e.g. the internal id) is 404', async (t) => {
  const findOne = t.mock.method(Order, 'findOne', async () => null);
  const res = await cancel('70');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, 'Order not found');
  assert.deepEqual(findOne.mock.calls[0].arguments[0].where, { shopifyOrderId: '70' });
});
