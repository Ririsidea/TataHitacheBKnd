import { extractNumericId } from './client';
import { deriveCategoryFromTitle } from '../../utils/categorize';
import type { CatalogVariantNode, ProductDetailNode, SelectedOption } from '../../types/shopify';

/** One catalog row: a single variant of a product (GET /api/map/stock). */
export interface CatalogRow {
  id: string;
  variantId: string;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  options: Record<string, string>;
  price: string;
  compareAtPrice: string | null;
  availableQty: number;
  category: string;
  vendor: string | null;
  tags: string[];
  handle: string;
  imageUrl: string | null;
  status: string;
  createdAt: string | null;
}

export interface DetailVariant {
  variantId: string;
  sku: string | null;
  variantTitle: string | null;
  options: Record<string, string>;
  price: string;
  compareAtPrice: string | null;
  availableQty: number;
}

/** GET /api/map/product/:key. */
export interface ProductDetail {
  id: string;
  title: string;
  handle: string;
  description: string;
  category: string;
  vendor: string | null;
  tags: string[];
  status: string;
  images: string[];
  variants: DetailVariant[];
  matchedBy: 'productId' | 'variantId' | 'sku' | 'handle';
  matchedVariantId?: string;
}

export interface ProductMatch {
  matchedBy: ProductDetail['matchedBy'];
  matchedVariantId?: string;
}

// Shopify names a product without real options "Title: Default Title" - that is noise, not a variant.
const isDefaultOption = (name: string, value: string): boolean => name === 'Title' && value === 'Default Title';

// selectedOptions [{ name: 'Size', value: 'M' }] -> { size: 'M' } (keys lower-cased, "colour" -> "color").
function mapOptions(selectedOptions: SelectedOption[] | undefined): Record<string, string> {
  const options: Record<string, string> = {};
  for (const { name, value } of selectedOptions || []) {
    if (isDefaultOption(name, value)) continue;
    const key = String(name).trim().toLowerCase().replace(/^colour$/, 'color');
    options[key] = value;
  }
  return options;
}

// "M / Black" for a real variant, null for a product's single default variant.
const mapVariantTitle = (title: string | null | undefined): string | null =>
  title && title !== 'Default Title' ? title : null;

// One catalog row per variant, from a raw productVariants node (see shopify.listProductsCatalog).
export function mapCatalogVariant(node: CatalogVariantNode): CatalogRow {
  const product = node.product;
  return {
    id: extractNumericId(product.id),
    variantId: extractNumericId(node.id),
    sku: node.sku || null,
    title: product.title,
    variantTitle: mapVariantTitle(node.title),
    options: mapOptions(node.selectedOptions),
    price: node.price,
    compareAtPrice: node.compareAtPrice ?? null,
    availableQty: node.inventoryQuantity ?? 0,
    category: product.productType || deriveCategoryFromTitle(product.title),
    vendor: product.vendor || null,
    tags: product.tags || [],
    handle: product.handle,
    imageUrl: product.featuredImage?.url || null,
    status: String(product.status || '').toLowerCase(),
    createdAt: product.createdAt || null,
  };
}

function stripHtml(html: string | null | undefined): string {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Full product for the single-product lookup: every image, every variant, tags, and a
// plain-text description (Shopify's descriptionHtml is stripped server-side so clients
// never need to render raw HTML). `match` says how the caller's key found it.
export function mapProductDetail(product: ProductDetailNode, match: ProductMatch): ProductDetail {
  const detail: ProductDetail = {
    id: extractNumericId(product.id),
    title: product.title,
    handle: product.handle,
    description: stripHtml(product.descriptionHtml),
    category: product.productType || deriveCategoryFromTitle(product.title),
    vendor: product.vendor || null,
    tags: product.tags || [],
    status: String(product.status || '').toLowerCase(),
    images: (product.images?.edges || []).map((edge) => edge.node.url),
    variants: (product.variants?.edges || []).map(({ node }) => ({
      variantId: extractNumericId(node.id),
      sku: node.sku || null,
      variantTitle: mapVariantTitle(node.title),
      options: mapOptions(node.selectedOptions),
      price: node.price,
      compareAtPrice: node.compareAtPrice ?? null,
      availableQty: node.inventoryQuantity ?? 0,
    })),
    matchedBy: match.matchedBy,
  };
  if (match.matchedVariantId) detail.matchedVariantId = match.matchedVariantId;
  return detail;
}
