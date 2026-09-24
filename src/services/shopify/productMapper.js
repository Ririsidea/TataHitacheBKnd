const shopify = require('./client');
const { deriveCategoryFromTitle } = require('../../utils/categorize');

// Normalizes a live Shopify GraphQL product node (see shopify.listProductsCatalog)
// into the flat shape the frontend expects. Only the first variant is used, matching
// this app's existing "one variant per product" assumption.
function mapShopifyProduct(product) {
  const variant = product.variants?.edges?.[0]?.node;
  if (!variant) return null;

  return {
    id: shopify.extractNumericId(product.id),
    sku: variant.sku || null,
    title: product.title,
    category: product.productType || deriveCategoryFromTitle(product.title),
    price: variant.price,
    imageUrl: product.featuredImage?.url || null,
    availableQty: variant.inventoryQuantity ?? 0,
  };
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Full detail for the quick-view modal: every image, every variant, tags, and a
// plain-text description (Shopify's descriptionHtml is stripped server-side so the
// frontend never needs to render raw HTML).
function mapProductDetail(product) {
  const category = product.productType || deriveCategoryFromTitle(product.title);
  return {
    id: shopify.extractNumericId(product.id),
    title: product.title,
    description: stripHtml(product.descriptionHtml),
    category,
    tags: product.tags || [],
    images: (product.images?.edges || []).map((edge) => edge.node.url),
    variants: (product.variants?.edges || []).map((edge) => ({
      id: shopify.extractNumericId(edge.node.id),
      title: edge.node.title,
      sku: edge.node.sku,
      price: edge.node.price,
      availableQty: edge.node.inventoryQuantity ?? 0,
      options: edge.node.selectedOptions || [],
    })),
  };
}

module.exports = { mapShopifyProduct, mapProductDetail };
