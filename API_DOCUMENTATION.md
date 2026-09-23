# THCM MAP ↔ Shopify Integration — API Documentation

Implementation-ready reference for the Tata Hitachi Construction Machinery (THCM) MAP Portal ↔ Shopify integration.

Every Shopify call below was checked against the current Shopify Admin API docs (`shopify.dev`, API version `2026-10`, matching this repo's `SHOPIFY_API_VERSION`). Each API is marked:

- ✅ **Implemented** — exists in this codebase today; the file/function is named so you can find it.
- 📘 **Reference** — a real, current Shopify Admin API capability that is **not** wired up in this repo yet. Included because it's part of the requested spec, not invented.

Section 8 documents the MAP backend's **actual** routes (from `src/routes/*.js`), not a hypothetical spec — so nothing below points at an endpoint that doesn't exist.

---

## 0. Conventions

**Shopify base URL**

```text
https://YOUR_STORE.myshopify.com/admin/api/2026-10
```

**MAP API base URL**

```text
http://localhost:8001/api          (local dev, per .env PORT)
https://YOUR_MAP_API.com/api       (production placeholder)
```

**MAP response envelope** (every `/api/*` route in this repo returns this shape):

```json
// success
{ "success": true, "data": { }, "message": "optional" }

// failure
{ "success": false, "message": "human-readable reason" }
```

---

# 1. Authentication (Shopify side)

**Headers:**

```http
Content-Type: application/json
X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN
```

The Admin Access Token is an **offline token** issued to the custom app (Partner Dashboard → App → API credentials). It must never be shipped to a browser/frontend — see Section 9.

---

# 2. PRODUCT APIs

## 2.1 Get Product

✅ **Implemented** — `src/services/shopify.js#getProductDetail`, called from `GET /api/map/product/:id`.

**Purpose:** Fetch a single product's title, status, variants, SKUs and inventory item IDs.

**Method:**

```text
POST
```

**Endpoint:**

```text
https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json
```

**Headers:**

```http
Content-Type: application/json
X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN
```

**Required Scope:**

```text
read_products
```

**GraphQL Query:**

```graphql
query ProductDetail($id: ID!) {
  product(id: $id) {
    id
    title
    status
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
          inventoryItem { id }
          selectedOptions { name value }
        }
      }
    }
  }
}
```

**Request / Variables:**

```json
{ "id": "gid://shopify/Product/8123456789012" }
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"query":"query ProductDetail($id: ID!) { product(id: $id) { id title status variants(first: 20) { edges { node { id sku inventoryItem { id } } } } } }","variables":{"id":"gid://shopify/Product/8123456789012"}}'
```

**Success Response:**

```json
{
  "data": {
    "product": {
      "id": "gid://shopify/Product/8123456789012",
      "title": "THCM Safety Helmet",
      "status": "ACTIVE",
      "variants": {
        "edges": [
          {
            "node": {
              "id": "gid://shopify/ProductVariant/44123456789",
              "sku": "THCM-001",
              "price": "499.00",
              "inventoryItem": { "id": "gid://shopify/InventoryItem/48123456789" }
            }
          }
        ]
      }
    }
  }
}
```

**Error Response:**

```json
{ "errors": [{ "message": "Product does not exist" }] }
```

MAP wraps this as: `{ "success": false, "message": "Product not found" }` (HTTP 404).

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | GID | Yes | `gid://shopify/Product/{numeric_id}` |
| `status` | ProductStatus | No | `ACTIVE` \| `ARCHIVED` \| `DRAFT` |
| `variants.edges[].node.sku` | String | No | Used to match MAP line items to Shopify inventory |
| `variants.edges[].node.inventoryItem.id` | GID | No | Required for inventory adjust/set calls (Section 4) |

---

## 2.2 Get Product Variant

📘 **Reference** — single-variant lookup by variant GID. This repo instead fetches variants nested under the product/SKU queries (2.1, 2.3); use this when you already hold a variant ID.

**Purpose:** Fetch one variant's SKU, price, inventory item ID and parent product ID.

**Method:** `POST`

**Endpoint:** `https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json`

**Headers:** same as 2.1

**Required Scope:** `read_products`

**GraphQL Query:**

```graphql
query GetVariant($id: ID!) {
  productVariant(id: $id) {
    id
    sku
    price
    inventoryQuantity
    inventoryItem { id }
    product { id title }
  }
}
```

**Request / Variables:**

```json
{ "id": "gid://shopify/ProductVariant/44123456789" }
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"query":"query GetVariant($id: ID!) { productVariant(id: $id) { id sku price inventoryItem { id } product { id } } }","variables":{"id":"gid://shopify/ProductVariant/44123456789"}}'
```

**Success Response:**

```json
{
  "data": {
    "productVariant": {
      "id": "gid://shopify/ProductVariant/44123456789",
      "sku": "THCM-001",
      "price": "499.00",
      "inventoryItem": { "id": "gid://shopify/InventoryItem/48123456789" },
      "product": { "id": "gid://shopify/Product/8123456789012", "title": "THCM Safety Helmet" }
    }
  }
}
```

**Error Response:**

```json
{ "data": { "productVariant": null } }
```

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | GID | Yes | `gid://shopify/ProductVariant/{numeric_id}` |
| `inventoryItem.id` | GID | No | Key used by Section 4 inventory mutations |
| `product.id` | GID | No | Parent product GID |

---

## 2.3 Find Variant by SKU

✅ **Implemented** — `src/services/shopify.js#findVariantsBySku`, used by `POST /api/map/create-order` (stock validation) and by the order-cancel restock path.

**Flow:**

```text
SKU → productVariants(query: "sku:'X'") → Product Variant → Inventory Item
```

**Purpose:** Resolve one or more SKUs to their variant + inventory item in a single call.

**Method:** `POST`

**Endpoint:** `https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json`

**Headers:** same as 2.1

**Required Scope:** `read_products`

**GraphQL Query:**

```graphql
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
```

**Request / Variables:**

```json
{ "query": "sku:'THCM-001' OR sku:'THCM-002'" }
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"query":"query VariantsBySku($query: String!) { productVariants(first: 50, query: $query) { edges { node { id sku inventoryQuantity inventoryItem { id } } } } }","variables":{"query":"sku:'THCM-001'"}}'
```

**Success Response:**

```json
{
  "data": {
    "productVariants": {
      "edges": [
        {
          "node": {
            "id": "gid://shopify/ProductVariant/44123456789",
            "sku": "THCM-001",
            "inventoryQuantity": 42,
            "inventoryItem": { "id": "gid://shopify/InventoryItem/48123456789" }
          }
        }
      ]
    }
  }
}
```

**Error Response:**

```json
{ "data": { "productVariants": { "edges": [] } } }
```

MAP treats an unmatched SKU as `409 Insufficient stock - Unknown SKU: {sku}`.

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | String | Yes | Shopify search syntax, e.g. `sku:'ABC' OR sku:'DEF'` |
| `inventoryQuantity` | Int | No | Live available quantity at the shop's default context |
| `inventoryItem.id` | GID | No | Required for Section 4 mutations |

---

# 3. LOCATION APIs

## 3.1 Get Shopify Locations

📘 **Reference (full query)** / ✅ **Implemented (minimal form)** — `src/services/shopify.js#getPrimaryLocationId` currently fetches only `locations(first: 1)` and caches the first (and, today, only) location's ID, matching this store's single-warehouse setup. The full query below is the general-purpose version for a multi-warehouse rollout (Bangalore, Dharwad, Kharagpur).

**Purpose:** List Shopify's fulfillment locations, to be mapped 1:1 to MAP warehouses.

**Method:** `POST`

**Endpoint:** `https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json`

**Headers:** same as 2.1

**Required Scope:**

```text
read_locations
```

**GraphQL Query:**

```graphql
query Locations($cursor: String) {
  locations(first: 50, after: $cursor) {
    edges {
      node {
        id
        name
        isActive
        address {
          address1
          city
          province
          country
          zip
        }
      }
    }
    pageInfo { hasNextPage }
  }
}
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"query":"query { locations(first: 50) { edges { node { id name isActive address { city } } } } }"}'
```

**Success Response:**

```json
{
  "data": {
    "locations": {
      "edges": [
        {
          "node": {
            "id": "gid://shopify/Location/67123456",
            "name": "THCM Bangalore Warehouse",
            "isActive": true,
            "address": { "city": "Bangalore", "province": "Karnataka", "country": "India" }
          }
        }
      ],
      "pageInfo": { "hasNextPage": false }
    }
  }
}
```

**Error Response:**

```json
{ "errors": [{ "message": "Access denied for locations field" }] }
```

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | GID | Yes | `gid://shopify/Location/{numeric_id}` — actual Shopify location IDs; do not hardcode/guess these, read them from this call |
| `name` | String | No | Match against MAP warehouse names |
| `isActive` | Boolean | No | Exclude inactive locations from warehouse mapping |

---

# 4. INVENTORY APIs

## 4.1 Get Inventory

✅ **Implemented (available only)** — `src/services/shopify.js#listInventoryLevels` (REST) for bulk reads, and the inline `CURRENT_QUANTITY_QUERY` GraphQL query for a single item's live `available` count before an adjustment.
📘 **Reference (all quantity states)** — `committed` / `incoming` / `on_hand` / `reserved` require the GraphQL `InventoryLevel.quantities` field; REST `inventory_levels.json` only ever returns `available`.

**Purpose:** Read current stock for a SKU/location.

**Method:** `POST`

**Endpoint:** `https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json`

**Headers:** same as 2.1

**Required Scope:**

```text
read_inventory
```

**GraphQL Query:**

```graphql
query InventoryForItem($id: ID!, $locationId: ID!) {
  inventoryItem(id: $id) {
    id
    sku
    inventoryLevel(locationId: $locationId) {
      location { id name }
      quantities(names: ["available", "committed", "incoming", "on_hand", "reserved"]) {
        name
        quantity
      }
    }
  }
}
```

**Request / Variables:**

```json
{
  "id": "gid://shopify/InventoryItem/48123456789",
  "locationId": "gid://shopify/Location/67123456"
}
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"query":"query($id: ID!, $locationId: ID!) { inventoryItem(id: $id) { sku inventoryLevel(locationId: $locationId) { quantities(names: [\"available\",\"committed\",\"incoming\",\"on_hand\",\"reserved\"]) { name quantity } } } }","variables":{"id":"gid://shopify/InventoryItem/48123456789","locationId":"gid://shopify/Location/67123456"}}'
```

**Success Response:**

```json
{
  "data": {
    "inventoryItem": {
      "sku": "THCM-001",
      "inventoryLevel": {
        "location": { "id": "gid://shopify/Location/67123456", "name": "Bangalore" },
        "quantities": [
          { "name": "available", "quantity": 42 },
          { "name": "committed", "quantity": 5 },
          { "name": "incoming", "quantity": 0 },
          { "name": "on_hand", "quantity": 47 },
          { "name": "reserved", "quantity": 0 }
        ]
      }
    }
  }
}
```

**Error Response:**

```json
{ "data": { "inventoryItem": null } }
```

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | GID | Yes | InventoryItem GID from Section 2 |
| `locationId` | GID | Yes | Location GID from Section 3 |
| `quantities[].name` | String | Yes | One of `available`, `committed`, `incoming`, `on_hand`, `reserved` |

---

## 4.2 Check Stock

✅ **Implemented as inline validation, not a standalone endpoint** — `src/controllers/map.controller.js#validateStock`, run automatically at the start of `POST /api/map/create-order` (Section 8.2) before any Shopify order is created. It is documented here as its own contract because that's how the frontend should reason about it, even though no separate `/check-stock` route exists.

**Purpose:** Confirm a requested quantity is available before attempting to place an order.

**Input:**

```json
{
  "sku": "THCM-001",
  "quantity": 2
}
```

Internally this resolves the SKU via 2.3 (`findVariantsBySku`) and compares `quantity` against the variant's live `inventoryQuantity`.

**Response (conceptual — returned as part of order creation, not a separate call):**

```json
{
  "available": 10,
  "requested": 2,
  "canOrder": true
}
```

**Error Response (insufficient stock, surfaced by `POST /api/map/create-order`):**

```json
{
  "success": false,
  "message": "Insufficient stock - THCM-001: requested 5, only 2 available"
}
```

HTTP status: `409`.

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sku` | String | Yes | Must match a Shopify variant SKU exactly |
| `quantity` | Integer | Yes | Positive integer |
| `canOrder` | Boolean | — | `quantity <= available` |

---

## 4.3 Adjust Inventory

✅ **Implemented** — `src/services/shopify.js#adjustInventory` / `restockInventoryForOrder`, used only to **restock** (positive delta) after a cancellation or a concurrency rollback. Order creation itself never calls this — Shopify's own draft-order completion (Section 5.1) performs the decrement, per the rule in Section 11.

**Purpose:** Apply a relative (+/-) change to available inventory.

**Method:**

```text
POST
```

**Endpoint:**

```text
https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json
```

**Headers:**

```http
Content-Type: application/json
X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN
```

**Required Scope:**

```text
write_inventory
```

**GraphQL Mutation:**

```graphql
mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: "adjust-1699999999-abc123") {
    inventoryAdjustmentGroup {
      changes { name delta quantityAfterChange }
    }
    userErrors { field message }
  }
}
```

> As of API version `2026-04`, this mutation requires an `@idempotent(key: "...")` directive with a caller-generated unique key per logical operation — already applied in this repo's implementation.

**Request / Variables — stock reduction (`delta = -2`):**

```json
{
  "input": {
    "name": "available",
    "reason": "correction",
    "referenceDocumentUri": "gid://map/Order/MAP-10234",
    "changes": [
      {
        "inventoryItemId": "gid://shopify/InventoryItem/48123456789",
        "locationId": "gid://shopify/Location/67123456",
        "delta": -2,
        "changeFromQuantity": 42
      }
    ]
  }
}
```

**Request / Variables — stock increase / restock (`delta = +2`):**

```json
{
  "input": {
    "name": "available",
    "reason": "restock",
    "referenceDocumentUri": "gid://map/Order/MAP-10234",
    "changes": [
      {
        "inventoryItemId": "gid://shopify/InventoryItem/48123456789",
        "locationId": "gid://shopify/Location/67123456",
        "delta": 2,
        "changeFromQuantity": 40
      }
    ]
  }
}
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{
    "query": "mutation($input: InventoryAdjustQuantitiesInput!) { inventoryAdjustQuantities(input: $input) @idempotent(key: \"adjust-1699999999-abc123\") { userErrors { field message } } }",
    "variables": {
      "input": {
        "name": "available",
        "reason": "restock",
        "changes": [
          { "inventoryItemId": "gid://shopify/InventoryItem/48123456789", "locationId": "gid://shopify/Location/67123456", "delta": 2, "changeFromQuantity": 40 }
        ]
      }
    }
  }'
```

**Success Response:**

```json
{
  "data": {
    "inventoryAdjustQuantities": {
      "inventoryAdjustmentGroup": {
        "changes": [{ "name": "available", "delta": 2, "quantityAfterChange": 42 }]
      },
      "userErrors": []
    }
  }
}
```

**Error Response (stale `changeFromQuantity` — this repo retries on this specific error, up to 5 attempts):**

```json
{
  "data": {
    "inventoryAdjustQuantities": {
      "inventoryAdjustmentGroup": null,
      "userErrors": [
        { "field": ["input", "changes", "0", "changeFromQuantity"], "message": "changeFromQuantity does not match the current quantity" }
      ]
    }
  }
}
```

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | String | Yes | Quantity bucket, e.g. `"available"` |
| `reason` | String | Yes | e.g. `correction`, `restock`, `cycle_count_available` |
| `changes[].inventoryItemId` | GID | Yes | From Section 2 |
| `changes[].locationId` | GID | Yes | From Section 3 |
| `changes[].delta` | Int | Yes | Signed change; negative reduces, positive increases |
| `changes[].changeFromQuantity` | Int | No | Optimistic-concurrency guard; mismatch fails the whole batch |

---

## 4.4 Set Inventory

📘 **Reference** — not used in this repo; documented for a future SAP-driven full stock recount/sync.

**Purpose:** Overwrite inventory to an exact absolute value (vs. a relative change).

**Method:** `POST`

**Endpoint:** `https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json`

**Headers:** same as 4.3

**Required Scope:**

```text
write_inventory
```

**GraphQL Mutation:**

```graphql
mutation SetInventory($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) @idempotent(key: "set-1699999999-xyz789") {
    inventoryAdjustmentGroup {
      changes { name quantityAfterChange }
    }
    userErrors { field message }
  }
}
```

**Request / Variables:**

```json
{
  "input": {
    "name": "available",
    "reason": "correction",
    "referenceDocumentUri": "gid://sap/StockRecount/2026-09-23",
    "ignoreCompareQuantity": false,
    "quantities": [
      {
        "inventoryItemId": "gid://shopify/InventoryItem/48123456789",
        "locationId": "gid://shopify/Location/67123456",
        "quantity": 25,
        "compareQuantity": 42
      }
    ]
  }
}
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{
    "query": "mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) @idempotent(key: \"set-1699999999-xyz789\") { userErrors { field message } } }",
    "variables": { "input": { "name": "available", "reason": "correction", "referenceDocumentUri": "gid://sap/StockRecount/2026-09-23", "quantities": [ { "inventoryItemId": "gid://shopify/InventoryItem/48123456789", "locationId": "gid://shopify/Location/67123456", "quantity": 25, "compareQuantity": 42 } ] } }
  }'
```

**Success Response:**

```json
{
  "data": {
    "inventorySetQuantities": {
      "inventoryAdjustmentGroup": { "changes": [{ "name": "available", "quantityAfterChange": 25 }] },
      "userErrors": []
    }
  }
}
```

**Error Response:**

```json
{
  "data": {
    "inventorySetQuantities": {
      "userErrors": [{ "field": ["input", "quantities", "0", "compareQuantity"], "message": "does not match the current on-hand quantity" }]
    }
  }
}
```

**Adjust vs. Set — the difference:**

`inventoryAdjustQuantities` applies a relative **delta** and is safe when multiple independent events (an order, a restock, a return) each need to nudge stock without knowing the others' state — this is why this repo uses it exclusively. `inventorySetQuantities` overwrites the **absolute** value and is meant for a single authoritative recount (e.g. a nightly SAP stock sync), with `compareQuantity` as an optional guard against clobbering a change that happened after the recount was taken.

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | String | Yes | Quantity bucket, e.g. `"available"` |
| `reason` | String | Yes | e.g. `correction` |
| `referenceDocumentUri` | String | Yes | Audit trail — the source system/document this recount came from |
| `quantities[].quantity` | Int | Yes | Absolute value to set |
| `quantities[].compareQuantity` | Int | No | Compare-and-set guard |
| `ignoreCompareQuantity` | Boolean | No | Skip the compare-and-set check when `true` |

---

# 5. ORDER APIs

## 5.1 Create Shopify Order

✅ **Implemented, via Draft Orders (REST)** — `src/services/shopify.js#createDraftOrder` + `#completeDraftOrder`, orchestrated in `src/controllers/map.controller.js#createOrder` (Section 8.2). This two-step draft-order flow is what actually creates and pays/decrements orders in this repo today.

📘 **Reference, via direct `orderCreate` (GraphQL)** — an alternative, not used here, for creating an order without a draft step.

### 5.1a Implemented: Draft Order create + complete

**Method:** `POST` then `PUT`

**Endpoints:**

```text
POST https://YOUR_STORE.myshopify.com/admin/api/2026-10/draft_orders.json
PUT  https://YOUR_STORE.myshopify.com/admin/api/2026-10/draft_orders/{draft_order_id}/complete.json
```

**Headers:**

```http
Content-Type: application/json
X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN
```

**Required Scope:**

```text
write_draft_orders
write_orders
```

**Request Body (create draft):**

```json
{
  "draft_order": {
    "line_items": [
      { "variant_id": 44123456789, "quantity": 2 }
    ],
    "shipping_address": {
      "address1": "123 MG Road",
      "city": "Bangalore",
      "province": "Karnataka",
      "country": "India",
      "zip": "560001"
    },
    "email": "employee@irisidea.com",
    "note": "Employee: John Doe <employee@irisidea.com>",
    "note_attributes": [
      { "name": "employeeName", "value": "John Doe" },
      { "name": "employeeEmail", "value": "employee@irisidea.com" },
      { "name": "employeePhone", "value": "+91 9000000000" }
    ],
    "inventory_behaviour": "decrement_obeying_policy"
  }
}
```

**cURL — create + complete:**

```bash
# 1. Create the draft order
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/draft_orders.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"draft_order":{"line_items":[{"variant_id":44123456789,"quantity":2}],"email":"employee@irisidea.com","inventory_behaviour":"decrement_obeying_policy"}}'

# 2. Complete it (paid order) - omit ?payment_pending=true for a paid order
curl -X PUT "https://YOUR_STORE.myshopify.com/admin/api/2026-10/draft_orders/1123456789/complete.json"
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN"
```

**Success Response (complete):**

```json
{
  "draft_order": {
    "id": 1123456789,
    "order_id": 5123456789,
    "status": "completed",
    "name": "#D12"
  }
}
```

**Error Response:**

```json
{ "errors": { "line_items": ["Variant is out of stock"] } }
```

MAP wraps a failed completion as: `{ "success": false, "message": "Could not complete the order - it may be out of stock. Please try again." }` (HTTP `409`), and deletes the dangling draft order.

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `line_items[].variant_id` | Integer | Yes | Numeric Shopify variant ID — required for inventory to actually link/decrement; a bare SKU/title line item does **not** touch inventory |
| `line_items[].quantity` | Integer | Yes | Positive integer |
| `inventory_behaviour` | String | Yes | `bypass` \| `decrement_ignoring_policy` \| `decrement_obeying_policy` — this repo always sends `decrement_obeying_policy` |
| `email` | String | No | Customer/employee email on the order |
| `note_attributes` | Array | No | Free-form key/value metadata (used here to carry employee identity) |

### 5.1b Reference: `orderCreate` (GraphQL, direct — no draft step)

**Method:** `POST`

**Endpoint:** `https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json`

**Required Scope:** `write_orders`

**GraphQL Mutation:**

```graphql
mutation CreateOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name financialStatus }
    userErrors { field message }
  }
}
```

**Request / Variables:**

```json
{
  "order": {
    "email": "employee@irisidea.com",
    "phone": "+919000000000",
    "lineItems": [{ "variantId": "gid://shopify/ProductVariant/44123456789", "quantity": 2 }],
    "financialStatus": "PAID",
    "shippingAddress": { "address1": "123 MG Road", "city": "Bangalore", "province": "Karnataka", "country": "India", "zip": "560001" },
    "note": "Created via MAP Portal",
    "tags": ["MAP", "Employee-Order"]
  },
  "options": {
    "inventoryBehaviour": "DECREMENT_OBEYING_POLICY",
    "sendReceipt": true,
    "sendFulfillmentReceipt": false
  }
}
```

> Verify `OrderCreateInventoryBehavior`'s exact enum members against your store's schema via GraphiQL introspection before relying on this in production — Shopify has renamed enum members across API versions. `BYPASS` / `DECREMENT_IGNORING_POLICY` / `DECREMENT_OBEYING_POLICY` (mirroring the REST values already used in this repo, 5.1a) are current as of `2026-10`.

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"query":"mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) { orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } } }","variables":{"order":{"email":"employee@irisidea.com","lineItems":[{"variantId":"gid://shopify/ProductVariant/44123456789","quantity":2}],"financialStatus":"PAID"},"options":{"inventoryBehaviour":"DECREMENT_OBEYING_POLICY","sendReceipt":true}}}'
```

**Success Response:**

```json
{ "data": { "orderCreate": { "order": { "id": "gid://shopify/Order/5123456789", "name": "#1012", "financialStatus": "PAID" }, "userErrors": [] } } }
```

**Error Response:**

```json
{ "data": { "orderCreate": { "order": null, "userErrors": [{ "field": ["order", "lineItems", "0", "variantId"], "message": "Variant not found" }] } } }
```

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `order.lineItems` | Array | Yes | `{ variantId, quantity }` per line |
| `order.email` | String | No | Buyer email |
| `order.financialStatus` | OrderCreateFinancialStatus | No | `PENDING` \| `AUTHORIZED` \| `PAID` \| `REFUNDED` \| `VOIDED` |
| `options.inventoryBehaviour` | Enum | No | Same three values as REST, upper-cased |
| `options.sendReceipt` | Boolean | No | Email the customer an order confirmation |
| `options.sendFulfillmentReceipt` | Boolean | No | Email the customer a shipping confirmation |

---

## 5.2 COD Order

**Payment Method:** COD · **Payment Status:** Pending

**REST (this repo's flow, 5.1a) — complete the draft as pending:**

```bash
curl -X PUT "https://YOUR_STORE.myshopify.com/admin/api/2026-10/draft_orders/1123456789/complete.json?payment_pending=true" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN"
```

**GraphQL equivalent:**

```json
{ "financialStatus": "PENDING" }
```

(passed as `order.financialStatus` in 5.1b, or via `draftOrderComplete(id: ID!, paymentPending: true)`).

**Inventory handling:** identical either way — `inventory_behaviour: "decrement_obeying_policy"` still decrements stock at order completion, regardless of payment status. COD does **not** defer the inventory deduction; only the financial status stays `PENDING` until the courier collects payment and it's manually marked paid.

---

## 5.3 Paid Order

**Payload (REST, default — no `payment_pending` param):**

```bash
curl -X PUT "https://YOUR_STORE.myshopify.com/admin/api/2026-10/draft_orders/1123456789/complete.json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN"
```

**GraphQL equivalent:**

```json
{ "financialStatus": "PAID" }
```

**PENDING vs PAID:** `PENDING` means Shopify has recorded the order but has **not** captured/recognized payment (typical for COD, awaiting bank transfer, etc.) — the order still shows as needing payment in Shopify Admin. `PAID` means the full order amount has been captured/reconciled; this is what this repo's employee-purchase flow uses for card/prepaid checkouts.

---

## 5.4 Multiple Product Order

```text
Product A (THCM-A01) → Qty 2
Product B (THCM-B02) → Qty 1
Product C (THCM-C03) → Qty 3
```

**Request Body (draft order create):**

```json
{
  "draft_order": {
    "line_items": [
      { "variant_id": 44100000001, "quantity": 2 },
      { "variant_id": 44100000002, "quantity": 1 },
      { "variant_id": 44100000003, "quantity": 3 }
    ],
    "email": "employee@irisidea.com",
    "inventory_behaviour": "decrement_obeying_policy"
  }
}
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/draft_orders.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"draft_order":{"line_items":[{"variant_id":44100000001,"quantity":2},{"variant_id":44100000002,"quantity":1},{"variant_id":44100000003,"quantity":3}],"email":"employee@irisidea.com","inventory_behaviour":"decrement_obeying_policy"}}'
```

Matches this repo's `POST /api/map/create-order` payload, which accepts an `items[]` array and resolves each SKU to a `variant_id` before building this same request (Section 8.2).

---

## 5.5 Get Order

✅ **Implemented** — `src/services/shopify.js#getOrder`, used after draft-order completion and by the cancel flow to re-check live status.

