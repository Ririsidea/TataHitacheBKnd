// Shopify client behaviour (src/services/shopify/client.js) against a fake GraphQL transport:
// variant paging, SKU chunking, cache windows, ?fresh, and single-product lookup.
process.env.SHOPIFY_STORE_DOMAIN = 'test.myshopify.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
import { gid, variantNode } from './support/fixtures';

// ---- fake transport: every GraphQL call goes through `handler(operationName, variables, query)` ----
const calls = [];
let handler = () => {
  throw new Error('no handler set');
};
axios.create = () => ({
  post: async (url, body) => {
    const name = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1];
    calls.push({ name, variables: body.variables, query: body.query });
    return { data: { data: handler(name, body.variables || {}, body.query) } };
  },
  get: async () => {
    throw new Error('unexpected REST call');
  },
});

import * as shopify from '../src/services/shopify/client';
import { lookupProduct } from '../src/services/catalog.service';

const callsNamed = (name) => calls.filter((c) => c.name === name);
const reset = () => {
  calls.length = 0;
};

// ---- catalog: every variant, however many pages ---------------------------------------------
test('the catalog reads every variant across pages, including a product with more than 100 variants', async (t) => {
  t.after(reset);
  const all = [
    ...Array.from({ length: 130 }, (_, i) => variantNode({ productId: 1, variantId: 100 + i, sku: `BIG-${i}`, title: `Size ${i}`, options: [{ name: 'Size', value: String(i) }], product: { title: 'Big product' } })),
    ...Array.from({ length: 470 }, (_, i) => variantNode({ productId: 2 + i, variantId: 1000 + i, sku: `P-${i}`, product: { title: `Product ${i}` } })),
  ];
  handler = (name, { cursor }) => {
    assert.equal(name, 'CatalogVariants');
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + 250);
    const end = start + page.length;
    return { productVariants: { edges: page.map((node) => ({ node })), pageInfo: { hasNextPage: end < all.length, endCursor: String(end) } } };
  };

  const variants = await shopify.listProductsCatalog({ fresh: true });
  assert.equal(variants.length, 600);
  assert.equal(callsNamed('CatalogVariants').length, 3);
  assert.equal(variants.filter((v) => v.product.id === gid('Product', 1)).length, 130);
});

// ---- cache: fresh window, stale window, ?fresh ----------------------------------------------
test('cache: served from memory inside 30s, background refresh up to 60s, blocking refresh after, fresh bypasses', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  t.after(reset);
  let generation = 0;
  handler = () => {
    generation += 1;
    return { productVariants: { edges: [{ node: variantNode({ productId: 1, variantId: 1, sku: `G${generation}` }) }], pageInfo: { hasNextPage: false, endCursor: null } } };
  };
  const skuOf = (variants) => variants[0].sku;
  const fetches = () => callsNamed('CatalogVariants').length;

  reset();
  assert.equal(skuOf(await shopify.listProductsCatalog({ fresh: true })), 'G1');
  assert.equal(fetches(), 1);

  // within 30s: no Shopify call at all
  t.mock.timers.tick(20_000);
  assert.equal(skuOf(await shopify.listProductsCatalog()), 'G1');
  assert.equal(fetches(), 1);

  // 30s..60s: the cached copy is returned at once, one refresh runs in the background
  t.mock.timers.tick(20_000); // 40s old
  assert.equal(skuOf(await shopify.listProductsCatalog()), 'G1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches(), 2);
  assert.equal(skuOf(await shopify.listProductsCatalog()), 'G2'); // the refreshed copy, fresh again

  // older than 60s (the old window was 10 minutes): the caller waits for a new copy
  t.mock.timers.tick(61_000);
  assert.equal(skuOf(await shopify.listProductsCatalog()), 'G3');
  assert.equal(fetches(), 3);

  // ?fresh=true skips a perfectly good cached copy
  assert.equal(skuOf(await shopify.listProductsCatalog()), 'G3');
  assert.equal(fetches(), 3);
  assert.equal(skuOf(await shopify.listProductsCatalog({ fresh: true })), 'G4');
  assert.equal(fetches(), 4);
});

