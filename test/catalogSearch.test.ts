// Product list + search rules (src/services/catalogSearch.js) - run with `npm test`.
process.env.SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'test.myshopify.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCatalogQuery, buildIndex, searchCatalog } = require('../src/services/catalogSearch');
const { DEFAULT_LIMIT, pageInfo } = require('../src/utils/paginate');
const { mapCatalogVariant } = require('../src/services/shopify/productMapper');
const { variantNode, sampleCatalog } = require('./support/fixtures');

const indexOf = (nodes) => buildIndex(nodes.map(mapCatalogVariant));
const catalog = indexOf(sampleCatalog());

const run = (query, index = catalog) => {
  const parsed = parseCatalogQuery(query);
  assert.equal(parsed.error, undefined, parsed.error);
  return searchCatalog(index, parsed.params);
};
const skus = (result) => result.data.map((row) => row.sku);

// ---- rows ---------------------------------------------------------------------------------
test('a product with several variants gives one row per variant with the full shape', () => {
  const { data } = run({ q: 'safety helmet' });
  assert.equal(data.length, 4);
  const row = data.find((r) => r.sku === 'HEL-M-BLK');
  assert.deepEqual(row, {
    id: '1001',
    variantId: '2001',
    sku: 'HEL-M-BLK',
    title: 'Safety Helmet',
    variantTitle: 'M / Black',
    options: { size: 'M', color: 'Black' },
    price: '499.00',
    compareAtPrice: '599.00',
    availableQty: 10,
    category: 'Helmets',
    vendor: 'Acme',
    tags: ['ppe', 'head'],
    handle: 'safety-helmet',
    imageUrl: 'https://cdn.test/p.png',
    status: 'active',
    createdAt: '2026-03-01T00:00:00Z',
  });
});

test('a single default variant has no variantTitle and no options', () => {
  const row = run({ sku: 'GLV-100' }).data[0];
  assert.equal(row.variantTitle, null);
  assert.deepEqual(row.options, {});
  assert.equal(row.compareAtPrice, null);
});

test('"Colour" option names are exposed as color', () => {
  const index = indexOf([variantNode({ productId: 1, variantId: 2, sku: 'X', options: [{ name: 'Colour', value: 'Red' }], product: { title: 'Cap' } })]);
  assert.deepEqual(run({}, index).data[0].options, { color: 'Red' });
  assert.equal(run({ color: 'red' }, index).pageInfo.total, 1);
});

// ---- q --------------------------------------------------------------------------------------
test('q matches SKU, title, variant title, options, category, vendor, tag, handle and ids', () => {
  assert.deepEqual(skus(run({ q: 'GLV-100' })), ['GLV-100']); // sku
  assert.equal(run({ q: 'work gloves' }).pageInfo.total, 1); // title
  const custom = indexOf([variantNode({ productId: 7, variantId: 77, sku: 'TEE-1', title: 'XXL / Navy', options: [{ name: 'Fit', value: 'Slim' }], product: { title: 'Tee' } })]);
  assert.equal(run({ q: 'xxl navy' }, custom).pageInfo.total, 1); // variant title
  assert.equal(run({ q: 'slim' }, custom).pageInfo.total, 1); // option value of any name
  assert.equal(run({ q: 'yellow' }).pageInfo.total, 2); // option value
  assert.equal(run({ q: 'hand protection' }).pageInfo.total, 1); // category
  assert.equal(run({ q: 'grip co' }).pageInfo.total, 1); // vendor
  assert.equal(run({ q: 'visibility' }).pageInfo.total, 1); // tag
  assert.equal(run({ q: 'hi-vis-vest' }).pageInfo.total, 1); // handle
  assert.equal(run({ q: '1002' }).pageInfo.total, 1); // product id
  assert.deepEqual(skus(run({ q: '2006' })), ['VST-9']); // variant id
});

test('q is case-insensitive, trimmed and matches partial words', () => {
  assert.equal(run({ q: '  HEL  ' }).pageInfo.total, 5); // 4 helmet variants + Helmet Mug
  assert.equal(run({ q: 'hel' }).pageInfo.total, 5);
  assert.deepEqual(skus(run({ q: 'glv' })), ['GLV-100']);
});

test('multi-word q needs every word: "black helmet" finds the black helmet variants', () => {
  assert.deepEqual(skus(run({ q: 'black helmet', sort: 'title' })).sort(), ['HEL-L-BLK', 'HEL-M-BLK']);
  assert.equal(run({ q: 'black gloves' }).pageInfo.total, 0);
});

test('ids only match whole, so a short number does not hit every id', () => {
  assert.equal(run({ q: '200' }).pageInfo.total, 0);
  assert.equal(run({ q: '100' }).pageInfo.total, 1); // the SKU GLV-100 contains it, ids do not
});

