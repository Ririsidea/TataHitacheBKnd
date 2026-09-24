const { sequelize } = require('../config/db');
const { Order, OrderLineItem } = require('../models');
const { shopifyOrderStatusLabel } = require('../utils/orderStatus');

// Mirrors a full Shopify order (REST shape - the same field names the webhooks use)
// into MySQL: orders + order_line_items, inside one transaction with a row lock.
// Idempotent: syncing the same order twice (update endpoint + orders/edited webhook)
// ends in the same state and can never duplicate line items.
//
// After an order edit, removed/reduced units are excluded: quantity is
// current_quantity when Shopify sends it, and lines that ended at 0 are dropped.
async function syncLocalOrderFromShopify(shopifyOrder) {
  const shopifyOrderId = String(shopifyOrder.id);

  return sequelize.transaction(async (transaction) => {
    const order = await Order.findOne({ where: { shopifyOrderId }, transaction, lock: transaction.LOCK.UPDATE });
    // Not an order MAP knows about - nothing to mirror.
    if (!order) return null;

    const total = shopifyOrder.current_total_price ?? shopifyOrder.total_price;
    const fields = {
      status: shopifyOrderStatusLabel(shopifyOrder).toLowerCase(),
      financialStatus: shopifyOrder.financial_status,
      fulfillmentStatus: shopifyOrder.fulfillment_status,
      closedAt: shopifyOrder.closed_at || null,
      totalPrice: total !== undefined && total !== null ? Number(total) : undefined,
    };
    Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
    await order.update(fields, { transaction });

    const lineItems = (shopifyOrder.line_items || [])
      .map((li) => ({
        orderId: order.id,
        sku: li.sku,
        title: li.title,
        quantity: Number.isInteger(li.current_quantity) ? li.current_quantity : li.quantity,
        price: li.price ? Number(li.price) : undefined,
      }))
      .filter((li) => li.quantity > 0);

    await OrderLineItem.destroy({ where: { orderId: order.id }, transaction });
    if (lineItems.length) {
      await OrderLineItem.bulkCreate(lineItems, { transaction });
    }
    return order.id;
  });
}

module.exports = { syncLocalOrderFromShopify };