**Method:** `GET`

**Endpoint:**

```text
https://YOUR_STORE.myshopify.com/admin/api/2026-10/orders/{order_id}.json
```

**Headers:**

```http
X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN
```

**Required Scope:** `read_orders`

**cURL:**

```bash
curl -X GET "https://YOUR_STORE.myshopify.com/admin/api/2026-10/orders/5123456789.json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN"
```

**Success Response:**

```json
{
  "order": {
    "id": 5123456789,
    "name": "#1012",
    "financial_status": "paid",
    "fulfillment_status": null,
    "line_items": [{ "sku": "THCM-001", "quantity": 2, "price": "499.00" }],
    "total_price": "998.00",
    "created_at": "2026-09-23T10:15:00-00:00",
    "updated_at": "2026-09-23T10:15:00-00:00"
  }
}
```

**Error Response:**

```json
{ "errors": "Not Found" }
```

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | Integer | Yes | Numeric Shopify order ID |
| `name` | String | No | Human order number, e.g. `#1012` |
| `financial_status` | String | No | `pending` \| `paid` \| `refunded` \| `voided` \| … |
| `fulfillment_status` | String \| null | No | `null` \| `partial` \| `fulfilled` |

---

## 5.6 Cancel Order

✅ **Implemented, via REST** — `src/services/shopify.js#cancelOrder`, called from both the create-order concurrency rollback and `POST /api/map/orders/:id/cancel` (Section 8.2).

