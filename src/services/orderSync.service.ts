import { sequelize } from '../config/db';
import { Order, OrderLineItem } from '../models';
import type { OrderInstance, OrderAttributes } from '../models/Order';
import type { OrderLineItemInstance } from '../models/OrderLineItem';
import { shopifyOrderStatusLabel, shopifyDeliveryStatus, shopifyTracking } from '../utils/orderStatus';
import type { ShopifyOrder } from '../types/shopify';

type OrderFields = Partial<Pick<OrderAttributes, 'status' | 'financialStatus' | 'fulfillmentStatus' | 'closedAt' | 'totalPrice' | 'deliveryStatus' | 'trackingNumber' | 'trackingUrl' | 'carrier'>>;

// The order columns Shopify owns, read from a Shopify order (REST shape - the same field names
// the webhooks use): status, payment, fulfilment, delivery, tracking, total. A field the
// payload does not carry is left out, so a partial payload never blanks what MAP already has.
export function orderFieldsFromShopify(shopifyOrder: ShopifyOrder): OrderFields {
  const total = shopifyOrder.current_total_price ?? shopifyOrder.total_price;
  const fields: Record<string, unknown> = {
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
  return fields as OrderFields;
}

interface MirroredLine {
  sku: string | null | undefined;
  title: string | null | undefined;
  quantity: number;
  price: number | undefined;
}

// After an order is edited in Shopify Admin, removed/reduced units are excluded: quantity is
// current_quantity when Shopify sends it, and lines that ended at 0 are dropped.
function lineItemsFromShopify(shopifyOrder: ShopifyOrder): MirroredLine[] {
  return (shopifyOrder.line_items || [])
    .map((li) => ({
      sku: li.sku,
      title: li.title,
      quantity: (Number.isInteger(li.current_quantity) ? li.current_quantity : li.quantity) as number,
      price: li.price ? Number(li.price) : undefined,
    }))
    .filter((li) => li.quantity > 0);
}

// Mirrors a full Shopify order into MySQL: orders + order_line_items, inside one transaction
// with a row lock. Idempotent: syncing the same order twice (orders/updated + orders/edited
// webhooks + the background reconciler) ends in the same state and can never duplicate line items.
export async function syncLocalOrderFromShopify(shopifyOrder: ShopifyOrder): Promise<number | null> {
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

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() === new Date(b as Date).getTime();
  return String(a) === String(b);
};

const lineSignature = (lines: { sku?: string | null; quantity?: number | null }[]): string =>
  lines
    .map((li) => `${li.sku || ''}|${li.quantity}`)
    .sort()
    .join(',');

// True when MAP's copy of the order (a row loaded with its lineItems) already matches Shopify.
// The background reconciler uses it so an unchanged order costs no write.
export function orderMatchesShopify(localOrder: OrderInstance, shopifyOrder: ShopifyOrder): boolean {
  const fields = orderFieldsFromShopify(shopifyOrder) as Record<string, unknown>;
  const local = localOrder as unknown as Record<string, unknown>;
  const fieldsMatch = Object.keys(fields).every((key) => {
    if (key === 'totalPrice') return Number(local[key]) === Number(fields[key]);
    return sameValue(local[key], fields[key]);
  });
  if (!fieldsMatch) return false;
  return lineSignature((localOrder.lineItems || []) as OrderLineItemInstance[]) === lineSignature(lineItemsFromShopify(shopifyOrder));
}
