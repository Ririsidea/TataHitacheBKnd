import type { Request, Response } from 'express';
import type { Transaction } from 'sequelize';
import { sequelize } from '../config/db';
import { Order, OrderLineItem, WebhookLog, InventorySnapshot } from '../models';
import type { OrderAttributes } from '../models/Order';
import { shopifyOrderStatusLabel, shopifyDeliveryStatus, shopifyTracking } from '../utils/orderStatus';
import { errorMessage } from '../utils/errors';
import * as shopify from '../services/shopify/client';
import { syncLocalOrderFromShopify } from '../services/orderSync.service';
import type { ShopifyLineItem, ShopifyOrder } from '../types/shopify';

// A verified webhook body. Shopify's payloads are large and vary by topic, so the fields read
// below are accessed loosely (see types/shopify.ts for the typed order shape).
type Payload = ShopifyOrder & {
  inventory_item_id?: string | number;
  location_id?: string | number;
  available?: number | null;
  order_id?: string | number;
  order_edit?: { order_id?: string | number };
  tracking_number?: string | null;
  tracking_url?: string | null;
  tracking_company?: string | null;
};

function logWebhook(topic: string, payload: unknown) {
  return WebhookLog.create({ topic, payload, verified: true, receivedAt: new Date() });
}

// Shopify expects a fast 200. Respond immediately, then do the (slower)
// database work afterwards so the webhook is never held up.
function respondThenProcess(res: Response, work: () => Promise<void>): void {
  res.status(200).json({ received: true });
  Promise.resolve()
    .then(work)
    .catch((err: unknown) => console.error('Webhook processing error:', errorMessage(err)));
}

function mapLineItems(shopifyLineItems: ShopifyLineItem[] = []) {
  return shopifyLineItems.map((li) => ({
    sku: li.sku,
    title: li.title,
    quantity: li.quantity,
    price: li.price ? Number(li.price) : undefined,
  }));
}

async function replaceLineItems(orderId: number, shopifyLineItems: ShopifyLineItem[] | undefined, transaction: Transaction): Promise<void> {
  await OrderLineItem.destroy({ where: { orderId }, transaction });
  const items = mapLineItems(shopifyLineItems).map((li) => ({ ...li, orderId }));
  if (items.length) {
    await OrderLineItem.bulkCreate(items, { transaction });
  }
}

// A fulfillment object's own status ("success", "pending", ...) is not the order's
// fulfilment status, so the fulfillment webhooks re-read the order and mirror it in full -
// the order then always carries Shopify's "fulfilled" / "partial" / empty value.
async function mirrorOrderFromShopify(orderId: number | string): Promise<void> {
  try {
    const shopifyOrder = await shopify.getOrder(orderId);
    await syncLocalOrderFromShopify(shopifyOrder);
  } catch (err) {
    console.error('Could not mirror order', orderId, 'from Shopify:', errorMessage(err));
  }
}

export async function inventoryUpdate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('inventory_levels/update', payload);
    shopify.invalidateCatalogCache();
    const inventoryItemId = String(payload.inventory_item_id);
    const locationId = String(payload.location_id);

    await InventorySnapshot.upsert({
      inventoryItemId,
      locationId,
      available: payload.available,
      updatedAt: new Date(),
    });
  });
}

// Product data is never cached locally - the Shop/Products pages always read it
// live from Shopify (see shopify.listProductsCatalog) - so these two handlers only
// need to log the webhook event for the Live Events feed.
export async function productCreate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('products/create', payload);
    shopify.invalidateCatalogCache();
  });
}

export async function productUpdate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('products/update', payload);
    shopify.invalidateCatalogCache();
  });
}

export async function orderCreate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/create', payload);
    const shopifyOrderId = String(payload.id);
    const existing = await Order.findOne({ where: { shopifyOrderId } });
    if (existing) return;

    const order = await Order.create({
      shopifyOrderId,
      status: shopifyOrderStatusLabel(payload).toLowerCase(),
      financialStatus: payload.financial_status,
      fulfillmentStatus: payload.fulfillment_status,
      closedAt: payload.closed_at ? new Date(payload.closed_at) : null,
      totalPrice: payload.total_price !== undefined ? Number(payload.total_price) : undefined,
    });

    const items = mapLineItems(payload.line_items).map((li) => ({ ...li, orderId: order.id }));
    if (items.length) {
      await OrderLineItem.bulkCreate(items);
    }
  });
}

