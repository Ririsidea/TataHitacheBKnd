import * as shopify from './shopify/client';
import { mapCatalogVariant, mapProductDetail, type ProductDetail, type ProductMatch } from './shopify/productMapper';
import { buildIndex, type CatalogIndex } from './catalogSearch';
import type { CatalogVariantNode } from '../types/shopify';

// The searchable catalog. Mapping ~thousands of variants and building the search text is done
// once per copy of the Shopify catalog (the cache hands back the same array until it refreshes),
// not once per request.
const indexes = new WeakMap<CatalogVariantNode[], CatalogIndex>();

export async function getCatalogIndex({ fresh = false }: { fresh?: boolean } = {}): Promise<CatalogIndex> {
  const raw = await shopify.listProductsCatalog({ fresh });
  let index = indexes.get(raw);
  if (!index) {
    index = buildIndex(raw.map(mapCatalogVariant));
    indexes.set(raw, index);
  }
  return index;
}

// Shopify ids are up to 19 digits; anything longer cannot be an id, so it is not sent as one.
const ID_PATTERN = /^\d{1,19}$/;

// Single-product lookup by ANY key, always read live from Shopify. Numeric keys are tried as a
// product id, then a variant id; every key then falls back to SKU, then handle (so a numeric SKU
// or handle still resolves). Returns the mapped product, or null when nothing matches.
export async function lookupProduct(key: string): Promise<ProductDetail | null> {
  const load = async (productId: string | null, match: ProductMatch): Promise<ProductDetail | null> => {
    const product = productId ? await shopify.getProductDetail(productId) : null;
    return product ? mapProductDetail(product, match) : null;
  };

  if (ID_PATTERN.test(key)) {
    const byProduct = await load(key, { matchedBy: 'productId' });
    if (byProduct) return byProduct;

    const byVariant = await load(await shopify.findProductIdByVariantId(key), { matchedBy: 'variantId', matchedVariantId: key });
    if (byVariant) return byVariant;
  }

  const ref = await shopify.findVariantRefBySku(key);
  const bySku = ref && (await load(ref.productId, { matchedBy: 'sku', matchedVariantId: ref.variantId }));
  if (bySku) return bySku;

  return load(await shopify.findProductIdByHandle(key), { matchedBy: 'handle' });
}