**Method:** `POST`

**Endpoint:**

```text
https://YOUR_STORE.myshopify.com/admin/api/2026-10/orders/{order_id}/cancel.json
```

**Headers:**

```http
Content-Type: application/json
X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN
```

**Required Scope:** `write_orders`

**Request Body:**

```json
{ "restock": false, "reason": "customer" }
```

> This repo always sends `restock: false` and performs the inventory hand-back itself via `inventoryAdjustQuantities` (Section 4.3) — see the "single restock path" rule in Section 11.

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/orders/5123456789/cancel.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"restock": false, "reason": "customer"}'
```

**Success Response:**

```json
{ "order": { "id": 5123456789, "cancelled_at": "2026-09-23T10:20:00-00:00", "cancel_reason": "customer" } }
```

**Error Response:**

```json
{ "errors": "Order already cancelled" }
```

**GraphQL equivalent (`orderCancel`, reference — not used here):**

```graphql
mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $notifyCustomer: Boolean) {
  orderCancel(orderId: $orderId, reason: $reason, restock: $restock, notifyCustomer: $notifyCustomer) {
    job { id done }
    userErrors { field message }
  }
}
```

**Important Fields:**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `order_id` / `orderId` | Integer / GID | Yes | Order to cancel |
| `reason` | String / OrderCancelReason | Yes (GraphQL) | REST: `customer`\|`fraud`\|`inventory`\|`declined`\|`other`. GraphQL: `CUSTOMER`\|`PAYMENT_DECLINED`\|`FRAUD`\|`INVENTORY`\|`STAFF_ERROR`\|`OTHER` |
| `restock` | Boolean | Yes | Whether Shopify should also restock — this repo keeps this `false` and restocks explicitly itself |
| `notifyCustomer` | Boolean | No (GraphQL only) | Send the customer a cancellation email |

---

# 6. FULFILLMENT APIs

📘 **Reference** — this repo is **read-only** on fulfillment: tracking numbers/URLs/carrier arrive via the `fulfillments/create` and `fulfillments/update` webhooks (Section 7) and are mirrored onto the local `orders` row. MAP does not currently create or update fulfillments itself.

## 6.1 Get Fulfillment Status

Part of the `orders/{id}.json` response (5.5): `fulfillment_status` (`null` \| `partial` \| `fulfilled`), or per-fulfillment via:

```text
GET https://YOUR_STORE.myshopify.com/admin/api/2026-10/orders/{order_id}/fulfillments.json
```

**Required Scope:** `read_fulfillments`

## 6.2 Create Fulfillment

`fulfillmentCreateV2` is **deprecated** — current mutation is `fulfillmentCreate`.

**Method:** `POST` · **Endpoint:** `.../graphql.json` · **Required Scope:** one of `write_merchant_managed_fulfillment_orders`, `write_assigned_fulfillment_orders`, `write_third_party_fulfillment_orders`.

```graphql
mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status trackingInfo { number url company } }
    userErrors { field message }
  }
}
```

```json
{
  "fulfillment": {
    "lineItemsByFulfillmentOrder": [
      { "fulfillmentOrderId": "gid://shopify/FulfillmentOrder/9123456789" }
    ],
    "trackingInfo": { "number": "TRK123456", "url": "https://track.example.com/TRK123456", "company": "Blue Dart" },
    "notifyCustomer": true
  }
}
```

**cURL:**

```bash
curl -X POST "https://YOUR_STORE.myshopify.com/admin/api/2026-10/graphql.json" \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN" \
  -d '{"query":"mutation($fulfillment: FulfillmentInput!) { fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id status } userErrors { field message } } }","variables":{"fulfillment":{"lineItemsByFulfillmentOrder":[{"fulfillmentOrderId":"gid://shopify/FulfillmentOrder/9123456789"}],"trackingInfo":{"number":"TRK123456","company":"Blue Dart"},"notifyCustomer":true}}}'
