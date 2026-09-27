// Product list + search rules (src/services/catalogSearch.js) - run with `npm test`.
process.env.SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'test.myshopify.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCatalogQuery, buildIndex, searchCatalog, PAGE_SIZE } = require('../src/services/catalogSearch');
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
  assert.equal(run({ color: 'red' }, index).meta.total, 1);
});

// ---- q --------------------------------------------------------------------------------------
test('q matches SKU, title, variant title, options, category, vendor, tag, handle and ids', () => {
  assert.deepEqual(skus(run({ q: 'GLV-100' })), ['GLV-100']); // sku
  assert.equal(run({ q: 'work gloves' }).meta.total, 1); // title
  const custom = indexOf([variantNode({ productId: 7, variantId: 77, sku: 'TEE-1', title: 'XXL / Navy', options: [{ name: 'Fit', value: 'Slim' }], product: { title: 'Tee' } })]);
  assert.equal(run({ q: 'xxl navy' }, custom).meta.total, 1); // variant title
  assert.equal(run({ q: 'slim' }, custom).meta.total, 1); // option value of any name
  assert.equal(run({ q: 'yellow' }).meta.total, 2); // option value
  assert.equal(run({ q: 'hand protection' }).meta.total, 1); // category
  assert.equal(run({ q: 'grip co' }).meta.total, 1); // vendor
  assert.equal(run({ q: 'visibility' }).meta.total, 1); // tag
  assert.equal(run({ q: 'hi-vis-vest' }).meta.total, 1); // handle
  assert.equal(run({ q: '1002' }).meta.total, 1); // product id
  assert.deepEqual(skus(run({ q: '2006' })), ['VST-9']); // variant id
});

test('q is case-insensitive, trimmed and matches partial words', () => {
  assert.equal(run({ q: '  HEL  ' }).meta.total, 5); // 4 helmet variants + Helmet Mug
  assert.equal(run({ q: 'hel' }).meta.total, 5);
  assert.deepEqual(skus(run({ q: 'glv' })), ['GLV-100']);
});

test('multi-word q needs every word: "black helmet" finds the black helmet variants', () => {
  assert.deepEqual(skus(run({ q: 'black helmet', sort: 'title' })).sort(), ['HEL-L-BLK', 'HEL-M-BLK']);
  assert.equal(run({ q: 'black gloves' }).meta.total, 0);
});

test('ids only match whole, so a short number does not hit every id', () => {
  assert.equal(run({ q: '200' }).meta.total, 0);
  assert.equal(run({ q: '100' }).meta.total, 1); // the SKU GLV-100 contains it, ids do not
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
  assert.equal(run({ q: 'cap' }, index).meta.filters.sort, 'relevance');
});

test('without q the default sort is title', () => {
  assert.equal(run({}).meta.filters.sort, 'title');
  assert.deepEqual(run({}).data.map((r) => r.title), ['Helmet Mug', 'Hi-Vis Vest', 'Safety Helmet', 'Safety Helmet', 'Safety Helmet', 'Safety Helmet', 'Work Gloves']);
});

// ---- filters --------------------------------------------------------------------------------
test('sku: exact, comma-separated list', () => {
  assert.deepEqual(skus(run({ sku: 'GLV-100' })), ['GLV-100']);
  assert.deepEqual(skus(run({ sku: 'glv-100, VST-9' })).sort(), ['GLV-100', 'VST-9']);
  assert.equal(run({ sku: 'GLV' }).meta.total, 0); // exact, not partial
});

test('category / vendor / tag / color / size are case-insensitive exact', () => {
  assert.equal(run({ category: 'helmets' }).meta.total, 4);
  assert.equal(run({ category: 'helmet' }).meta.total, 0);
  assert.equal(run({ vendor: 'ACME' }).meta.total, 5);
  assert.equal(run({ tag: 'PPE' }).meta.total, 5);
  assert.equal(run({ color: 'black' }).meta.total, 2);
  assert.equal(run({ size: 'l' }).meta.total, 2);
  assert.deepEqual(skus(run({ size: 'L', color: 'Yellow' })), ['HEL-L-YEL']);
});