test('concurrent readers share one in-flight Shopify fetch', async (t) => {
  t.after(reset);
  reset();
  handler = () => ({ productVariants: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } });
  await Promise.all([shopify.listProductsCatalog({ fresh: true }), shopify.listProductsCatalog(), shopify.listProductsCatalog()]);
  // one fetch for the fresh call; the others found the same in-flight request (or its result)
  assert.ok(callsNamed('CatalogVariants').length <= 2);
});

// ---- SKU lookup: chunks of 50 ----------------------------------------------------------------
test('120 SKUs are looked up in chunks of 50 and every one comes back', async (t) => {
  t.after(reset);
  reset();
  const wanted = Array.from({ length: 120 }, (_, i) => `SKU-${i}`);
  handler = (name, { query }) => {
    assert.equal(name, 'VariantsBySku');
    const asked = [...query.matchAll(/sku:'([^']+)'/g)].map((m) => m[1]);
    return {
      productVariants: {
        edges: asked.map((sku) => ({ node: { id: gid('ProductVariant', sku), sku, price: '1.00', inventoryQuantity: 5, inventoryPolicy: 'DENY', inventoryItem: { id: gid('InventoryItem', sku) }, product: { id: gid('Product', 1), title: 'P' } } })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  };

  const variants = await shopify.findVariantsBySku(wanted);
  assert.equal(variants.length, 120);
  assert.deepEqual(new Set(variants.map((v) => v.sku)), new Set(wanted));
  const sizes = callsNamed('VariantsBySku').map((c) => [...c.variables.query.matchAll(/sku:/g)].length);
  assert.deepEqual(sizes, [50, 50, 20]);
});

test('duplicate SKUs are asked once; a chunk with more than 50 matches is paged', async (t) => {
  t.after(reset);
  reset();
  handler = (name, { cursor }) => {
    const page = cursor ? 1 : 0;
    const nodes = Array.from({ length: page ? 10 : 50 }, (_, i) => ({ id: gid('ProductVariant', `${page}-${i}`), sku: 'DUP', inventoryQuantity: 1, inventoryItem: { id: 'x' } }));
    return { productVariants: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: !page, endCursor: 'next' } } };
  };
  const variants = await shopify.findVariantsBySku(['DUP', 'DUP', 'DUP']);
  assert.equal(variants.length, 60);
  assert.equal(callsNamed('VariantsBySku').length, 2);
  assert.equal([...callsNamed('VariantsBySku')[0].variables.query.matchAll(/sku:/g)].length, 1);
});

test('SKU search values are escaped', async (t) => {
  t.after(reset);
  reset();
  handler = () => ({ productVariants: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } });
  await shopify.findVariantsBySku([`O'Neil\\x`]);
  assert.equal(callsNamed('VariantsBySku')[0].variables.query, `sku:'O\\'Neil\\\\x'`);
});

test('an empty SKU list makes no request', async (t) => {
  t.after(reset);
  reset();
  assert.deepEqual(await shopify.findVariantsBySku([]), []);
  assert.equal(calls.length, 0);
});

// ---- single product lookup -------------------------------------------------------------------
const productBody = (id, variantCount = 2, { cursor } = {}) => {
  const start = cursor ? Number(cursor) : 0;
  const count = Math.min(100, variantCount - start);
  const end = start + count;
  return {
    product: {
      id: gid('Product', id),
      title: 'Safety Helmet',
      handle: 'safety-helmet',
      descriptionHtml: '<p>Hard <b>hat</b></p>',
      productType: 'Helmets',
      vendor: 'Acme',
      tags: ['ppe'],
      status: 'ACTIVE',
      images: { edges: [{ node: { url: 'https://cdn.test/1.png' } }, { node: { url: 'https://cdn.test/2.png' } }] },
      variants: {
        edges: Array.from({ length: count }, (_, i) => ({
          node: { id: gid('ProductVariant', 500 + start + i), title: `Size ${start + i}`, sku: `HEL-${start + i}`, price: '499.00', compareAtPrice: null, inventoryQuantity: 4, selectedOptions: [{ name: 'Size', value: String(start + i) }] },
        })),
        pageInfo: { hasNextPage: end < variantCount, endCursor: String(end) },
      },
    },
  };
};

