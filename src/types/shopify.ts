// The parts of Shopify's REST order (and the equivalent webhook payload) and of the GraphQL nodes
// this backend reads. Every REST field is optional: webhook payloads and REST reads differ, and an
// old order may lack any of them.

export interface ShopifyFulfillment {
  status?: string | null;
  shipment_status?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  tracking_company?: string | null;
}

export interface ShopifyLineItem {
  id?: number | string;
  sku?: string | null;
  title?: string | null;
  quantity?: number;
  current_quantity?: number | null;
  price?: string | number | null;
}

export interface ShopifyCustomer {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface ShopifyOrder {
  id: number | string;
  cancelled_at?: string | null;
  closed_at?: string | null;
  fulfillment_status?: string | null;
  financial_status?: string | null;
  total_price?: string | number | null;
  current_total_price?: string | number | null;
  email?: string | null;
  phone?: string | null;
  customer?: ShopifyCustomer | null;
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
