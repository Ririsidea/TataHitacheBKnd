const { Op } = require('sequelize');
const { Order, OrderLineItem } = require('../models');
const shopify = require('./shopify/client');
const orderActions = require('./shopify/orderActions');
const { httpError } = require('./shopify/orderEdit');
const { syncLocalOrderFromShopify } = require('./orderSync.service');
const { shopifyOrderStatusLabel, isOrderFulfilled, orderFlags, LOCKED_MESSAGE } = require('../utils/orderStatus');

// Admin order-status actions: Mark as Paid and Mark as Fulfilled (pending -> paid -> fulfilled).
//
// Both follow the same flow as cancel / edit:
//   1. gate on MAP's own copy (fast, nothing is touched if it says no)
//   2. atomically claim the order (status -> "updating") so a concurrent cancel, edit or
//      status action is turned away before Shopify is called
//   3. re-check the LIVE Shopify order (the local copy may lag a webhook)
//   4. change it in Shopify, then re-read it and mirror it into MySQL
//   5. release the claim on every path
// A fulfilled order is final: every step above refuses it, so the lock cannot be bypassed
// by calling the API directly.

const lower = (value) => String(value || '').toLowerCase();

// Any failure that is not already HTTP-shaped is a Shopify/transport problem: log the detail,
// return a clean 502 (a missing app scope is called out because it is a setup issue).
async function viaShopify(fn, scopeHint) {
  try {
    return await fn();
  } catch (err) {
    if (err.statusCode) throw err;
    console.error('[order-status] Shopify call failed:', err.message);
    if (/access denied|required access|scope/i.test(err.message)) {
      throw httpError(502, `Shopify app is missing the ${scopeHint} scope - add it to the custom app and reinstall/approve it`);
    }
    throw httpError(502, 'Could not reach Shopify right now. Please try again.');
  }
}

async function loadByShopifyId(shopifyOrderId) {
  if (!/^\d+$/.test(String(shopifyOrderId))) throw httpError(400, 'Shopify order id must be numeric');
  const order = await Order.findOne({ where: { shopifyOrderId: String(shopifyOrderId) } });
  if (!order) throw httpError(404, 'Order not found');
  if (!order.shopifyOrderId) throw httpError(409, 'Order has no Shopify order');
  return order;
}

// Gate on MAP's own copy of the order.
function assertActionable(order, allowedStatuses) {
  if (isOrderFulfilled(order)) throw httpError(409, LOCKED_MESSAGE);
  if (order.status === 'updating') throw httpError(409, 'Order is being modified, try again');
  if (!allowedStatuses.includes(order.status)) {
    throw httpError(409, `Order cannot be changed - current status is ${String(order.status).toUpperCase()}`);
  }
}

// Same atomic-claim pattern as cancel / edit: exactly one caller can take the order.
async function claim(order, allowedStatuses) {
  const [claimed] = await Order.update(
    { status: 'updating' },
    { where: { id: order.id, status: { [Op.in]: allowedStatuses } } }
  );
  if (claimed) return;
  const current = await Order.findByPk(order.id);
  if (current) assertActionable(current, allowedStatuses);
  throw httpError(409, 'Order cannot be changed right now');
}

async function withClaim(order, allowedStatuses, work) {
  const previousStatus = order.status;
  await claim(order, allowedStatuses);
  try {
    return await work();
  } finally {
    // Paths that synced from Shopify already rewrote the status (so this is a no-op);
    // a failure before that puts the order back exactly as it was.
    await Order.update({ status: previousStatus }, { where: { id: order.id, status: 'updating' } }).catch((err) =>
      console.error('[order-status] failed to release claim for order', order.id, err.message)
    );
  }
}

