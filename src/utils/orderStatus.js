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

const lower = (value) => String(value || '').toLowerCase();

// Order lifecycle: pending -> paid -> fulfilled. A fulfilled order is FINAL: it is locked
// against cancel, edit and any further status change (enforced by the API, not just hidden
// in the UI). Only a fully fulfilled order is locked - a partially fulfilled one is not.
function isOrderFulfilled(order) {
  return lower(order.fulfillmentStatus) === 'fulfilled';
}

// A cancel button is only worth showing for an order that's still open (not yet
// fulfilled or closed) - the actual cancel request re-validates this live against
// Shopify regardless, this is just a fast, non-authoritative signal for the UI.
function isLocallyCancellable(order) {
  return order.status === 'open' && !order.fulfillmentStatus && !order.closedAt;
}

// The one stage the UI shows for an order. Values are shared with the frontend
// (Tata-hFrontend/src/utils/orderStage.js): pending | paid | partially_fulfilled |
// fulfilled | cancelled | refunded.
function orderStage(order) {
  const status = lower(order.status);
  const financial = lower(order.financialStatus);
  const fulfillment = lower(order.fulfillmentStatus);
  if (status === 'cancelled') return 'cancelled';
  if (status === 'refunded' || financial === 'refunded') return 'refunded';
  if (fulfillment === 'fulfilled') return 'fulfilled';
  if (fulfillment === 'partial') return 'partially_fulfilled';
  if (financial === 'paid') return 'paid';
  return 'pending';
}

// Derived, never stored: what the UI needs to render and gate an order's actions.
function orderFlags(order) {
  return {
    stage: orderStage(order),
    locked: isOrderFulfilled(order),
    canCancel: isLocallyCancellable(order),
    canUpdate: isOrderUpdatable(order),
  };
}

const LOCKED_MESSAGE = 'Order is fulfilled and locked - it can no longer be cancelled, edited or have its status changed';

// Delivery status of a Shopify order, from its fulfillments' shipment_status (in_transit,
// out_for_delivery, delivered, attempted_delivery, failure, ...; the carrier / Shopify Admin
// updates it). null while nothing has shipped. Cancelled fulfillments are ignored; with several
// fulfillments the order counts as "delivered" only when every one of them is.
function shopifyDeliveryStatus(shopifyOrder) {
  const fulfillments = (shopifyOrder.fulfillments || []).filter((f) => lower(f.status) !== 'cancelled');
  if (!fulfillments.length) return null;
  const statuses = fulfillments.map((f) => lower(f.shipment_status) || null);
  if (statuses.every((s) => s === 'delivered')) return 'delivered';
  const pending = statuses.filter((s) => s !== 'delivered');
  return pending[pending.length - 1];
}

// Courier tracking of the most recent live fulfillment that has any. Only the fields Shopify
// actually has are returned, so a sync never blanks tracking that was entered by hand.
function shopifyTracking(shopifyOrder) {
  const fulfillments = (shopifyOrder.fulfillments || []).filter((f) => lower(f.status) !== 'cancelled');
  for (let i = fulfillments.length - 1; i >= 0; i -= 1) {
    const f = fulfillments[i];
    if (f.tracking_number || f.tracking_url) {
      return {
        trackingNumber: f.tracking_number || undefined,
        trackingUrl: f.tracking_url || undefined,
        carrier: f.tracking_company || undefined,
      };
    }
  }
  return {};
}

module.exports = {
  shopifyOrderStatusLabel,
  shopifyDeliveryStatus,
  shopifyTracking,
  isOrderUpdatable,
  isOrderFulfilled,
  isLocallyCancellable,
  orderStage,
  orderFlags,
  LOCKED_MESSAGE,
};