```

## 6.3 Update Fulfillment (tracking info)

```graphql
mutation UpdateTracking($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
  fulfillmentTrackingInfoUpdateV2(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
    fulfillment { id trackingInfo { number url company } }
    userErrors { field message }
  }
}
```

**Important Fields (both mutations):**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `fulfillmentOrderId` | GID | Yes | From `order.fulfillmentOrders` |
| `trackingInfo.number` | String | No | Carrier tracking number |
| `trackingInfo.company` | String | No | Carrier name |
| `notifyCustomer` | Boolean | No | Email the customer the tracking info |

---

# 7. WEBHOOK APIs

✅ **Implemented** — all topics below are registered, verified via HMAC, and handled in `src/controllers/webhook.controller.js`, mounted in `src/routes/webhook.routes.js` at the **root** path (`app.use('/', webhookRoutes)` in `app.js`), not under `/api`.

**HMAC Verification:** `src/middleware/verifyShopifyWebhook.js` — reads the raw request body (`express.raw`), computes `HMAC-SHA256(rawBody, SHOPIFY_WEBHOOK_SECRET)`, base64-encodes it, and compares it to the `X-Shopify-Hmac-SHA256` header with `crypto.timingSafeEqual`. A mismatch logs the attempt (`verified: false`) and returns `401`.

| Topic | HTTP Method | MAP Endpoint (actual) |
| --- | --- | --- |
| `inventory_levels/update` | POST | `POST /inventory-update` |
| `products/create` | POST | `POST /products/create` |
| `products/update` | POST | `POST /products/update` |
| `orders/create` | POST | `POST /orders/create` |
| `orders/updated` | POST | `POST /orders/updated` |
| `orders/cancelled` | POST | `POST /orders/cancelled` |
| `orders/paid` | POST | `POST /orders/paid` |
| `orders/fulfilled` | POST | `POST /orders/fulfilled` |
| `fulfillments/create` | POST | `POST /fulfillments/create` |
| `fulfillments/update` | POST | `POST /fulfillments/update` |
| `refunds/create` | POST | `POST /refunds/create` |
| `app/uninstalled` | POST | 📘 not registered in this repo |

**Headers (every webhook, sent by Shopify):**

```http
Content-Type: application/json
X-Shopify-Topic: orders/create
X-Shopify-Hmac-SHA256: base64-hmac-signature
X-Shopify-Shop-Domain: your-store.myshopify.com
X-Shopify-API-Version: 2026-10
X-Shopify-Webhook-Id: 3d1e...
```

### Example: `orders/create`

**Full endpoint:**

```http
POST https://YOUR_MAP_API.com/orders/create
```

**Sample Payload (trimmed):**

```json
{
  "id": 5123456789,
  "financial_status": "paid",
  "fulfillment_status": null,
  "total_price": "998.00",
  "line_items": [{ "sku": "THCM-001", "title": "THCM Safety Helmet", "quantity": 2, "price": "499.00" }],
  "closed_at": null
}
```

**Purpose:** Mirror a new Shopify order into MAP's local `orders`/`order_line_items` tables (idempotent — skipped if `shopify_order_id` already exists, e.g. an order MAP itself just created via 5.1a).

**MAP Action:** `logWebhook('orders/create', payload)` → `Order.create(...)` + `OrderLineItem.bulkCreate(...)` (skipped if the order already exists locally).

**HMAC Verification:** required — unverified requests get `401` before any DB write.

### Example: `inventory_levels/update`

**Endpoint:** `POST https://YOUR_MAP_API.com/inventory-update`

