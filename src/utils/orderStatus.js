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

// Orders that are cancelled or refunded no longer accept contact/tracking edits.
// Used by the update endpoint (authoritative) and the dashboard list (UI hint).
function isOrderUpdatable(order) {
  return !['cancelled', 'refunded'].includes(order.status);
}

module.exports = { shopifyOrderStatusLabel, isOrderUpdatable };
