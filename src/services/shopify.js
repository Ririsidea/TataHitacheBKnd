const axios = require('axios');
const { shopify } = require('../config/env');

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
  return data.data;
}

function extractNumericId(gid) {
  const match = /\/(\d+)$/.exec(gid || '');
  return match ? match[1] : gid;
}

const CATALOG_PRODUCTS_QUERY = `
  query CatalogProducts($cursor: String) {
    products(first: 50, after: $cursor, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          title
          productType
          featuredImage { url }
          variants(first: 5) {
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

// Products (with their first variant's price/SKU/stock and category) pulled live
// from Shopify - there is no local product cache, Shopify is the only source of truth.
async function listProductsCatalog() {
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
  const { data } = await client.put(`/draft_orders/${draftOrderId}/complete.json`);
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

// Compensating action for the rare race where two concurrent orders both pass their
// own stock check and Shopify's own inventory policy still lets the second one land -
// cancelling with restock:true *requests* Shopify hand the deducted quantity back.
// In testing this isn't fully reliable for orders Shopify already marked paid (see
// restockInventoryForOrder below, which is the actual guarantee we rely on).
async function cancelOrder(orderId, { restock = true, reason = 'other' } = {}) {
  const { data } = await client.post(`/orders/${orderId}/cancel.json`, { restock, reason });
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
  listProducts,
  listInventoryLevels,
  createDraftOrder,
  completeDraftOrder,
  deleteDraftOrder,
  getOrder,
  cancelOrder,
  restockInventoryForOrder,
  listProductsCatalog,
  findVariantsBySku,
  getProductDetail,
  extractNumericId,
};
