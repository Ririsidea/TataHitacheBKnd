import { Op } from 'sequelize';
import { Order, OrderLineItem } from '../models';
import type { OrderInstance } from '../models/Order';
import * as shopify from './shopify/client';
import * as orderActions from './shopify/orderActions';
import { syncLocalOrderFromShopify } from './orderSync.service';
import {
  shopifyOrderStatusLabel,
  isOrderFulfilled,
  isShopifyOrderId,
  orderFlags,
  LOCKED_MESSAGE,
  SHOPIFY_ORDER_ID_MESSAGE,
  type OrderFlags,
} from '../utils/orderStatus';
import { ConfigError, UNAVAILABLE_MESSAGE, httpError, errorMessage, hasStatusCode } from '../utils/errors';
import { alertServerError } from './alert';
import type { ShopifyOrder } from '../types/shopify';

// Admin order-status actions: Mark as Paid and Mark as Fulfilled (pending -> paid -> fulfilled).
//
// Both follow the same flow as cancel:
//   1. gate on MAP's own copy (fast, nothing is touched if it says no)
//   2. atomically claim the order (status -> "updating") so a concurrent cancel or
//      status action is turned away before Shopify is called
//   3. re-check the LIVE Shopify order (the local copy may lag a webhook)
//   4. change it in Shopify, then re-read it and mirror it into MySQL
//   5. release the claim on every path
// A fulfilled order is final: every step above refuses it, so the lock cannot be bypassed
// by calling the API directly.

const lower = (value: unknown): string => String(value || '').toLowerCase();

// Any failure that is not already HTTP-shaped is a Shopify/transport problem: log the detail and
// answer 502 (Shopify down) - or, for a missing app scope, a server misconfiguration (500 + alert).
async function viaShopify<T>(fn: () => Promise<T>, scopeHint: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (hasStatusCode(err)) throw err;
    console.error('[order-status] Shopify call failed:', errorMessage(err));
    if (/access denied|required access|scope/i.test(errorMessage(err))) {
      throw new ConfigError(`Shopify app is missing the ${scopeHint} scope - add it to the custom app and reinstall/approve it`);
    }
    throw httpError(502, UNAVAILABLE_MESSAGE);
  }
}

async function loadByShopifyId(shopifyOrderId: unknown): Promise<OrderInstance> {
  if (!isShopifyOrderId(shopifyOrderId)) throw httpError(400, SHOPIFY_ORDER_ID_MESSAGE);
  const order = await Order.findOne({ where: { shopifyOrderId: String(shopifyOrderId) } });
  if (!order) throw httpError(404, 'Order not found');
  if (!order.shopifyOrderId) throw httpError(409, 'Order has no Shopify order');
  return order;
}

// Gate on MAP's own copy of the order.
function assertActionable(order: OrderInstance, allowedStatuses: string[]): void {
  if (isOrderFulfilled(order)) throw httpError(409, LOCKED_MESSAGE);
  if (order.status === 'updating') throw httpError(409, 'Order is being modified, try again');
  if (!allowedStatuses.includes(order.status)) {
    throw httpError(409, `Order cannot be changed - current status is ${String(order.status).toUpperCase()}`);
  }
}

// Same atomic-claim pattern as cancel: exactly one caller can take the order.
async function claim(order: OrderInstance, allowedStatuses: string[]): Promise<void> {
  const [claimed] = await Order.update(
    { status: 'updating' },
    { where: { id: order.id, status: { [Op.in]: allowedStatuses } } }
  );
  if (claimed) return;
  const current = await Order.findByPk(order.id);
  if (current) assertActionable(current, allowedStatuses);
  throw httpError(409, 'Order cannot be changed right now');
}

async function withClaim<T>(order: OrderInstance, allowedStatuses: string[], work: () => Promise<T>): Promise<T> {
  const previousStatus = order.status;
  await claim(order, allowedStatuses);
  try {
    return await work();
  } finally {
    // Paths that synced from Shopify already rewrote the status (so this is a no-op);
    // a failure before that puts the order back exactly as it was.
    await Order.update({ status: previousStatus }, { where: { id: order.id, status: 'updating' } }).catch((err: unknown) =>
      console.error('[order-status] failed to release claim for order', order.id, errorMessage(err))
    );
  }
}

