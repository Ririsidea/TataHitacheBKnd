const { Op } = require('sequelize');
const { Order, OrderLineItem } = require('../models');
const shopify = require('./shopify/client');
const { syncLocalOrderFromShopify, orderMatchesShopify } = require('./orderSync.service');

// Safety net for Shopify -> MAP status sync. The webhooks (orders/updated, orders/paid,
// fulfillments/*, fulfillment_events/create, ...) normally deliver a change within a second, but
// they depend on a public callback URL that must stay registered and reachable (a tunnel URL that
// changes silently stops every one of them). This reconciler re-reads the orders that can still
// change straight from Shopify - one batched request per 100 orders - and mirrors any difference
// (payment, fulfilment, delivery, tracking, cancel, refund, edited items) into MySQL. The Order
// model hooks then push the change to every open screen, exactly as they do for a webhook.
//
// An order is "active" until it is cancelled / refunded, or fulfilled AND delivered. Orders older
// than ACTIVE_WINDOW_DAYS are not polled (nothing is expected to change on them).
const ACTIVE_WINDOW_DAYS = 60;
const MAX_ORDERS_PER_RUN = 500;
const IDS_PER_REQUEST = 100;

async function loadActiveOrders() {
  const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return Order.findAll({
    where: {
      shopifyOrderId: { [Op.ne]: null },
      createdAt: { [Op.gte]: since },
      // 'updating' is an order an admin action / edit is working on right now - leave it alone.
      status: { [Op.notIn]: ['cancelled', 'refunded', 'updating'] },
      [Op.or]: [{ deliveryStatus: null }, { deliveryStatus: { [Op.ne]: 'delivered' } }],
    },
    include: [{ model: OrderLineItem, as: 'lineItems' }],
    order: [['createdAt', 'DESC']],
    limit: MAX_ORDERS_PER_RUN,
  });
}

// Returns { checked, updated, failed }.
async function reconcileActiveOrders() {
  const result = { checked: 0, updated: 0, failed: 0 };
  const locals = await loadActiveOrders();

  for (let i = 0; i < locals.length; i += IDS_PER_REQUEST) {
    const chunk = locals.slice(i, i + IDS_PER_REQUEST);
    let remoteOrders;
    try {
      remoteOrders = await shopify.listOrdersByIds(chunk.map((o) => o.shopifyOrderId));
    } catch (err) {
      result.failed += chunk.length;
      console.error('[order-reconcile] could not read orders from Shopify:', err.message);
      continue;
    }
    const remoteById = new Map(remoteOrders.map((o) => [String(o.id), o]));

    for (const local of chunk) {
      const remote = remoteById.get(String(local.shopifyOrderId));
      if (!remote) continue; // not returned (deleted in Shopify): nothing to mirror
      result.checked += 1;
      try {
        if (orderMatchesShopify(local, remote)) continue;
        // Re-check just before writing: an admin action may have claimed the order meanwhile.
        const current = await Order.findByPk(local.id, { attributes: ['status'] });
        if (!current || current.status === 'updating') continue;
        await syncLocalOrderFromShopify(remote);
        result.updated += 1;
      } catch (err) {
        result.failed += 1;
        console.error('[order-reconcile] failed for order', local.shopifyOrderId, err.message);
      }
    }
  }
  return result;
}

module.exports = { reconcileActiveOrders };
