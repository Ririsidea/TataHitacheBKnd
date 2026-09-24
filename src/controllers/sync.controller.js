const { Product } = require('../models');
const shopify = require('../services/shopify/client');
const { deriveCategoryFromTitle } = require('../utils/categorize');

async function syncProducts(req, res, next) {
  try {
    const products = await shopify.listProducts();

    await Promise.all(
      products.map((payload) => {
        const variant = (payload.variants || [])[0] || {};
        return Product.upsert({
          shopifyProductId: String(payload.id),
          title: payload.title,
          sku: variant.sku,
          category: payload.product_type || deriveCategoryFromTitle(payload.title),
          price: variant.price !== undefined ? Number(variant.price) : undefined,
          imageUrl: payload.image?.src,
          inventoryQuantity: variant.inventory_quantity,
          inventoryItemId: variant.inventory_item_id ? String(variant.inventory_item_id) : undefined,
          lastSyncedAt: new Date(),
        });
      })
    );

    res.json({ success: true, message: `Synced ${products.length} product(s) from Shopify` });
  } catch (err) {
    next(err);
  }
}

module.exports = { syncProducts };
