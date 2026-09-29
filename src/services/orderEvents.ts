import { EventEmitter } from 'events';
import type { ModelStatic, Transaction } from 'sequelize';
import { orderFlags, type OrderFlags, type OrderLike } from '../utils/orderStatus';
import type { OrderInstance } from '../models/Order';

// In-process order change feed. Every write to an order row - the admin status actions,
// cancel, and every Shopify webhook - ends up here through the Order model hooks
// (attachOrderHooks, registered in models/index.ts), so no code path can change an order
// without the live clients hearing about it. The SSE endpoint
// (GET /api/dashboard/order-events) fans these out to the browsers.
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open browser tab

// The fields a client needs to redraw an order row. Deliberately small: line items are
// not part of the event (a client that needs them refetches the list).
const EVENT_FIELDS = [
  'id',
  'shopifyOrderId',
  'email',
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
] as const;

export type OrderEvent = { [K in (typeof EVENT_FIELDS)[number]]: unknown } & OrderFlags & {
    email: string | null;
  };

type PlainOrder = Record<string, unknown> & OrderLike;

export function toOrderEvent(order: OrderInstance | PlainOrder): OrderEvent {
  const plain = (typeof (order as OrderInstance).get === 'function' ? (order as OrderInstance).get({ plain: true }) : order) as PlainOrder;
  const event: Record<string, unknown> = {};
  EVENT_FIELDS.forEach((field) => {
    event[field] = plain[field] === undefined ? null : plain[field];
  });
  return { ...(event as Record<(typeof EVENT_FIELDS)[number], unknown>), ...orderFlags(plain) } as OrderEvent;
}

// 'updating' is only the short-lived claim held while an admin action talks to
// Shopify; clients see the final state instead of that transient one.
function isTransient(order: OrderLike): boolean {
  return order.status === 'updating';
}

export function publishOrder(order: OrderInstance | PlainOrder): void {
  if (isTransient(order as OrderLike)) return;
  emitter.emit('order', toOrderEvent(order));
}

export function subscribe(listener: (event: OrderEvent) => void): () => void {
  emitter.on('order', listener);
  return () => {
    emitter.off('order', listener);
  };
}

interface HookOptions {
  transaction?: (Transaction & { afterCommit?: (fn: () => void) => void }) | null;
}

// Publishing must wait for the commit when the write happened inside a transaction
// (orderSync does), otherwise a rolled-back write would already have been announced.
function whenCommitted(options: HookOptions | undefined, fn: () => void): void {
  const transaction = options && options.transaction;
  if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(fn);
  else fn();
}

export function attachOrderHooks(Order: ModelStatic<OrderInstance>): void {
  const onInstance = (order: OrderInstance, options: HookOptions) => whenCommitted(options, () => publishOrder(order));
  Order.addHook('afterCreate', onInstance);
  Order.addHook('afterUpdate', onInstance);

  // Order.update({...}, { where }) (used by the webhook handlers and the cancel flow) gives
  // hooks only the where clause, so the affected rows are read back to get their new state.
  Order.addHook('afterBulkUpdate', (options) => {
    if (!options.where) return;
    whenCommitted(options as HookOptions, () => {
      Order.findAll({ where: options.where })
        .then((orders) => orders.forEach(publishOrder))
        .catch((err: Error) => console.error('[order-events] could not publish bulk update:', err.message));
    });
  });
}