// One fake store: product 1001 (handle safety-helmet) with variants 500.. and SKUs HEL-n.
const store = (variantCount = 2) => (name, variables, query) => {
  switch (name) {
    case 'ProductById':
      return variables.id === gid('Product', 1001) ? productBody(1001, variantCount, variables) : { product: null };
    case 'VariantOwner':
      return { productVariant: variables.id === gid('ProductVariant', 501) ? { id: variables.id, product: { id: gid('Product', 1001) } } : null };
    case 'VariantBySku': {
      const sku = /sku:'([^']*)'/.exec(variables.query)[1];
      const hit = /^HEL-(\d+)$/i.exec(sku);
      return { productVariants: { edges: hit ? [{ node: { id: gid('ProductVariant', 500 + Number(hit[1])), sku: `HEL-${hit[1]}`, product: { id: gid('Product', 1001) } } }] : [] } };
    }
    case 'ProductByHandle':
      return { products: { edges: /handle:'safety-helmet'/.test(variables.query) ? [{ node: { id: gid('Product', 1001), handle: 'safety-helmet' } }] : [] } };
    default:
      throw new Error(`unexpected operation ${name} ${query}`);
  }
};

test('lookup by product id', async (t) => {
  t.after(reset);
  reset();
  handler = store();
  const product = await lookupProduct('1001');
  assert.equal(product.matchedBy, 'productId');
  assert.equal(product.matchedVariantId, undefined);
  assert.equal(product.id, '1001');
  assert.equal(product.handle, 'safety-helmet');
  assert.equal(product.description, 'Hard hat');
  assert.equal(product.category, 'Helmets');
  assert.equal(product.vendor, 'Acme');
  assert.deepEqual(product.tags, ['ppe']);
  assert.equal(product.status, 'active');
  assert.deepEqual(product.images, ['https://cdn.test/1.png', 'https://cdn.test/2.png']);
  assert.deepEqual(product.variants[0], { variantId: '500', sku: 'HEL-0', variantTitle: 'Size 0', options: { size: '0' }, price: '499.00', compareAtPrice: null, availableQty: 4 });
  assert.equal(callsNamed('VariantOwner').length, 0);
});

test('lookup by variant id', async (t) => {
  t.after(reset);
  reset();
  handler = store();
  const product = await lookupProduct('501');
  assert.equal(product.matchedBy, 'variantId');
  assert.equal(product.matchedVariantId, '501');
  assert.equal(product.id, '1001');
});

test('lookup by SKU (case-insensitive) reports the matched variant', async (t) => {
  t.after(reset);
  reset();
  handler = store();
  const product = await lookupProduct('hel-1');
  assert.equal(product.matchedBy, 'sku');
  assert.equal(product.matchedVariantId, '501');
  assert.equal(product.id, '1001');
});

test('lookup by handle', async (t) => {
  t.after(reset);
  reset();
  handler = store();
  const product = await lookupProduct('safety-helmet');
  assert.equal(product.matchedBy, 'handle');
  assert.equal(product.id, '1001');
});

test('lookup returns every variant of a product with more than 100 variants', async (t) => {
  t.after(reset);
  reset();
  handler = store(250);
  const product = await lookupProduct('1001');
  assert.equal(product.variants.length, 250);
  assert.equal(new Set(product.variants.map((v) => v.variantId)).size, 250);
  assert.equal(callsNamed('ProductById').length, 3);
});

test('lookup: unknown key finds nothing, and non-numeric keys never try an id', async (t) => {
  t.after(reset);
  reset();
  handler = store();
  assert.equal(await lookupProduct('nope'), null);
  assert.equal(callsNamed('ProductById').length, 0);
  assert.equal(callsNamed('VariantOwner').length, 0);

  reset();
  assert.equal(await lookupProduct('99999'), null); // numeric: product id, variant id, sku, handle all miss
  assert.deepEqual(calls.map((c) => c.name), ['ProductById', 'VariantOwner', 'VariantBySku', 'ProductByHandle']);
});

test('lookup: a key too long to be an id is not sent as one', async (t) => {
  t.after(reset);
  reset();
  handler = store();
  assert.equal(await lookupProduct('1'.repeat(40)), null);
  assert.equal(callsNamed('ProductById').length, 0);
});