test('relevance: exact SKU first, then title starts-with, then contains', () => {
  const index = indexOf([
    variantNode({ productId: 1, variantId: 11, sku: 'A-1', product: { title: 'Red Cap' } }),
    variantNode({ productId: 2, variantId: 12, sku: 'CAP', product: { title: 'Zebra' } }),
    variantNode({ productId: 3, variantId: 13, sku: 'B-1', product: { title: 'Cap Holder' } }),
    variantNode({ productId: 4, variantId: 14, sku: 'C-1', product: { title: 'Baseball Cap' } }),
  ]);
  const found = run({ q: 'cap' }, index).data.map((r) => r.title);
  assert.deepEqual(found, ['Zebra', 'Cap Holder', 'Baseball Cap', 'Red Cap']);
  assert.equal(run({ q: 'cap' }, index).pageInfo.filters.sort, 'relevance');
});

test('without q the default sort is title', () => {
  assert.equal(run({}).pageInfo.filters.sort, 'title');
  assert.deepEqual(run({}).data.map((r) => r.title), ['Helmet Mug', 'Hi-Vis Vest', 'Safety Helmet', 'Safety Helmet', 'Safety Helmet', 'Safety Helmet', 'Work Gloves']);
});

// ---- filters --------------------------------------------------------------------------------
test('sku: exact, comma-separated list', () => {
  assert.deepEqual(skus(run({ sku: 'GLV-100' })), ['GLV-100']);
  assert.deepEqual(skus(run({ sku: 'glv-100, VST-9' })).sort(), ['GLV-100', 'VST-9']);
  assert.equal(run({ sku: 'GLV' }).pageInfo.total, 0); // exact, not partial
});

test('category / vendor / tag / color / size are case-insensitive exact', () => {
  assert.equal(run({ category: 'helmets' }).pageInfo.total, 4);
  assert.equal(run({ category: 'helmet' }).pageInfo.total, 0);
  assert.equal(run({ vendor: 'ACME' }).pageInfo.total, 5);
  assert.equal(run({ tag: 'PPE' }).pageInfo.total, 5);
  assert.equal(run({ color: 'black' }).pageInfo.total, 2);
  assert.equal(run({ size: 'l' }).pageInfo.total, 2);
  assert.deepEqual(skus(run({ size: 'L', color: 'Yellow' })), ['HEL-L-YEL']);
});

test('price range is inclusive', () => {
  assert.deepEqual(skus(run({ minPrice: '150', maxPrice: '300', sort: 'price' })), ['GLV-100', 'VST-9']);
  assert.equal(run({ minPrice: '500' }).pageInfo.total, 2);
  assert.equal(run({ maxPrice: '80' }).pageInfo.total, 1);
});

test('inStock true / false', () => {
  assert.equal(run({ inStock: 'true' }).pageInfo.total, 6);
  assert.deepEqual(skus(run({ inStock: 'false' })), ['HEL-L-BLK']);
});

test('filters combine with q', () => {
  assert.deepEqual(skus(run({ q: 'helmet', inStock: 'true', color: 'yellow', sort: 'stock', order: 'asc' })), ['HEL-M-YEL', 'HEL-L-YEL']);
});

// ---- sort -----------------------------------------------------------------------------------
test('sort: title, price, stock, newest - and order flips them', () => {
  assert.deepEqual(run({ sort: 'title' }).data.map((r) => r.title)[0], 'Helmet Mug');
  assert.deepEqual(run({ sort: 'title', order: 'desc' }).data.map((r) => r.title)[0], 'Work Gloves');
  assert.deepEqual(skus(run({ sort: 'price' })).slice(0, 2), ['MUG-1', 'GLV-100']);
  assert.deepEqual(skus(run({ sort: 'price', order: 'desc' }))[0], 'HEL-L-BLK');
  assert.deepEqual(skus(run({ sort: 'stock' }))[0], 'MUG-1'); // default: most stock first (100)
  assert.deepEqual(skus(run({ sort: 'stock', order: 'asc' }))[0], 'HEL-L-BLK'); // 0
  assert.equal(run({ sort: 'newest' }).data[0].title, 'Hi-Vis Vest'); // 2026-04
  assert.equal(run({ sort: 'newest', order: 'asc' }).data[0].title, 'Helmet Mug'); // 2025-12
  assert.equal(run({ sort: 'relevance' }).pageInfo.filters.sort, 'relevance');
});

// ---- pagination -----------------------------------------------------------------------------
const big = indexOf(Array.from({ length: 120 }, (_, i) => variantNode({ productId: 5000 + i, variantId: 9000 + i, sku: `S-${String(i).padStart(3, '0')}`, product: { title: `Item ${String(i).padStart(3, '0')}` } })));

test('default limit is 50: first page, following nextCursor, and the last page', () => {
  assert.equal(DEFAULT_LIMIT, 50);
  const first = run({}, big);
  assert.equal(first.data.length, 50);
  assert.equal(first.pageInfo.total, 120);
  assert.equal(first.pageInfo.hasNextPage, true);
  assert.equal(first.pageInfo.hasPreviousPage, false);
  assert.equal(typeof first.pageInfo.nextCursor, 'string');

  const second = run({ after: first.pageInfo.nextCursor }, big);
  assert.equal(second.data.length, 50);
  assert.equal(second.data[0].sku, 'S-050');
  assert.equal(second.pageInfo.hasNextPage, true);
  assert.equal(second.pageInfo.hasPreviousPage, true);

  const last = run({ after: second.pageInfo.nextCursor }, big);
  assert.equal(last.data.length, 20);
  assert.equal(last.pageInfo.hasNextPage, false);
  assert.equal(last.pageInfo.nextCursor, null);
  assert.equal(last.pageInfo.hasPreviousPage, true);

  // and back again via previousCursor
  const backToSecond = run({ before: last.pageInfo.previousCursor }, big);
  assert.equal(backToSecond.data[0].sku, second.data[0].sku);
});

