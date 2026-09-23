// Single source of truth for turning a raw Shopify order object (REST order, or an
// equivalent webhook payload - both use the same field names) into the simplified
// status this app displays and gates cancellation on. Used by both the webhook
// handlers (to mirror status locally) and the cancel endpoint (to authoritatively
// re-check live status before allowing a cancellation).
function shopifyOrderStatusLabel(shopifyOrder) {
  if (shopifyOrder.cancelled_at) return 'CANCELLED';
  if (shopifyOrder.closed_at) return 'CLOSED';
  if (shopifyOrder.fulfillment_status) return 'FULFILLED';
  return 'OPEN';
}

module.exports = { shopifyOrderStatusLabel };