**Sample Payload:**

```json
{ "inventory_item_id": 48123456789, "location_id": 67123456, "available": 40 }
```

**Purpose:** Keep the local `inventory_snapshots` table in sync with live Shopify stock for reporting.

**MAP Action:** `InventorySnapshot.upsert({ inventoryItemId, locationId, available })`.

The remaining topics follow the same shape — see the table above for endpoint and `src/controllers/webhook.controller.js` for each handler's exact DB write. All order-status webhooks (`orders/updated`, `orders/cancelled`, `orders/paid`, `orders/fulfilled`) only **mirror** status; none of them re-adjust Shopify inventory (see Section 11).

**Required Scopes (webhook subscription, per topic):**

```text
orders/*         → read_orders
inventory_levels/* → read_inventory
products/*        → read_products
fulfillments/*     → read_fulfillments
refunds/*          → read_orders
```

---

# 8. MAP INTERNAL APIs

These are this backend's **actual** routes (`src/app.js` + `src/routes/*.js`) — not a generic template. All `/api/*` routes except `/api/auth/login`, `/api/auth/reset-password` and `/api/health` require `Authorization: Bearer <token>` (Section 9).

## 8.1 Authenticate

```http
POST /api/auth/login
```

```json
{ "email": "employee@irisidea.com", "password": "Welcome@1234" }
```