// The local copy said yes; Shopify has the last word. When it disagrees, MAP's copy is
// corrected on the spot (so the UI catches up) and the action is refused.
async function assertLiveActionable(live) {
  if (lower(live.fulfillment_status) === 'fulfilled') {
    await syncLocalOrderFromShopify(live);
    throw httpError(409, LOCKED_MESSAGE);
  }
  const label = shopifyOrderStatusLabel(live);
  if (label === 'CANCELLED' || label === 'CLOSED') {
    await syncLocalOrderFromShopify(live);
    throw httpError(409, `Order cannot be changed - current status is ${label}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Re-reads the order from Shopify and mirrors it into MySQL. Shopify occasionally needs a
// moment before a fresh payment / fulfilment shows on the order, so a few short retries wait
// for `isDone` - the response then carries the real new status, not a stale one.
async function refreshFromShopify(order, isDone) {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const fresh = await shopify.getOrder(order.shopifyOrderId);
      if (isDone(fresh) || attempt === attempts) {
        await syncLocalOrderFromShopify(fresh);
        return;
      }
    } catch (err) {
      console.error('[order-status] CRITICAL - Shopify updated but local sync failed', order.shopifyOrderId, err.message);
      throw httpError(502, 'The order was updated in Shopify but MAP could not refresh its copy - it will resync automatically via webhook');
    }
    await sleep(700);
  }
}

async function toOrderView(orderId) {
  const order = await Order.findByPk(orderId, { include: [{ model: OrderLineItem, as: 'lineItems' }] });
  return { ...order.toJSON(), ...orderFlags(order) };
}

// Pending -> Paid. Records a manual payment on the Shopify order.
async function markOrderPaid(shopifyOrderId) {
  const order = await loadByShopifyId(shopifyOrderId);
  assertActionable(order, ['open']);
  if (lower(order.financialStatus) === 'paid') throw httpError(409, 'Order is already paid');

  return withClaim(order, ['open'], async () => {
    const live = await viaShopify(() => shopify.getOrder(order.shopifyOrderId), 'read_orders');
    await assertLiveActionable(live);
    if (lower(live.financial_status) === 'paid') {
      await syncLocalOrderFromShopify(live);
      throw httpError(409, 'Order is already paid');
    }

    await viaShopify(() => orderActions.markOrderAsPaid(order.shopifyOrderId), 'write_orders');
    await refreshFromShopify(order, (fresh) => lower(fresh.financial_status) === 'paid');
    return toOrderView(order.id);
  });
}

// Paid -> Fulfilled. Creates the fulfillment in Shopify; the order is locked afterwards.
// An order that is only partly fulfilled (status "fulfilled", not locked) can be completed.
async function markOrderFulfilled(shopifyOrderId) {
  const order = await loadByShopifyId(shopifyOrderId);
  const allowed = ['open', 'fulfilled'];
  assertActionable(order, allowed);

  return withClaim(order, allowed, async () => {
    const live = await viaShopify(() => shopify.getOrder(order.shopifyOrderId), 'read_orders');
    await assertLiveActionable(live);
    if (lower(live.financial_status) !== 'paid') {
      await syncLocalOrderFromShopify(live);
      throw httpError(409, 'Order must be marked as paid before it can be fulfilled');
    }

    await viaShopify(
      () => orderActions.fulfillOrder(order.shopifyOrderId),
      'write_merchant_managed_fulfillment_orders'
    );
    await refreshFromShopify(order, (fresh) => lower(fresh.fulfillment_status) === 'fulfilled');
    return toOrderView(order.id);
  });
}

const PAGE_SIZE_DEFAULT = 10;
const PAGE_SIZE_MAX = 50;

// Every order, newest first, for the admin Order Management screen. Optional ?q= matches the
// Shopify order id, employee name or employee email.
async function listOrders({ page, pageSize, q }) {
  const currentPage = Math.max(parseInt(page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(pageSize, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);

  const where = {};
  const query = typeof q === 'string' ? q.trim() : '';
  if (query) {
    const like = { [Op.like]: `%${query.slice(0, 100)}%` };
    where[Op.or] = [{ shopifyOrderId: like }, { employeeEmail: like }, { employeeName: like }];
  }

  const { rows, count } = await Order.findAndCountAll({
    where,
    include: [{ model: OrderLineItem, as: 'lineItems' }],
    order: [['createdAt', 'DESC']],
    limit: size,
    offset: (currentPage - 1) * size,
    distinct: true,
  });

  return {
    items: rows.map((order) => ({ ...order.toJSON(), ...orderFlags(order) })),
    page: currentPage,
    pageSize: size,
    total: count,
    totalPages: Math.max(1, Math.ceil(count / size)),
  };
}

module.exports = { markOrderPaid, markOrderFulfilled, listOrders };