test('price range is inclusive', () => {
  assert.deepEqual(skus(run({ minPrice: '150', maxPrice: '300', sort: 'price' })), ['GLV-100', 'VST-9']);
  assert.equal(run({ minPrice: '500' }).meta.total, 2);
  assert.equal(run({ maxPrice: '80' }).meta.total, 1);
});

test('inStock true / false', () => {
  assert.equal(run({ inStock: 'true' }).meta.total, 6);
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
  assert.equal(run({ sort: 'relevance' }).meta.filters.sort, 'relevance');
});

// ---- pagination -----------------------------------------------------------------------------
const big = indexOf(Array.from({ length: 120 }, (_, i) => variantNode({ productId: 5000 + i, variantId: 9000 + i, sku: `S-${String(i).padStart(3, '0')}`, product: { title: `Item ${String(i).padStart(3, '0')}` } })));

test('page size is fixed at 50: page 1, middle and last', () => {
  assert.equal(PAGE_SIZE, 50);
  const first = run({}, big);
  assert.equal(first.data.length, 50);
  assert.deepEqual(first.meta, { ...first.meta, page: 1, limit: 50, total: 120, totalPages: 3, hasNextPage: true, hasPrevPage: false });

  const second = run({ page: '2' }, big);
  assert.equal(second.data.length, 50);
  assert.equal(second.data[0].sku, 'S-050');
  assert.equal(second.meta.hasNextPage, true);
  assert.equal(second.meta.hasPrevPage, true);

  const last = run({ page: '3' }, big);
  assert.equal(last.data.length, 20);
  assert.equal(last.meta.hasNextPage, false);
  assert.equal(last.meta.hasPrevPage, true);
});

test('pages never overlap and never drop a row', () => {
  const all = [1, 2, 3].flatMap((page) => run({ page: String(page) }, big).data.map((r) => r.variantId));
  assert.equal(new Set(all).size, 120);
});

test('a page beyond the end is 200-shaped: empty data, correct meta', () => {
  const { data, meta } = run({ page: '9' }, big);
  assert.deepEqual(data, []);
  assert.equal(meta.total, 120);
  assert.equal(meta.totalPages, 3);
  assert.equal(meta.hasNextPage, false);
  assert.equal(meta.hasPrevPage, true);
});

test('no matches: empty data, zero pages', () => {
  const { data, meta } = run({ q: 'zzzzzz' });
  assert.deepEqual(data, []);
  assert.deepEqual([meta.total, meta.totalPages, meta.hasNextPage, meta.hasPrevPage], [0, 0, false, false]);
});

test('meta echoes the filters and carries the facet lists', () => {
  const { meta } = run({ q: ' helmet ', color: 'Black', minPrice: '10', inStock: 'true', sku: 'A, B' });
  assert.deepEqual(meta.filters, {
    q: 'helmet', sku: ['A', 'B'], category: null, vendor: null, tag: null, color: 'Black', size: null,
    minPrice: 10, maxPrice: null, inStock: true, sort: 'relevance', order: 'desc',
  });
  assert.deepEqual(meta.facets.colors, ['Black', 'Yellow']);
  assert.deepEqual(meta.facets.sizes, ['L', 'M']);
  assert.deepEqual(meta.facets.priceRange, { min: 80, max: 519 });
  assert.ok(meta.facets.categories.includes('Helmets'));
});

// ---- validation (every 400) -----------------------------------------------------------------
test('invalid parameters are rejected', () => {
  const bad = (query, pattern) => {
    const { error, params } = parseCatalogQuery(query);
    assert.equal(params, undefined, JSON.stringify(query));
    assert.match(error, pattern, JSON.stringify(query));
  };
  bad({ page: '0' }, /page/);
  bad({ page: '-1' }, /page/);
  bad({ page: '1.5' }, /page/);
  bad({ page: 'abc' }, /page/);
  bad({ page: '' }, /page/);
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
  assert.equal(parseCatalogQuery({ page: '1' }).params.page, 1);
  assert.equal(parseCatalogQuery({ fresh: 'true' }).params.fresh, true);
  assert.equal(parseCatalogQuery({ limit: '1000', unknown: 'x' }).error, undefined); // ignored: page size is fixed
  assert.equal(parseCatalogQuery({ q: '   ' }).params.sort, 'title');
});
