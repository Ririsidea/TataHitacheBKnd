const axios = require('axios');
const { shopify } = require('../../config/env');

const storeDomain = shopify.storeDomain.replace(/^https?:\/\//, '');

const client = axios.create({
  baseURL: `https://${storeDomain}/admin/api/${shopify.apiVersion}`,
  headers: {
    'X-Shopify-Access-Token': shopify.accessToken,
    'Content-Type': 'application/json',
  },
});

async function listProducts(params = {}) {
  const { data } = await client.get('/products.json', { params });
  return data.products;
}

async function graphqlRequest(query, variables = {}) {
  const { data } = await client.post('/graphql.json', { query, variables });
  if (data.errors) {
    throw new Error(data.errors.map((e) => e.message).join('; '));
  }
  // Any mutation (inventory adjust, order edit, ...) can change stock or prices.
  if (/^\s*mutation\b/.test(query)) invalidateCatalogCache();
  return data.data;
}

function extractNumericId(gid) {
  const match = /\/(\d+)$/.exec(gid || '');
  return match ? match[1] : gid;
}

const CATALOG_PRODUCTS_QUERY = `
  query CatalogProducts($cursor: String) {
    products(first: 100, after: $cursor, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          title
          productType
          featuredImage { url }
          variants(first: 1) {
            edges {
              node { id sku price inventoryQuantity }
            }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

async function fetchCatalogFromShopify() {
  const products = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphqlRequest(CATALOG_PRODUCTS_QUERY, { cursor });
    for (const edge of data.products.edges) {
      products.push(edge.node);
      cursor = edge.cursor;
    }
    hasNextPage = data.products.pageInfo.hasNextPage;
  }

  return products;
}

// Reading the whole catalog is many sequential Shopify round trips, so it is cached in
// memory (Shopify stays the source of truth):
//   - younger than CATALOG_FRESH_MS: served as-is.
//   - older, up to CATALOG_MAX_STALE_MS: served immediately while one background refresh runs.
//   - anything that can change stock/prices (a GraphQL mutation, or an inventory/product
//     webhook) calls invalidateCatalogCache(); the next read waits for a fresh copy.
// Concurrent readers share a single in-flight Shopify fetch. Order creation never reads
// this cache - it validates stock live via findVariantsBySku - so it cannot oversell.
const CATALOG_FRESH_MS = 30 * 1000;
const CATALOG_MAX_STALE_MS = 10 * 60 * 1000;
const CATALOG_REFRESH_DEBOUNCE_MS = 1500;
const catalog = { data: null, at: 0, version: 0, loadedVersion: -1, inflight: null, timer: null };

function refreshCatalog() {
  if (catalog.inflight) return catalog.inflight;
  const startedAtVersion = catalog.version;
  catalog.inflight = fetchCatalogFromShopify()
    .then((products) => {
      catalog.data = products;
      catalog.at = Date.now();
      catalog.loadedVersion = startedAtVersion;
      return products;
    })
    .finally(() => {
      catalog.inflight = null;
    });
  return catalog.inflight;
}

function invalidateCatalogCache() {
  catalog.version += 1;
  // Warm the next copy shortly after a burst of changes so the next reader finds it ready.
  clearTimeout(catalog.timer);
  catalog.timer = setTimeout(() => {
    refreshCatalog().catch((err) => console.warn('[catalog] background refresh failed:', err.message));
  }, CATALOG_REFRESH_DEBOUNCE_MS);
  catalog.timer.unref?.();
}

async function listProductsCatalog() {
  const isCurrent = catalog.data && catalog.loadedVersion === catalog.version;
  const age = Date.now() - catalog.at;
  if (isCurrent && age < CATALOG_FRESH_MS) return catalog.data;
  if (isCurrent && age < CATALOG_MAX_STALE_MS) {
    refreshCatalog().catch((err) => console.warn('[catalog] background refresh failed:', err.message));
    return catalog.data;
  }

  let products;
  // A second pass covers a change that landed while the first fetch was in flight.
  for (let attempt = 0; attempt < 2; attempt++) {
    products = await refreshCatalog();
    if (catalog.loadedVersion === catalog.version) break;
  }
  return products;
}

const VARIANTS_BY_SKU_QUERY = `
  query VariantsBySku($query: String!) {
    productVariants(first: 50, query: $query) {
      edges {
        node {
          id
          sku
          price
          inventoryQuantity
          inventoryPolicy
          inventoryItem { id }
          product { title }
        }
      }
    }
  }
`;

async function findVariantsBySku(skus) {
  if (!skus.length) return [];
  const clauses = skus.map((sku) => `sku:'${String(sku).replace(/'/g, "\\'")}'`);
  const data = await graphqlRequest(VARIANTS_BY_SKU_QUERY, { query: clauses.join(' OR ') });
  return data.productVariants.edges.map((edge) => edge.node);
}

const PRODUCT_DETAIL_QUERY = `
  query ProductDetail($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      productType
      tags
      images(first: 10) {
        edges { node { url altText } }
      }
      variants(first: 20) {
        edges {
          node {
            id
            title
            sku
            price
            inventoryQuantity
            selectedOptions { name value }
          }
        }
      }
    }
  }
`;

// Full detail for the quick-view modal - fetched live, on demand, for a single product.
async function getProductDetail(gid) {
  const data = await graphqlRequest(PRODUCT_DETAIL_QUERY, { id: gid });
  return data.product;
}

