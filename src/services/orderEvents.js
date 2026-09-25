const { EventEmitter } = require('events');
const { orderFlags } = require('../utils/orderStatus');

// In-process order change feed. Every write to an order row - the admin status actions,
// cancel, edit, and every Shopify webhook - ends up here through the Order model hooks
// (attachOrderHooks, registered in models/index.js), so no code path can change an order
// without the live clients hearing about it. The SSE endpoint
// (GET /api/dashboard/order-events) fans these out to the browsers.
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open browser tab

// The fields a client needs to redraw an order row. Deliberately small: line items are
// not part of the event (a client that needs them refetches the list).
const EVENT_FIELDS = [
  'id',
  'shopifyOrderId',
  'employeeEmail',
  'status',
  'financialStatus',
  'fulfillmentStatus',
  'deliveryStatus',
  'closedAt',
  'totalPrice',
  'trackingNumber',
  'trackingUrl',
  'carrier',
  'updatedAt',
];

function toOrderEvent(order) {
  const plain = typeof order.get === 'function' ? order.get({ plain: true }) : order;
  const event = {};
  EVENT_FIELDS.forEach((field) => {
    event[field] = plain[field] === undefined ? null : plain[field];
  });
  return { ...event, ...orderFlags(plain) };
}

// 'updating' is only the short-lived claim held while an admin action / edit talks to
// Shopify; clients see the final state instead of that transient one.
function isTransient(order) {
  return order.status === 'updating';
}

function publishOrder(order) {
  if (isTransient(order)) return;
  emitter.emit('order', toOrderEvent(order));
}

function subscribe(listener) {
  emitter.on('order', listener);
  return () => emitter.off('order', listener);
}

// Publishing must wait for the commit when the write happened inside a transaction
// (orderSync does), otherwise a rolled-back write would already have been announced.
function whenCommitted(options, fn) {
  const transaction = options && options.transaction;
  if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(fn);
  else fn();
}

function attachOrderHooks(Order) {
  const onInstance = (order, options) => whenCommitted(options, () => publishOrder(order));
  Order.addHook('afterCreate', onInstance);
  Order.addHook('afterUpdate', onInstance);

  // Order.update({...}, { where }) (used by the webhook handlers and the cancel flow) gives
  // hooks only the where clause, so the affected rows are read back to get their new state.
  Order.addHook('afterBulkUpdate', (options) => {
    if (!options.where) return;
    whenCommitted(options, () => {
      Order.findAll({ where: options.where })
        .then((orders) => orders.forEach(publishOrder))
        .catch((err) => console.error('[order-events] could not publish bulk update:', err.message));
    });
  });
}

module.exports = { publishOrder, subscribe, toOrderEvent, attachOrderHooks };
