export const MAP_PRODUCTS_TAG = 'Map_products';

/** Only the exact Shopify tag grants MAP eligibility; surrounding whitespace is ignored. */
export function isMapProduct(tags: readonly string[] | null | undefined): boolean {
  return (tags || []).some((tag) => String(tag).trim() === MAP_PRODUCTS_TAG);
}