async function listInventoryLevels(params = {}) {
  const { data } = await client.get('/inventory_levels.json', { params });
  return data.inventory_levels;
}

async function createDraftOrder(draftOrderPayload) {
  const { data } = await client.post('/draft_orders.json', { draft_order: draftOrderPayload });
  return data.draft_order;
}

async function completeDraftOrder(draftOrderId) {
  // payment_pending=true: the order is created with payment status "pending" instead of
  // Shopify's default of marking a completed draft order as paid. Stock is still deducted.
  const { data } = await client.put(`/draft_orders/${draftOrderId}/complete.json`, undefined, {
    params: { payment_pending: true },
  });
  invalidateCatalogCache(); // completing an order deducts stock
  return data.draft_order;
}

// Best-effort cleanup for a draft order that never completed (e.g. the completion
// call failed) - draft orders don't touch inventory until completed, so this just
// avoids leaving dangling drafts in Shopify Admin.
async function deleteDraftOrder(draftOrderId) {
  await client.delete(`/draft_orders/${draftOrderId}.json`);
}

async function getOrder(orderId) {
  const { data } = await client.get(`/orders/${orderId}.json`);
  return data.order;
}

// Several orders in ONE request (Shopify allows up to 250 ids); status=any so cancelled and
// archived orders come back too. Used by the background reconciler.
async function listOrdersByIds(orderIds) {
  if (!orderIds.length) return [];
  const { data } = await client.get('/orders.json', {
    params: { ids: orderIds.join(','), status: 'any', limit: 250 },
  });
  return data.orders;
}

// Compensating action for the rare race where two concurrent orders both pass their
// own stock check and Shopify's own inventory policy still lets the second one land -
// cancelling with restock:true *requests* Shopify hand the deducted quantity back.
// In testing this isn't fully reliable for orders Shopify already marked paid (see
// restockInventoryForOrder below, which is the actual guarantee we rely on).
async function cancelOrder(orderId, { restock = true, reason = 'other' } = {}) {
  const { data } = await client.post(`/orders/${orderId}/cancel.json`, { restock, reason });
  invalidateCatalogCache(); // cancelling can hand stock back
  return data.order;
}

let cachedLocationId = null;
async function getPrimaryLocationId() {
  if (cachedLocationId) return cachedLocationId;
  const data = await graphqlRequest('{ locations(first: 1) { edges { node { id } } } }');
  cachedLocationId = data.locations.edges[0]?.node?.id;
  return cachedLocationId;
}

const CURRENT_QUANTITY_QUERY = `
  query CurrentQty($id: ID!) {
    inventoryItem(id: $id) {
      inventoryLevel(locationId: "%LOCATION%") {
        quantities(names: ["available"]) { quantity }
      }
    }
  }
`;

const MAX_ADJUST_ATTEMPTS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Direct, relative inventory adjustment. Shopify's adjust mutation requires the
// caller to state the quantity it expects to be adjusting from (an optimistic-
// concurrency guard) and rejects the whole batch if that's stale - which happens
// legitimately when two compensating restocks for different orders race each
// other. Each attempt re-reads the current quantity fresh and retries the whole
// batch on that specific conflict, so a losing attempt simply tries again against
// the now-current value rather than silently dropping the adjustment.
async function adjustInventory(adjustments) {
  if (!adjustments.length) return;
  const locationId = await getPrimaryLocationId();

  for (let attempt = 1; attempt <= MAX_ADJUST_ATTEMPTS; attempt++) {
    const changes = [];
    for (const a of adjustments) {
      const query = CURRENT_QUANTITY_QUERY.replace('%LOCATION%', locationId);
      const data = await graphqlRequest(query, { id: a.inventoryItemId });
      const current = data.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity ?? 0;
      changes.push({
        inventoryItemId: a.inventoryItemId,
        locationId,
        delta: a.delta,
        changeFromQuantity: current,
      });
    }

    const key = `adjust-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mutation = `
      mutation($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: "${key}") {
          userErrors { field message }
        }
      }
    `;

    try {
      const data = await graphqlRequest(mutation, {
        input: { name: 'available', reason: 'correction', changes },
      });
      const errors = data.inventoryAdjustQuantities.userErrors;
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join('; '));
      }
      return;
    } catch (err) {
      const isStaleQuantityConflict = /changeFromQuantity/i.test(err.message);
      if (!isStaleQuantityConflict || attempt === MAX_ADJUST_ATTEMPTS) {
        throw err;
      }
      await sleep(75 * attempt);
    }
  }
}

// Reverses the inventory deduction for a set of {inventoryItemId, quantity} line items
// - the authoritative restock path for our own rollback, independent of whether
// Shopify's cancel-with-restock happens to apply it for this order's payment state.
async function restockInventoryForOrder(lineItems) {
  await adjustInventory(lineItems.map((li) => ({ inventoryItemId: li.inventoryItemId, delta: li.quantity })));
}

module.exports = {
  graphqlRequest,
  listProducts,
  listInventoryLevels,
  createDraftOrder,
  completeDraftOrder,
  deleteDraftOrder,
  getOrder,
  listOrdersByIds,
  cancelOrder,
  restockInventoryForOrder,
  listProductsCatalog,
  invalidateCatalogCache,
  findVariantsBySku,
  getProductDetail,
  extractNumericId,
};
