import type { Request, Response } from 'express';
import { Order, WebhookLog, InventorySnapshot } from '../models';
import { errorMessage } from '../utils/errors';
import * as shopify from '../services/shopify/client';
import { syncLocalOrderFromShopify, upsertOrderFromWebhook } from '../services/orderSync.service';
import { piiFieldsFromWebhookPayload } from '../services/orderDetails';
import type { ShopifyOrder } from '../types/shopify';

// A verified webhook body. Shopify's payloads are large and vary by topic, so the fields read
// below are accessed loosely (see types/shopify.ts for the typed order shape).
type Payload = ShopifyOrder & {
  inventory_item_id?: string | number;
  location_id?: string | number;
  available?: number | null;
  order_id?: string | number;
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

// Every topic that carries a full order object (create, updated, paid, cancelled, fulfilled)
// goes through this one path: upsert the order (creating it if MAP has never seen this
// shopify_order_id - a webhook can arrive before, or instead of, create-order's own insert),
// replace its line items, and mirror the address/customer fields that only the raw webhook body
// carries (services/orderDetails.ts - never from a live Shopify read, see that file's comment).
async function ingestOrderPayload(payload: ShopifyOrder): Promise<void> {
  await upsertOrderFromWebhook(payload, piiFieldsFromWebhookPayload(payload));
}

// A fulfillment object's own status ("success", "pending", ...) is not the order's
// fulfilment status, so the fulfillment webhooks re-read the order and mirror it in full -
// the order then always carries Shopify's "fulfilled" / "partial" / empty value. This is a live
// REST read, so it never touches the address/customer fields - only orderCreate/orderUpdated/
// orderPaid/orderCancelled/orderFulfilled (the raw webhook body) do.
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

export async function orderCreate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/create', payload);
    await ingestOrderPayload(payload);
  });
}

export async function orderUpdated(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/updated', payload);
    await ingestOrderPayload(payload);
  });
}

export async function orderCancelled(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/cancelled', payload);
    // Restocking (if any) is handled by Shopify itself at cancellation time - this
    // handler only mirrors the resulting status (and now cancel_reason/cancelled_at)
    // locally, it never adjusts inventory. payload.id is the Shopify order id, not PII.
    console.log('[inventory] order cancelled in Shopify', payload.id, '- restock is Shopify-managed');
    await ingestOrderPayload(payload);
  });
}

export async function orderPaid(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/paid', payload);
    // Mirror Shopify's own payment status ("paid"), and the rest of the order detail, so the
    // app shows the order as Paid and the export sheet has whatever this payload adds.
    await ingestOrderPayload(payload);
  });
}

export async function orderFulfilled(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/fulfilled', payload);
    // Status moves together with the fulfilment status, so the order can never read
    // "open" while already fulfilled (orderFieldsFromShopify derives both from the same payload).
    await ingestOrderPayload(payload);
  });
}

export async function fulfillmentCreate(req: Request, res: Response): Promise<void> {
  const payload = (req.shopifyPayload ?? {}) as Payload;
  respondThenProcess(res, async () => {
    await logWebhook('fulfillments/create', payload);
    if (payload.order_id === undefined) return;
    await Order.update(
      { trackingNumber: payload.tracking_number, trackingUrl: payload.tracking_url, carrier: payload.tracking_company },
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
      { trackingNumber: payload.tracking_number, trackingUrl: payload.tracking_url, carrier: payload.tracking_company },
      { where: { shopifyOrderId: String(payload.order_id) } }
    );
    await mirrorOrderFromShopify(payload.order_id);
  });
}
