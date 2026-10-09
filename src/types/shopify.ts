// The parts of Shopify's REST order (and the equivalent webhook payload) and of the GraphQL nodes
// this backend reads. Every REST field is optional: webhook payloads and REST reads differ, and an
// old order may lack any of them.
//
// IMPORTANT (see services/orderDetails.ts): the fields below marked "webhook payload only" come
// back redacted (absent or null) from a live REST/GraphQL read unless the app has Protected
// Customer Data access approved in the Shopify admin - verified empirically against this store's
// own orders. The raw webhook body (req.shopifyPayload) does NOT have this restriction. Address
// and customer PII must therefore only ever be read from the webhook payload, never from
// shopify.getOrder() - orderDetails.ts enforces this split.

export interface ShopifyAddress {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  zip?: string | null;
  phone?: string | null;
}

export interface ShopifyFulfillment {
  status?: string | null;
  shipment_status?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  tracking_company?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ShopifyMoneySet {
  shop_money?: { amount?: string | number | null } | null;
}

export interface ShopifyDiscountAllocation {
  amount?: string | number | null;
}

export interface ShopifyTaxLine {
  price?: string | number | null;
  rate?: number | null;
  title?: string | null;
}

export interface ShopifyLineItem {
  id?: number | string;
  sku?: string | null;
  title?: string | null;
  variant_title?: string | null;
  quantity?: number;
  current_quantity?: number | null;
  price?: string | number | null;
  // webhook payload only (not PII-gated, but only read from the webhook body for consistency).
  discount_allocations?: ShopifyDiscountAllocation[];
  tax_lines?: ShopifyTaxLine[];
}

export interface ShopifyCustomer {
  first_name?: string | null;
  last_name?: string | null;
  // webhook payload only - see the file-level note above.
  email?: string | null;
  phone?: string | null;
}

export interface ShopifyShippingLine {
  price?: string | number | null;
}

export interface ShopifyOrder {
  id: number | string;
  // "#1023" - the display order number (REST field `name`).
  name?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  closed_at?: string | null;
  created_at?: string | null;
  fulfillment_status?: string | null;
  financial_status?: string | null;
  total_price?: string | number | null;
  current_total_price?: string | number | null;
  subtotal_price?: string | number | null;
  total_discounts?: string | number | null;
  total_tax?: string | number | null;
  // webhook payload only - see the file-level note above.
  email?: string | null;
  phone?: string | null;
  customer?: ShopifyCustomer | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  shipping_lines?: ShopifyShippingLine[];
  payment_gateway_names?: string[];
  note?: string | null;
  tags?: string | null;
  note_attributes?: { name: string; value: string }[];
  line_items?: ShopifyLineItem[];
  fulfillments?: ShopifyFulfillment[];
}

// ---- GraphQL (Admin API) ------------------------------------------------------------------------

export interface SelectedOption {
  name: string;
  value: string;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface Connection<T> {
  edges: { node: T }[];
  pageInfo?: PageInfo;
}

/** The product fields the catalog reads through productVariants -> product. */
export interface CatalogProductNode {
  id: string;
  title: string;
  handle: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[];
  status?: string | null;
  createdAt?: string | null;
  featuredImage?: { url: string } | null;
}

/** One variant of the catalog (see CATALOG_VARIANTS_QUERY in services/shopify/client.ts). */
export interface CatalogVariantNode {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  compareAtPrice?: string | null;
  inventoryQuantity: number | null;
  selectedOptions: SelectedOption[];
  product: CatalogProductNode;
}

/** A variant as the SKU lookup returns it (live stock + the inventory item to adjust). */
export interface SkuVariantNode {
  id: string;
  sku: string | null;
  price?: string;
  inventoryQuantity: number | null;
  inventoryPolicy?: string;
  inventoryItem: { id: string };
  product?: { id: string; title: string };
}

export interface ProductVariantDetailNode {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice?: string | null;
  inventoryQuantity: number | null;
  selectedOptions: SelectedOption[];
}

/** A full product with every variant (see PRODUCT_QUERY in services/shopify/client.ts). */
export interface ProductDetailNode {
  id: string;
  title: string;
  handle: string;
  descriptionHtml?: string | null;
  productType?: string | null;
  vendor?: string | null;
  tags?: string[];
  status?: string | null;
  images?: Connection<{ url: string }>;
  variants: Connection<ProductVariantDetailNode> & { pageInfo: PageInfo };
}

export interface RestockLine {
  inventoryItemId: string;
  quantity: number;
}