// The local copy said yes; Shopify has the last word. When it disagrees, MAP's copy is
// corrected on the spot (so the UI catches up) and the action is refused.
async function assertLiveActionable(live: ShopifyOrder): Promise<void> {
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Re-reads the order from Shopify and mirrors it into MySQL. Shopify occasionally needs a
// moment before a fresh payment / fulfilment shows on the order, so a few short retries wait
// for `isDone` - the response then carries the real new status, not a stale one.
async function refreshFromShopify(order: OrderInstance, isDone: (fresh: ShopifyOrder) => boolean): Promise<void> {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const fresh = await shopify.getOrder(order.shopifyOrderId as string);
      if (isDone(fresh) || attempt === attempts) {
        await syncLocalOrderFromShopify(fresh);
        return;
      }
    } catch (err) {
      // The change IS made in Shopify, so the request succeeded; only MAP's own copy is behind and the
      // next Shopify webhook / the reconciler brings it level. Logged and alerted, never a failure.
      console.error('[order-status] Shopify updated but local sync failed', order.shopifyOrderId, errorMessage(err));
      void alertServerError({
        key: 'local-sync',
        title: `Shopify order ${order.shopifyOrderId} was updated but MAP could not refresh its copy`,
        detail: errorMessage(err),
      });
      return;
    }
    await sleep(700);
  }
}

export type OrderView = Record<string, unknown> & OrderFlags;

async function toOrderView(orderId: number): Promise<OrderView> {
  const order = await Order.findByPk(orderId, { include: [{ model: OrderLineItem, as: 'lineItems' }] });
  if (!order) throw httpError(404, 'Order not found');
  return { ...order.toJSON(), ...orderFlags(order) };
}

// Pending -> Paid. Records a manual payment on the Shopify order.
export async function markOrderPaid(shopifyOrderId: unknown): Promise<OrderView> {
  const order = await loadByShopifyId(shopifyOrderId);
  assertActionable(order, ['open']);
  if (lower(order.financialStatus) === 'paid') throw httpError(409, 'Order is already paid');

  return withClaim(order, ['open'], async () => {
    const live = await viaShopify(() => shopify.getOrder(order.shopifyOrderId as string), 'read_orders');
    await assertLiveActionable(live);
    if (lower(live.financial_status) === 'paid') {
      await syncLocalOrderFromShopify(live);
      throw httpError(409, 'Order is already paid');
    }

    await viaShopify(() => orderActions.markOrderAsPaid(order.shopifyOrderId as string), 'write_orders');
    await refreshFromShopify(order, (fresh) => lower(fresh.financial_status) === 'paid');
    return toOrderView(order.id);
  });
}

// Paid -> Fulfilled. Creates the fulfillment in Shopify; the order is locked afterwards.
// An order that is only partly fulfilled (status "fulfilled", not locked) can be completed.
export async function markOrderFulfilled(shopifyOrderId: unknown): Promise<OrderView> {
  const order = await loadByShopifyId(shopifyOrderId);
  const allowed = ['open', 'fulfilled'];
  assertActionable(order, allowed);

  return withClaim(order, allowed, async () => {
    const live = await viaShopify(() => shopify.getOrder(order.shopifyOrderId as string), 'read_orders');
    await assertLiveActionable(live);
    if (lower(live.financial_status) !== 'paid') {
      await syncLocalOrderFromShopify(live);
      throw httpError(409, 'Order must be marked as paid before it can be fulfilled');
    }

    await viaShopify(
      () => orderActions.fulfillOrder(order.shopifyOrderId as string),
      'write_merchant_managed_fulfillment_orders'
    );
    await refreshFromShopify(order, (fresh) => lower(fresh.fulfillment_status) === 'fulfilled');
    return toOrderView(order.id);
  });
}
