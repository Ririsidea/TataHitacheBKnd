// One-off backfill for orders that existed before the order-detail columns did (see
// config/ensureSchema.ts ensureOrderDetailColumns). For each such order, this looks for the raw
// webhook payload MAP already logged for it (webhook_logs.payload - the actual signed body
// Shopify sent, not a live API read) and, if found, mirrors the same detail fields the live
// webhook handlers do (services/orderSync.service.ts + services/orderDetails.ts). An order with
// no logged payload is left exactly as it is - this never calls Shopify, and never invents data.
import { sequelize } from '../config/db';
import { Order, OrderLineItem } from '../models';
import type { OrderAttributes } from '../models/Order';
import { orderFieldsFromShopify, lineItemsFromShopify } from './orderSync.service';
import { piiFieldsFromWebhookPayload } from './orderDetails';
import type { ShopifyOrder } from '../types/shopify';

const ORDER_PAYLOAD_TOPICS = ['orders/create', 'orders/updated', 'orders/paid', 'orders/cancelled', 'orders/fulfilled'];

export interface BackfillResult {
  total: number;
  backfilled: number;
  noLogFound: number;
}

interface CandidateRow {
  id: number;
  shopify_order_id: string;
}

interface PayloadRow {
  payload: unknown;
}

// Orders with no order detail yet: order_number is NULL is the marker (it is set by every
// webhook handler now, so its absence means this row predates that - or every webhook for it
// happened to carry no detail, which the re-run below then simply confirms by finding no log).
async function findCandidates(): Promise<CandidateRow[]> {
  const [rows] = (await sequelize.query(
    "SELECT id, shopify_order_id FROM orders WHERE order_number IS NULL AND shopify_order_id IS NOT NULL"
  )) as [CandidateRow[], unknown];
  return rows;
}

// The most recent logged webhook payload whose own `id` matches this Shopify order - i.e. the
// real, unredacted body Shopify sent for it, exactly as webhook.controller.ts would have read it.
async function findLoggedPayload(shopifyOrderId: string): Promise<ShopifyOrder | null> {
  const [rows] = (await sequelize.query(
    `SELECT payload FROM webhook_logs
     WHERE topic IN (:topics) AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.id')) = :id
     ORDER BY id DESC LIMIT 1`,
    { replacements: { topics: ORDER_PAYLOAD_TOPICS, id: shopifyOrderId } }
  )) as [PayloadRow[], unknown];
  if (!rows.length) return null;
  const raw = rows[0]!.payload;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as ShopifyOrder;
}

export async function backfillOrderDetailsFromLogs(): Promise<BackfillResult> {
  const candidates = await findCandidates();
  let backfilled = 0;
  let noLogFound = 0;

  for (const row of candidates) {
    const payload = await findLoggedPayload(row.shopify_order_id);
    if (!payload) {
      noLogFound += 1;
      continue;
    }

    const fields = { ...orderFieldsFromShopify(payload), ...piiFieldsFromWebhookPayload(payload) };
    const lineItems = lineItemsFromShopify(payload);

    await sequelize.transaction(async (transaction) => {
      await Order.update(fields as Partial<OrderAttributes>, { where: { id: row.id }, transaction });
      await OrderLineItem.destroy({ where: { orderId: row.id }, transaction });
      const rows = lineItems.map((li) => ({ ...li, orderId: row.id }));
      if (rows.length) await OrderLineItem.bulkCreate(rows, { transaction });
      await sequelize.query('UPDATE orders SET raw_payload = ? WHERE id = ?', {
        replacements: [JSON.stringify(payload), row.id],
        transaction,
      });
    });
    backfilled += 1;
  }

  return { total: candidates.length, backfilled, noLogFound };
}