**Success (200):**

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOi...",
    "user": { "email": "employee@irisidea.com", "name": "John Doe", "phone": null, "mustResetPassword": true, "isAdmin": false }
  }
}
```

**Error (401):** `{ "success": false, "message": "Invalid email or password" }`

## 8.2 Check Stock + Create Order (combined)

```http
POST /api/map/create-order
Authorization: Bearer <token>
```

```json
{
  "items": [{ "sku": "THCM-001", "quantity": 2 }],
  "shippingAddress": { "address1": "123 MG Road", "city": "Bangalore", "province": "Karnataka", "country": "India", "zip": "560001" },
  "phone": "+919000000000"
}
```

Internally: resolves SKUs → 4.2 stock check → 5.1a draft order create + complete → 5.5 get order → persists locally. See Section 11 for the full flow diagram.

**Success (201):**

```json
{
  "success": true,
  "data": {
    "id": 42,
    "shopifyOrderId": "5123456789",
    "status": "open",
    "financialStatus": "paid",
    "fulfillmentStatus": null,
    "totalPrice": "998.00",
    "lineItems": [{ "sku": "THCM-001", "title": "THCM Safety Helmet", "quantity": 2, "price": "499.00" }]
  }
}
```

**Error (409 — stock conflict):** `{ "success": false, "message": "Insufficient stock - THCM-001: requested 5, only 2 available" }`

## 8.3 Get Order Status

```http
GET /api/map/order-status/:id
Authorization: Bearer <token>
```

**Success (200):**

```json
{
  "success": true,
  "data": { "id": 42, "shopifyOrderId": "5123456789", "status": "open", "financialStatus": "paid", "fulfillmentStatus": null, "trackingNumber": null, "trackingUrl": null, "carrier": null }
}
```

Ownership-checked: `403` if `order.employeeEmail !== req.user.email`.

## 8.4 Cancel Order

```http
POST /api/map/orders/:id/cancel
Authorization: Bearer <token>
```

**Success (200):** returns the updated order (same shape as 8.2), `status: "cancelled"`.

**Error (409 — not open):** `{ "success": false, "message": "Order cannot be cancelled - current status is FULFILLED" }`

## 8.5 List My Orders

```http
GET /api/dashboard/orders
Authorization: Bearer <token>
```

Scoped to `req.user.email` — never returns another employee's orders.

## 8.6 Inventory / Product Sync

```text
GET  /api/map/stock          → live Shopify catalog (Section 2.3-shaped)
GET  /api/dashboard/products  → same, dashboard-facing alias
GET  /api/map/product/:id     → single product detail (Section 2.1)
GET  /api/dashboard/events    → recent webhook log entries (Section 7 mirror)
```

There is no local product cache and no `/api/inventory/sync` route — the catalog is always read live from Shopify (Section 2.3 / `shopify.listProductsCatalog`).

## 8.7 SAP Export

```http
POST /api/sap/export-daily
Authorization: Bearer <token>
```

Generates a CSV of the caller's own orders under `SAP_EXPORT_LOCAL_DIR`, returned as a download URL.

```json
{ "success": true, "message": "Exported 3 order(s) for your account", "file": "sap-orders-employee-irisidea-com-2026-09-23.csv", "downloadUrl": "/exports/sap-orders-employee-irisidea-com-2026-09-23.csv" }
```

## 8.8 Admin — Manage Employees

```http
GET    /api/admin/employees
POST   /api/admin/employees
DELETE /api/admin/employees/:id
```

Restricted to the account matching `ADMIN_EMAIL`; all others get `403 { "success": false, "message": "Admin access required" }`.

---

# 9. Authentication

### Shopify

```http
X-Shopify-Access-Token: YOUR_ADMIN_ACCESS_TOKEN
```

Offline token, server-side only (`src/services/shopify.js` reads it from `SHOPIFY_ACCESS_TOKEN`).

### MAP API

```http
Authorization: Bearer YOUR_MAP_JWT
```

Issued by `POST /api/auth/login` (Section 8.1), an 8-hour HS256 JWT signed with `JWT_SECRET`, verified by `src/middleware/authenticate.js` on every protected route.

**Never expose `SHOPIFY_ACCESS_TOKEN` (or `JWT_SECRET`) in frontend/browser code.** The frontend only ever holds the short-lived MAP JWT; all Shopify calls happen server-side in this backend.

---

# 10. Error Format

**This repo's actual error shape** (all controllers, via `next(err)` → `src/middleware/errorHandler.js`):

```json
{ "success": false, "message": "human-readable reason" }
```

**Recommended structured format for new/external consumers** (per this spec — not the current implementation, migrate incrementally):

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Insufficient inventory"
  }
}
```

