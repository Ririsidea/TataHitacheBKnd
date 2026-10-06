import axios from 'axios';
import { shopify } from '../../config/env';
import type {
  CatalogVariantNode,
  ProductDetailNode,
  RestockLine,
  ShopifyOrder,
  SkuVariantNode,
  Connection,
  PageInfo,
} from '../../types/shopify';

if (!shopify.storeDomain) throw new Error('SHOPIFY_STORE_DOMAIN is not set');
const storeDomain = shopify.storeDomain.replace(/^https?:\/\//, '');

const client = axios.create({
  baseURL: `https://${storeDomain}/admin/api/${shopify.apiVersion}`,
  headers: {
    'X-Shopify-Access-Token': shopify.accessToken,
    'Content-Type': 'application/json',
  },
});

// TEMPORARY (perf analysis task) - PERF_DEBUG=1 logs every Shopify REST/GraphQL call's
// duration. See the matching note in config/db.ts.
const perfDebug = process.env.PERF_DEBUG === '1';
if (perfDebug) {
  client.interceptors.request.use((config) => {
    (config as { _t0?: number })._t0 = Date.now();
    return config;
  });
  client.interceptors.response.use(
    (response) => {
      const t0 = (response.config as { _t0?: number })._t0;
      console.log(`[perf][shopify] ${response.config.method?.toUpperCase()} ${response.config.url} ${response.status} ${Date.now() - (t0 || Date.now())}ms`);
      return response;
    },
    (error) => {
      const t0 = error.config ? (error.config as { _t0?: number })._t0 : undefined;
      console.log(`[perf][shopify] ${error.config?.method?.toUpperCase()} ${error.config?.url} ERROR ${Date.now() - (t0 || Date.now())}ms`);
      return Promise.reject(error);
    }
  );
}

export async function listProducts(params: Record<string, unknown> = {}): Promise<unknown[]> {
  const { data } = await client.get('/products.json', { params });
  return data.products;
}

// The operation name (e.g. "CatalogVariants") from `query OpName(...) { ... }`, for the perf log.
const OPERATION_NAME = /^\s*(?:query|mutation)\s+(\w+)/;

export async function graphqlRequest<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const t0 = perfDebug ? Date.now() : 0;
  const { data } = await client.post('/graphql.json', { query, variables });
  if (perfDebug) {
    const opName = OPERATION_NAME.exec(query)?.[1] || (/^\s*mutation/.test(query) ? 'mutation' : 'query');
    console.log(`[perf][shopify-gql] ${opName} ${Date.now() - t0}ms`);
  }
  if (data.errors) {
    throw new Error((data.errors as { message: string }[]).map((e) => e.message).join('; '));
  }
  // Any mutation (inventory adjust, ...) can change stock or prices.
  if (/^\s*mutation\b/.test(query)) invalidateCatalogCache();
  return data.data as T;
}

export function extractNumericId(gid: string | null | undefined): string {
  const match = /\/(\d+)$/.exec(gid || '');
  return match ? (match[1] as string) : (gid as string);
}

