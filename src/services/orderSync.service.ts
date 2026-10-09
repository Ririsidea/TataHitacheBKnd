import { sequelize } from '../config/db';
import { Order, OrderLineItem } from '../models';
import type { OrderInstance, OrderAttributes, OrderCreationAttributes } from '../models/Order';
import type { OrderLineItemInstance } from '../models/OrderLineItem';
import { shopifyOrderStatusLabel, shopifyDeliveryStatus, shopifyTracking } from '../utils/orderStatus';
import type { ShopifyFulfillment, ShopifyOrder } from '../types/shopify';

type OrderFields = Partial<
  Pick<
    OrderAttributes,
    | 'status'
    | 'financialStatus'
    | 'fulfillmentStatus'
    | 'closedAt'
    | 'totalPrice'
    | 'deliveryStatus'
    | 'trackingNumber'
    | 'trackingUrl'
    | 'carrier'
    | 'orderNumber'
    | 'subtotalPrice'
    | 'totalDiscount'
    | 'totalTax'
    | 'shippingCharge'
    | 'paymentMethod'
    | 'orderNote'
    | 'tags'
    | 'cancelReason'
    | 'cancelledAt'
    | 'shippedAt'
    | 'deliveredAt'
  >
>;

function toMoney(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// Sums one money field across a list (discount allocations' `amount`, tax/shipping lines'
// `price`) into one number, or undefined if none of the items had a value.
function sumMoney<T>(items: T[] | undefined, extract: (item: T) => string | number | null | undefined): number | undefined {
  if (!items || !items.length) return undefined;
  let total = 0;
  let any = false;
  for (const item of items) {
    const n = toMoney(extract(item));
    if (n !== undefined) {
      total += n;
      any = true;
    }
  }
  return any ? Math.round(total * 100) / 100 : undefined;
}

// shippedAt: the earliest non-cancelled fulfillment's created_at. deliveredAt: the updated_at of
// the fulfillment whose shipment_status is "delivered". Neither is PII - safe from any source
// (REST or webhook) - unlike the address/customer fields in services/orderDetails.ts.
function shippedDeliveredFields(fulfillments: ShopifyFulfillment[] | undefined): Record<string, unknown> {
  const active = (fulfillments || []).filter((f) => String(f.status || '').toLowerCase() !== 'cancelled');
  if (!active.length) return {};
  const createdDates = active.map((f) => f.created_at).filter((d): d is string => Boolean(d)).sort();
  const delivered = active.find((f) => String(f.shipment_status || '').toLowerCase() === 'delivered');
  const fields: Record<string, unknown> = {
    shippedAt: createdDates[0] ? new Date(createdDates[0]) : undefined,
    deliveredAt: delivered?.updated_at ? new Date(delivered.updated_at) : undefined,
  };
  Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
  return fields;
}

// The order columns Shopify owns, read from a Shopify order (REST shape - the same field names
// the webhooks use): status, payment, fulfilment, delivery, tracking, total, and (added for the
// export sheet) order number, totals, payment method, note/tags, cancel reason and ship/deliver
// dates. Every field here is confirmed NOT redacted on a live REST read (unlike
// services/orderDetails.ts's address/customer fields, which are) - safe to call from the
// reconciler, admin actions and the fulfillment-webhook mirror, none of which have the raw
// webhook body. A field the payload does not carry is left out, so a partial payload never
// blanks what MAP already has.
export function orderFieldsFromShopify(shopifyOrder: ShopifyOrder): OrderFields {
  const total = shopifyOrder.current_total_price ?? shopifyOrder.total_price;
  const fields: Record<string, unknown> = {
    status: shopifyOrderStatusLabel(shopifyOrder).toLowerCase(),
    financialStatus: shopifyOrder.financial_status,
    fulfillmentStatus: shopifyOrder.fulfillment_status,
    closedAt: shopifyOrder.closed_at || null,
    totalPrice: total !== undefined && total !== null ? Number(total) : undefined,
    orderNumber: shopifyOrder.name ?? undefined,
    subtotalPrice: toMoney(shopifyOrder.subtotal_price),
    totalDiscount: toMoney(shopifyOrder.total_discounts),
    totalTax: toMoney(shopifyOrder.total_tax),
    shippingCharge: sumMoney(shopifyOrder.shipping_lines, (l) => l.price),
    paymentMethod: shopifyOrder.payment_gateway_names?.length ? shopifyOrder.payment_gateway_names.join(', ') : undefined,
    orderNote: shopifyOrder.note ?? undefined,
    tags: shopifyOrder.tags ?? undefined,
    cancelReason: shopifyOrder.cancel_reason ?? undefined,
    cancelledAt: shopifyOrder.cancelled_at ? new Date(shopifyOrder.cancelled_at) : undefined,
    ...(Array.isArray(shopifyOrder.fulfillments)
      ? { deliveryStatus: shopifyDeliveryStatus(shopifyOrder), ...shopifyTracking(shopifyOrder), ...shippedDeliveredFields(shopifyOrder.fulfillments) }
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
  variantTitle: string | null | undefined;
  lineDiscount: number | undefined;
  lineTax: number | undefined;
}

// After an order is edited in Shopify Admin, removed/reduced units are excluded: quantity is
// current_quantity when Shopify sends it, and lines that ended at 0 are dropped. variantTitle/
// lineDiscount/lineTax are not PII - safe from either a webhook payload or a live REST read.
export function lineItemsFromShopify(shopifyOrder: ShopifyOrder): MirroredLine[] {
  return (shopifyOrder.line_items || [])
    .map((li) => ({
      sku: li.sku,
      title: li.title,
      quantity: (Number.isInteger(li.current_quantity) ? li.current_quantity : li.quantity) as number,
      price: li.price ? Number(li.price) : undefined,
      variantTitle: li.variant_title ?? undefined,
      lineDiscount: sumMoney(li.discount_allocations, (d) => d.amount),
      lineTax: sumMoney(li.tax_lines, (t) => t.price),
    }))
    .filter((li) => li.quantity > 0);
}

// Mirrors a full Shopify order into MySQL: orders + order_line_items, inside one transaction
// with a row lock. Idempotent: syncing the same order twice (a fulfillment webhook and the
// background reconciler, for example) ends in the same state and can never duplicate line items.
// REST-sourced only - see orderFieldsFromShopify's comment on why this never touches PII fields.
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

// Upserts an order straight from a webhook payload: creates the row if MAP has never seen this
// shopify_order_id before, or updates it if it has - then always replaces its line items and
// (raw SQL, not a model attribute - see models/Order.ts) the backend-only raw_payload column.
// `extraFields` is where the caller merges in anything read ONLY from the raw webhook body
// (services/orderDetails.ts's address/customer fields) - this function itself stays REST-safe,
// built on the same orderFieldsFromShopify/lineItemsFromShopify every other caller uses.
export async function upsertOrderFromWebhook(
  shopifyOrder: ShopifyOrder,
  extraFields: Record<string, unknown> = {}
): Promise<{ orderId: number; created: boolean }> {
  const shopifyOrderId = String(shopifyOrder.id);
  const fields = { ...orderFieldsFromShopify(shopifyOrder), ...extraFields };
  const lineItems = lineItemsFromShopify(shopifyOrder);

  return sequelize.transaction(async (transaction) => {
    const existing = await Order.findOne({ where: { shopifyOrderId }, transaction, lock: transaction.LOCK.UPDATE });
    let orderId: number;
    let created = false;

    if (existing) {
      await existing.update(fields as Partial<OrderAttributes>, { transaction });
      orderId = existing.id;
    } else {
      const row = await Order.create({ shopifyOrderId, ...fields } as OrderCreationAttributes, { transaction });
      orderId = row.id;
      created = true;
    }

    await OrderLineItem.destroy({ where: { orderId }, transaction });
    const rows = lineItems.map((li) => ({ ...li, orderId }));
    if (rows.length) await OrderLineItem.bulkCreate(rows, { transaction });

    await sequelize.query('UPDATE orders SET raw_payload = ? WHERE id = ?', {
      replacements: [JSON.stringify(shopifyOrder), orderId],
      transaction,
    });

    return { orderId, created };
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
  const moneyFields = new Set(['totalPrice', 'subtotalPrice', 'totalDiscount', 'totalTax', 'shippingCharge']);
  const fieldsMatch = Object.keys(fields).every((key) => {
    if (moneyFields.has(key)) return Number(local[key]) === Number(fields[key]);
    return sameValue(local[key], fields[key]);
  });
  if (!fieldsMatch) return false;
  return lineSignature((localOrder.lineItems || []) as OrderLineItemInstance[]) === lineSignature(lineItemsFromShopify(shopifyOrder));
}
