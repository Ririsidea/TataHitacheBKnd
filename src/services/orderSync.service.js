const { sequelize } = require('../config/db');
const { Order, OrderLineItem } = require('../models');
const { shopifyOrderStatusLabel, shopifyDeliveryStatus, shopifyTracking } = require('../utils/orderStatus');

// The order columns Shopify owns, read from a Shopify order (REST shape - the same field names
// the webhooks use): status, payment, fulfilment, delivery, tracking, total. A field the
// payload does not carry is left out, so a partial payload never blanks what MAP already has.
function orderFieldsFromShopify(shopifyOrder) {
  const total = shopifyOrder.current_total_price ?? shopifyOrder.total_price;
  const fields = {
    status: shopifyOrderStatusLabel(shopifyOrder).toLowerCase(),
    financialStatus: shopifyOrder.financial_status,
    fulfillmentStatus: shopifyOrder.fulfillment_status,
    closedAt: shopifyOrder.closed_at || null,
    totalPrice: total !== undefined && total !== null ? Number(total) : undefined,
    ...(Array.isArray(shopifyOrder.fulfillments)
      ? { deliveryStatus: shopifyDeliveryStatus(shopifyOrder), ...shopifyTracking(shopifyOrder) }
      : {}),
  };
  Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
  return fields;
}

// After an order edit, removed/reduced units are excluded: quantity is
// current_quantity when Shopify sends it, and lines that ended at 0 are dropped.
function lineItemsFromShopify(shopifyOrder) {
  return (shopifyOrder.line_items || [])
    .map((li) => ({
      sku: li.sku,
      title: li.title,
      quantity: Number.isInteger(li.current_quantity) ? li.current_quantity : li.quantity,
      price: li.price ? Number(li.price) : undefined,
    }))
    .filter((li) => li.quantity > 0);
}

// Mirrors a full Shopify order into MySQL: orders + order_line_items, inside one transaction
// with a row lock. Idempotent: syncing the same order twice (update endpoint + orders/edited
// webhook + the background reconciler) ends in the same state and can never duplicate line items.
async function syncLocalOrderFromShopify(shopifyOrder) {
  const shopifyOrderId = String(shopifyOrder.id);

  return sequelize.transaction(async (transaction) => {
    const order = await Order.findOne({ where: { shopifyOrderId }, transaction, lock: transaction.LOCK.UPDATE });
    // Not an order MAP knows about - nothing to mirror.
    if (!order) return null;

    await order.update(orderFieldsFromShopify(shopifyOrder), { transaction });

    const lineItems = lineItemsFromShopify(shopifyOrder).map((li) => ({ ...li, orderId: order.id }));
    await OrderLineItem.destroy({ where: { orderId: order.id }, transaction });
    if (lineItems.length) {
      await OrderLineItem.bulkCreate(lineItems, { transaction });
    }
    return order.id;
  });
}

const sameValue = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  return String(a) === String(b);
};

const lineSignature = (lines) =>
  lines
    .map((li) => `${li.sku || ''}|${li.quantity}`)
    .sort()
    .join(',');

// True when MAP's copy of the order (a row loaded with its lineItems) already matches Shopify.
// The background reconciler uses it so an unchanged order costs no write.
function orderMatchesShopify(localOrder, shopifyOrder) {
  const fields = orderFieldsFromShopify(shopifyOrder);
  const fieldsMatch = Object.keys(fields).every((key) => {
    if (key === 'totalPrice') return Number(localOrder[key]) === Number(fields[key]);
    return sameValue(localOrder[key], fields[key]);
  });
  if (!fieldsMatch) return false;
  return lineSignature(localOrder.lineItems || []) === lineSignature(lineItemsFromShopify(shopifyOrder));
}

module.exports = { syncLocalOrderFromShopify, orderFieldsFromShopify, orderMatchesShopify };