test('a custom limit is honoured, capped at 100', () => {
  const page = run({ limit: '10' }, big);
  assert.equal(page.data.length, 10);
  assert.equal(page.pageInfo.limit, 10);
  assert.match(parseCatalogQuery({ limit: '101' }).error, /limit must be at most 100/);
  assert.match(parseCatalogQuery({ limit: '0' }).error, /limit must be/);
});

test('pages never overlap and never drop a row', () => {
  const seen = new Set();
  let cursor;
  for (let i = 0; i < 3; i++) {
    const page = run(cursor ? { after: cursor } : {}, big);
    page.data.forEach((r) => seen.add(r.variantId));
    cursor = page.pageInfo.nextCursor;
  }
  assert.equal(seen.size, 120);
  assert.equal(cursor, null);
});

test('after past the end is 200-shaped: empty data, correct pageInfo', () => {
  // A cursor built against a larger (hypothetical) total, to reach an offset past the real
  // 120-row catalog - the same situation as rows being removed after a cursor was issued.
  const staleCursor = pageInfo({ limit: 50, offset: 150, total: 500 }).nextCursor; // -> offset 200
  const { data, pageInfo: info } = run({ after: staleCursor }, big);
  assert.deepEqual(data, []);
  assert.equal(info.total, 120);
  assert.equal(info.hasNextPage, false);
  assert.equal(info.hasPreviousPage, true);
});

test('a malformed cursor is a 400', () => {
  assert.match(parseCatalogQuery({ after: 'not-a-real-cursor' }).error, /after is not a valid cursor/);
  assert.match(parseCatalogQuery({ before: 'not-a-real-cursor' }).error, /before is not a valid cursor/);
  assert.match(parseCatalogQuery({ after: 'x', before: 'y' }).error, /after and before cannot both be given/);
});

test('no matches: empty data, no next/previous page', () => {
  const { data, pageInfo: info } = run({ q: 'zzzzzz' });
  assert.deepEqual(data, []);
  assert.deepEqual([info.total, info.hasNextPage, info.hasPreviousPage, info.nextCursor, info.previousCursor], [0, false, false, null, null]);
});

test('pageInfo echoes the filters and does not carry facets', () => {
  const { pageInfo: info } = run({ q: ' helmet ', color: 'Black', minPrice: '10', inStock: 'true', sku: 'A, B' });
  assert.deepEqual(info.filters, {
    q: 'helmet', sku: ['A', 'B'], category: null, vendor: null, tag: null, color: 'Black', size: null,
    minPrice: 10, maxPrice: null, inStock: true, sort: 'relevance', order: 'desc',
  });
  // No facets: category/vendor/tags are already on each product row, so a separate
  // categories/colors/sizes/priceRange breakdown is not computed or returned.
  assert.equal('facets' in info, false);
});

// ---- validation (every 400) -----------------------------------------------------------------
test('invalid parameters are rejected', () => {
  const bad = (query, pattern) => {
    const { error, params } = parseCatalogQuery(query);
    assert.equal(params, undefined, JSON.stringify(query));
    assert.match(error, pattern, JSON.stringify(query));
  };
  bad({ limit: '0' }, /limit/);
  bad({ limit: '-1' }, /limit/);
  bad({ limit: '1.5' }, /limit/);
  bad({ limit: 'abc' }, /limit/);
  bad({ limit: '101' }, /limit/);
  bad({ after: 'garbage' }, /after/);
  bad({ before: 'garbage' }, /before/);
  bad({ sort: 'cheapest' }, /sort/);
  bad({ order: 'up' }, /order/);
  bad({ minPrice: 'abc' }, /minPrice/);
  bad({ maxPrice: '1e3' }, /maxPrice/);
  bad({ minPrice: '20', maxPrice: '10' }, /minPrice/);
  bad({ q: 'x'.repeat(101) }, /q must/);
  bad({ inStock: 'maybe' }, /inStock/);
  bad({ fresh: 'yes' }, /fresh/);
  bad({ q: ['a', 'b'] }, /q must be given once/);
});

test('edge values that are valid', () => {
  assert.equal(parseCatalogQuery({ q: 'x'.repeat(100) }).error, undefined);
  assert.equal(parseCatalogQuery({ minPrice: '10', maxPrice: '10' }).error, undefined);
  assert.equal(parseCatalogQuery({ limit: '100' }).params.limit, 100);
  assert.equal(parseCatalogQuery({ fresh: 'true' }).params.fresh, true);
  assert.equal(parseCatalogQuery({ page: '2', unknown: 'x' }).error, undefined); // ignored: page= no longer exists
  assert.equal(parseCatalogQuery({ q: '   ' }).params.sort, 'title');
});