| Code | Used for |
| --- | --- |
| 400 | Missing/invalid request fields |
| 401 | Missing/invalid/expired JWT, bad login, invalid webhook HMAC |
| 403 | Authenticated but not authorized (wrong owner, non-admin) |
| 404 | Resource not found |
| 409 | Stock conflict, duplicate resource, invalid state transition |
| 422 | 📘 not currently emitted — reserved for semantically invalid payloads |
| 429 | 📘 not currently handled — Shopify may rate-limit; add retry/backoff before relying on high-volume calls |
| 500 | Unhandled server error |
| 502 | Upstream Shopify call failed |
| 503 | 📘 not currently emitted |

---

# 11. Order + Inventory Flow

```text
MAP Order Request (POST /api/map/create-order)
   ↓
Find Shopify Variant(s) by SKU   (2.3 findVariantsBySku)
   ↓
Check Inventory                  (4.2, using live inventoryQuantity)
   ↓
Stock Available?
   ↓ YES
Create Draft Order               (5.1a POST /draft_orders.json)
   ↓
Complete Draft Order             (5.1a PUT /draft_orders/{id}/complete.json)
   → Shopify performs the inventory decrement here (inventory_behaviour: decrement_obeying_policy)
   ↓
Get Order                        (5.5 GET /orders/{id}.json)
   ↓
Re-verify no SKU went negative   (concurrency safety net)
   ↓ OK                              ↓ CONFLICT
Save Order + Line Items locally   Cancel Order (5.6) + Adjust Inventory +delta (4.3) + return 409
   ↓
Return Success (8.2 response)
```