// The catalog is read variant by variant (top-level productVariants) instead of through
// products -> variants: one flat cursor walk covers EVERY variant of every product, however
// many a product has, and stays well inside Shopify's per-query cost limit (nested
// first:100 x first:100 connections would exceed it).
const CATALOG_VARIANTS_QUERY = `
  query CatalogVariants($cursor: String) {
    productVariants(first: 250, after: $cursor) {
      edges {
        node {
          id
          sku
          title
          price
          compareAtPrice
          inventoryQuantity
          selectedOptions { name value }
          product {
            id
            title
            handle
            vendor
            productType
            tags
            status
            createdAt
            featuredImage { url }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchCatalogFromShopify(): Promise<CatalogVariantNode[]> {
  const variants: CatalogVariantNode[] = [];
  let cursor: string | null = null;

  do {
    const data: { productVariants: Connection<CatalogVariantNode> & { pageInfo: PageInfo } } = await graphqlRequest(
      CATALOG_VARIANTS_QUERY,
      { cursor }
    );
    for (const edge of data.productVariants.edges) variants.push(edge.node);
    const { hasNextPage, endCursor } = data.productVariants.pageInfo;
    cursor = hasNextPage ? endCursor : null;
  } while (cursor);

  return variants;
}

// Reading the whole catalog is many sequential Shopify round trips, so it is cached in
// memory (Shopify stays the source of truth):
//   - younger than CATALOG_FRESH_MS: served as-is.
//   - older, up to CATALOG_MAX_STALE_MS: served immediately while one background refresh runs.
//   - anything that can change stock/prices (a GraphQL mutation, or the inventory
//     webhook) calls invalidateCatalogCache(); the next read waits for a fresh copy.
//   - listProductsCatalog({ fresh: true }) skips the cache for a live read.
// Concurrent readers share a single in-flight Shopify fetch. Order creation never reads
// this cache - it validates stock live via findVariantsBySku - so it cannot oversell.
const CATALOG_FRESH_MS = 30 * 1000;
const CATALOG_MAX_STALE_MS = 60 * 1000;
const CATALOG_REFRESH_DEBOUNCE_MS = 1500;

interface CatalogCache {
  data: CatalogVariantNode[] | null;
  at: number;
  version: number;
  loadedVersion: number;
  inflight: Promise<CatalogVariantNode[]> | null;
  timer: NodeJS.Timeout | null;
}
const catalog: CatalogCache = { data: null, at: 0, version: 0, loadedVersion: -1, inflight: null, timer: null };

function refreshCatalog(): Promise<CatalogVariantNode[]> {
  if (catalog.inflight) return catalog.inflight;
  const startedAtVersion = catalog.version;
  catalog.inflight = fetchCatalogFromShopify()
    .then((variants) => {
      catalog.data = variants;
      catalog.at = Date.now();
      catalog.loadedVersion = startedAtVersion;
      return variants;
    })
    .finally(() => {
      catalog.inflight = null;
    });
  return catalog.inflight;
}

export function invalidateCatalogCache(): void {
  catalog.version += 1;
  // Warm the next copy shortly after a burst of changes so the next reader finds it ready.
  if (catalog.timer) clearTimeout(catalog.timer);
  catalog.timer = setTimeout(() => {
    refreshCatalog().catch((err: Error) => console.warn('[catalog] background refresh failed:', err.message));
  }, CATALOG_REFRESH_DEBOUNCE_MS);
  catalog.timer.unref?.();
}

// Every variant of the catalog as raw Shopify nodes (see CATALOG_VARIANTS_QUERY).
export async function listProductsCatalog({ fresh = false }: { fresh?: boolean } = {}): Promise<CatalogVariantNode[]> {
  // A live read marks the cached copy out of date; the two passes below then also cover a
  // fetch that was already in flight (it started before this call, so it may predate a change).
  if (fresh) catalog.version += 1;

  const isCurrent = catalog.data !== null && catalog.loadedVersion === catalog.version;
  const age = Date.now() - catalog.at;
  if (isCurrent && age < CATALOG_FRESH_MS) return catalog.data as CatalogVariantNode[];
  if (isCurrent && age < CATALOG_MAX_STALE_MS) {
    refreshCatalog().catch((err: Error) => console.warn('[catalog] background refresh failed:', err.message));
    return catalog.data as CatalogVariantNode[];
  }

  let variants: CatalogVariantNode[] = [];
  // A second pass covers a change that landed while the first fetch was in flight.
  for (let attempt = 0; attempt < 2; attempt++) {
    variants = await refreshCatalog();
    if (catalog.loadedVersion === catalog.version) break;
  }
  return variants;
}

const VARIANTS_BY_SKU_QUERY = `
  query VariantsBySku($query: String!, $cursor: String) {
    productVariants(first: 50, after: $cursor, query: $query) {
      edges {
        node {
          id
          sku
          price
          inventoryQuantity
          inventoryPolicy
          inventoryItem { id }
          product { id title }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Shopify search-syntax literal: 'text' with backslashes and quotes escaped.
const searchLiteral = (value: unknown): string => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// SKUs are looked up in chunks so an order of any size is checked in full (one query is
// capped at 50 variants); a chunk whose SKUs match more than 50 variants is paged too.
const SKU_CHUNK_SIZE = 50;

async function findVariantsBySkuChunk(skus: string[]): Promise<SkuVariantNode[]> {
  const query = skus.map((sku) => `sku:${searchLiteral(sku)}`).join(' OR ');
  const nodes: SkuVariantNode[] = [];
  let cursor: string | null = null;
  do {
    const data: { productVariants: Connection<SkuVariantNode> & { pageInfo: PageInfo } } = await graphqlRequest(
      VARIANTS_BY_SKU_QUERY,
      { query, cursor }
    );
    for (const edge of data.productVariants.edges) nodes.push(edge.node);
    const { hasNextPage, endCursor } = data.productVariants.pageInfo;
    cursor = hasNextPage ? endCursor : null;
  } while (cursor);
  return nodes;
}

export async function findVariantsBySku(skus: unknown[]): Promise<SkuVariantNode[]> {
  const unique = [...new Set(skus.map(String))];
  const byId = new Map<string, SkuVariantNode>();
  for (let i = 0; i < unique.length; i += SKU_CHUNK_SIZE) {
    for (const node of await findVariantsBySkuChunk(unique.slice(i, i + SKU_CHUNK_SIZE))) byId.set(node.id, node);
  }
  return [...byId.values()];
}

// ---- single product lookup (always live) ----------------------------------------------
const PRODUCT_QUERY = `
  query ProductById($id: ID!, $cursor: String) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
      productType
      vendor
      tags
      status
      images(first: 50) {
        edges { node { url } }
      }
      variants(first: 100, after: $cursor) {
        edges {
          node {
            id
            title
            sku
            price
            compareAtPrice
            inventoryQuantity
            selectedOptions { name value }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// Full product by numeric id or gid, with EVERY variant (variants are paged 100 at a time).
// Returns null when there is no such product.
export async function getProductDetail(idOrGid: string): Promise<ProductDetailNode | null> {
  const id = /^gid:/.test(idOrGid) ? idOrGid : `gid://shopify/Product/${idOrGid}`;
  let product: ProductDetailNode | null = null;
  let cursor: string | null = null;
  do {
    const data: { product: ProductDetailNode | null } = await graphqlRequest(PRODUCT_QUERY, { id, cursor });
    if (!data.product) return null;
    if (!product) {
      product = data.product;
    } else {
      product.variants.edges.push(...data.product.variants.edges);
    }
    const { hasNextPage, endCursor } = data.product.variants.pageInfo;
    cursor = hasNextPage ? endCursor : null;
  } while (cursor);
  return product;
}

// The numeric id of the product a variant belongs to, or null.
export async function findProductIdByVariantId(variantId: string): Promise<string | null> {
  const data = await graphqlRequest<{ productVariant: { id: string; product: { id: string } } | null }>(
    `query VariantOwner($id: ID!) { productVariant(id: $id) { id product { id } } }`,
    { id: `gid://shopify/ProductVariant/${variantId}` }
  );
  return data.productVariant ? extractNumericId(data.productVariant.product.id) : null;
}

// Exact SKU match (case-insensitive - Shopify's own SKU search is), as { productId, variantId }.
export async function findVariantRefBySku(sku: string): Promise<{ productId: string; variantId: string } | null> {
  const data = await graphqlRequest<{ productVariants: Connection<{ id: string; sku: string | null; product: { id: string } }> }>(
    `query VariantBySku($query: String!) {
      productVariants(first: 10, query: $query) { edges { node { id sku product { id } } } }
    }`,
    { query: `sku:${searchLiteral(sku)}` }
  );
  const wanted = String(sku).toLowerCase();
  const nodes = data.productVariants.edges.map((edge) => edge.node).filter((n) => String(n.sku || '').toLowerCase() === wanted);
  const node = nodes.find((n) => n.sku === sku) || nodes[0];
  return node ? { productId: extractNumericId(node.product.id), variantId: extractNumericId(node.id) } : null;
}

// The numeric id of the product whose handle is exactly `handle`, or null.
export async function findProductIdByHandle(handle: string): Promise<string | null> {
  const data = await graphqlRequest<{ products: Connection<{ id: string; handle: string }> }>(
    `query ProductByHandle($query: String!) {
      products(first: 5, query: $query) { edges { node { id handle } } }
    }`,
    { query: `handle:${searchLiteral(handle)}` }
  );
  const node = data.products.edges.map((edge) => edge.node).find((n) => n.handle === String(handle).toLowerCase());
  return node ? extractNumericId(node.id) : null;
}

export async function listInventoryLevels(params: Record<string, unknown> = {}): Promise<unknown[]> {
  const { data } = await client.get('/inventory_levels.json', { params });
  return data.inventory_levels;
}

export async function createDraftOrder(draftOrderPayload: Record<string, unknown>): Promise<{ id: number | string }> {
  const { data } = await client.post('/draft_orders.json', { draft_order: draftOrderPayload });
  return data.draft_order;
}

export async function completeDraftOrder(draftOrderId: number | string): Promise<{ order_id: number | string }> {
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
export async function deleteDraftOrder(draftOrderId: number | string): Promise<void> {
  await client.delete(`/draft_orders/${draftOrderId}.json`);
}

export async function getOrder(orderId: number | string): Promise<ShopifyOrder> {
  const { data } = await client.get(`/orders/${orderId}.json`);
  return data.order;
}

// Several orders in ONE request (Shopify allows up to 250 ids); status=any so cancelled and
// archived orders come back too. Used by the background reconciler.
export async function listOrdersByIds(orderIds: (number | string)[]): Promise<ShopifyOrder[]> {
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
export async function cancelOrder(
  orderId: number | string,
  { restock = true, reason = 'other' }: { restock?: boolean; reason?: string } = {}
): Promise<ShopifyOrder> {
  const { data } = await client.post(`/orders/${orderId}/cancel.json`, { restock, reason });
  invalidateCatalogCache(); // cancelling can hand stock back
  return data.order;
}

let cachedLocationId: string | null = null;
async function getPrimaryLocationId(): Promise<string> {
  if (cachedLocationId) return cachedLocationId;
  const data = await graphqlRequest<{ locations: Connection<{ id: string }> }>('{ locations(first: 1) { edges { node { id } } } }');
  const id = data.locations.edges[0]?.node?.id;
  if (!id) throw new Error('The Shopify store has no location');
  cachedLocationId = id;
  return id;
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
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface InventoryAdjustment {
  inventoryItemId: string;
  delta: number;
}

// Direct, relative inventory adjustment. Shopify's adjust mutation requires the
// caller to state the quantity it expects to be adjusting from (an optimistic-
// concurrency guard) and rejects the whole batch if that's stale - which happens
// legitimately when two compensating restocks for different orders race each
// other. Each attempt re-reads the current quantity fresh and retries the whole
// batch on that specific conflict, so a losing attempt simply tries again against
// the now-current value rather than silently dropping the adjustment.
async function adjustInventory(adjustments: InventoryAdjustment[]): Promise<void> {
  if (!adjustments.length) return;
  const locationId = await getPrimaryLocationId();

  for (let attempt = 1; attempt <= MAX_ADJUST_ATTEMPTS; attempt++) {
    const changes: { inventoryItemId: string; locationId: string; delta: number; changeFromQuantity: number }[] = [];
    for (const a of adjustments) {
      const query = CURRENT_QUANTITY_QUERY.replace('%LOCATION%', locationId);
      const data = await graphqlRequest<{
        inventoryItem?: { inventoryLevel?: { quantities?: { quantity: number }[] } };
      }>(query, { id: a.inventoryItemId });
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
      const data = await graphqlRequest<{ inventoryAdjustQuantities: { userErrors: { message: string }[] } }>(mutation, {
        input: { name: 'available', reason: 'correction', changes },
      });
      const errors = data.inventoryAdjustQuantities.userErrors;
      if (errors.length) {
        throw new Error(errors.map((e) => e.message).join('; '));
      }
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isStaleQuantityConflict = /changeFromQuantity/i.test(message);
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
export async function restockInventoryForOrder(lineItems: RestockLine[]): Promise<void> {
  await adjustInventory(lineItems.map((li) => ({ inventoryItemId: li.inventoryItemId, delta: li.quantity })));
}