export async function orderUpdated(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/updated', payload);
    const shopifyOrderId = String(payload.id);

    // Shopify delivers the same event more than once (retries) and can send two
    // updates for one order at nearly the same moment. The row lock serialises those
    // so the delete-and-reinsert of line items below can never interleave and leave
    // duplicate rows. Re-applying the same payload is otherwise idempotent.
    await sequelize.transaction(async (transaction) => {
      const order = await Order.findOne({
        where: { shopifyOrderId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      // Not an order MAP knows about - nothing to mirror.
      if (!order) return;

      const fields: Record<string, unknown> = {
        status: shopifyOrderStatusLabel(payload).toLowerCase(),
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        closedAt: payload.closed_at ? new Date(payload.closed_at) : null,
        totalPrice: payload.total_price !== undefined ? Number(payload.total_price) : undefined,
        // Delivery + tracking come from the payload's fulfillments (shipment_status), when sent.
        ...(Array.isArray(payload.fulfillments)
          ? { deliveryStatus: shopifyDeliveryStatus(payload), ...shopifyTracking(payload) }
          : {}),
      };
      // A field missing from the payload is left as-is rather than blanked.
      Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
      await order.update(fields as Partial<OrderAttributes>, { transaction });
      await replaceLineItems(order.id, payload.line_items, transaction);
    });
  });
}

// orders/edited: an order was edited in Shopify Admin (MAP itself cannot edit orders). The payload describes
// the edit (quantity deltas / address change flag), not the resulting order, so the order is re-fetched from
// Shopify and mirrored in full. Idempotent - syncing twice (this + orders/updated) is harmless.
export async function orderEdited(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/edited', payload);
    const orderId = (payload.order_edit && payload.order_edit.order_id) || payload.order_id;
    if (!orderId) {
      console.warn('orders/edited webhook without an order id - ignored');
      return;
    }
    const shopifyOrder = await shopify.getOrder(orderId);
    await syncLocalOrderFromShopify(shopifyOrder);
  });
}

export async function orderCancelled(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/cancelled', payload);
    // Restocking (if any) is handled by Shopify itself at cancellation time - this
    // handler only mirrors the resulting status locally, it never adjusts inventory.
    console.log('[inventory] order cancelled in Shopify', payload.id, '- restock is Shopify-managed');
    await Order.update({ status: 'cancelled' }, { where: { shopifyOrderId: String(payload.id) } });
  });
}

export async function orderPaid(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/paid', payload);
    // Mirror Shopify's own payment status ("paid") so the app shows the order as Paid.
    await Order.update({ financialStatus: payload.financial_status }, { where: { shopifyOrderId: String(payload.id) } });
  });
}

export async function orderFulfilled(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/fulfilled', payload);
    // Status moves together with the fulfilment status, so the order can never read
    // "open" while already fulfilled.
    await Order.update(
      {
        status: shopifyOrderStatusLabel(payload).toLowerCase(),
        fulfillmentStatus: payload.fulfillment_status || 'fulfilled',
      },
      { where: { shopifyOrderId: String(payload.id) } }
    );
  });
}

export async function fulfillmentCreate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('fulfillments/create', payload);
    if (payload.order_id === undefined) return;
    await Order.update(
      {
        trackingNumber: payload.tracking_number,
        trackingUrl: payload.tracking_url,
        carrier: payload.tracking_company,
      },
      { where: { shopifyOrderId: String(payload.order_id) } }
    );
    await mirrorOrderFromShopify(payload.order_id);
  });
}

export async function fulfillmentUpdate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('fulfillments/update', payload);
    if (payload.order_id === undefined) return;
    await Order.update(
      {
        trackingNumber: payload.tracking_number,
        trackingUrl: payload.tracking_url,
        carrier: payload.tracking_company,
      },
      { where: { shopifyOrderId: String(payload.order_id) } }
    );
    await mirrorOrderFromShopify(payload.order_id);
  });
}

// fulfillment_events/create: Shopify / the carrier moved the shipment (in transit, out for
// delivery, delivered, ...). The event only names the order, so the order is re-read and mirrored.
export async function fulfillmentEventCreate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('fulfillment_events/create', payload);
    if (!payload.order_id) return;
    await mirrorOrderFromShopify(payload.order_id);
  });
}

export async function refundCreate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('refunds/create', payload);
    // Same as cancellation: Shopify applies any restock itself based on the refund's
    // line-item restock settings. We just mirror status locally.
    console.log('[inventory] refund created in Shopify for order', payload.order_id, '- restock is Shopify-managed');
    await Order.update({ status: 'refunded', financialStatus: 'refunded' }, { where: { shopifyOrderId: String(payload.order_id) } });
  });
}