**Do not manually decrement inventory a second time if Shopify's order-creation operation has already performed the inventory decrement.** In this repo, `inventoryAdjustQuantities` (4.3) is called **only** to restock (positive delta) — on cancellation (5.6) or on the concurrency-conflict rollback above — never to decrement; the decrement is always Shopify's own side effect of completing the draft order with `inventory_behaviour: decrement_obeying_policy`.

---

# 12. Required Response Fields

For every successful order creation, MAP persists (`orders` + `order_line_items` tables):

| Field | Column |
| --- | --- |
| `mapOrderId` | `orders.id` |
| `shopifyOrderId` | `orders.shopify_order_id` |
| `shopifyOrderName` | 📘 not currently stored — only the numeric ID is persisted; add `orders.shopify_order_name` if the human order number (`#1012`) needs to be queryable without a Shopify call |
| `financialStatus` | `orders.financial_status` |
| `fulfillmentStatus` | `orders.fulfillment_status` |
| `variantId` | 📘 not stored on `orders`/`order_line_items` today — only `sku` is; add a column if variant GIDs need to be re-used without another SKU lookup |
| `inventoryItemId` | 📘 same as above — resolved fresh via 2.3 whenever needed (restock, cancel) rather than cached |
| `quantity` | `order_line_items.quantity` |
| `createdAt` / `updatedAt` | `orders.created_at` / `orders.updated_at` |

---

# 13. API Summary Table

| API | Method | Endpoint | Purpose | Status |
| --- | --- | --- | --- | --- |
| Get Product | POST | Shopify GraphQL | Product data | ✅ |
| Get Variant | POST | Shopify GraphQL | Variant data | 📘 |
| Find Variant by SKU | POST | Shopify GraphQL | SKU → variant → inventory item | ✅ |
| Get Locations | POST | Shopify GraphQL | Warehouse/location | ✅ (minimal) |
| Get Inventory | POST | Shopify GraphQL | Stock levels | ✅ (available only) |
| Check Stock | — | inline (`POST /api/map/create-order`) | Validate stock pre-order | ✅ |
| Create Order (Draft Order) | POST/PUT | Shopify REST | Create + complete order | ✅ |
| Create Order (`orderCreate`) | POST | Shopify GraphQL | Direct order creation | 📘 |
| Adjust Inventory | POST | Shopify GraphQL | Restock (+) after cancel/rollback | ✅ |
| Set Inventory | POST | Shopify GraphQL | Absolute stock recount | 📘 |
| Get Order | GET | Shopify REST | Order details | ✅ |
| Cancel Order | POST | Shopify REST | Cancel order | ✅ |
| Create/Update Fulfillment | POST | Shopify GraphQL | Fulfillment | 📘 (read-only via webhook) |
| Inventory Webhook | POST | `/inventory-update` | Inventory updates | ✅ |
| Order Webhooks | POST | `/orders/*` | Order status mirror | ✅ |
| MAP Login | POST | `/api/auth/login` | Employee/admin auth | ✅ |
| MAP Create Order | POST | `/api/map/create-order` | End-to-end order placement | ✅ |
| MAP Cancel Order | POST | `/api/map/orders/:id/cancel` | Employee-initiated cancel | ✅ |
| MAP SAP Export | POST | `/api/sap/export-daily` | CSV hand-off to SAP | ✅ |
| MAP Admin — Employees | GET/POST/DELETE | `/api/admin/employees` | Add/remove employee accounts | ✅ |
