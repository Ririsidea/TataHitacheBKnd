const { sequelize } = require('../config/db');
const { Order, OrderLineItem, WebhookLog, InventorySnapshot } = require('../models');
const { shopifyOrderStatusLabel } = require('../utils/orderStatus');
const shopify = require('../services/shopify/client');
const { syncLocalOrderFromShopify } = require('../services/orderSync.service');

function logWebhook(topic, payload) {
  return WebhookLog.create({ topic, payload, verified: true, receivedAt: new Date() });
}

// Shopify expects a fast 200. Respond immediately, then do the (slower)
// database work afterwards so the webhook is never held up.
function respondThenProcess(res, work) {
  res.status(200).json({ received: true });
  Promise.resolve()
    .then(work)
    .catch((err) => console.error('Webhook processing error:', err.message));
}

function mapLineItems(shopifyLineItems = []) {
  return shopifyLineItems.map((li) => ({
    sku: li.sku,
    title: li.title,
    quantity: li.quantity,
    price: li.price ? Number(li.price) : undefined,
  }));
}

async function replaceLineItems(orderId, shopifyLineItems, transaction) {
  await OrderLineItem.destroy({ where: { orderId }, transaction });
  const items = mapLineItems(shopifyLineItems).map((li) => ({ ...li, orderId }));
  if (items.length) {
    await OrderLineItem.bulkCreate(items, { transaction });
  }
}

async function inventoryUpdate(req, res) {
  const payload = req.shopifyPayload;
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
async function productCreate(req, res) {
  const payload = req.shopifyPayload;
  respondThenProcess(res, async () => {
    await logWebhook('products/create', payload);
    shopify.invalidateCatalogCache();
  });
}

async function productUpdate(req, res) {
  const payload = req.shopifyPayload;
  respondThenProcess(res, async () => {
    await logWebhook('products/update', payload);
    shopify.invalidateCatalogCache();
  });
}

async function orderCreate(req, res) {
  const payload = req.shopifyPayload;
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
      closedAt: payload.closed_at || null,
      totalPrice: payload.total_price !== undefined ? Number(payload.total_price) : undefined,
    });

    const items = mapLineItems(payload.line_items).map((li) => ({ ...li, orderId: order.id }));
    if (items.length) {
      await OrderLineItem.bulkCreate(items);
    }
  });
}

async function orderUpdated(req, res) {
  const payload = req.shopifyPayload;
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

      const fields = {
        status: shopifyOrderStatusLabel(payload).toLowerCase(),
        financialStatus: payload.financial_status,
        fulfillmentStatus: payload.fulfillment_status,
        closedAt: payload.closed_at || null,
        totalPrice: payload.total_price !== undefined ? Number(payload.total_price) : undefined,
      };
      // A field missing from the payload is left as-is rather than blanked.
      Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
      await order.update(fields, { transaction });
      await replaceLineItems(order.id, payload.line_items, transaction);
    });
  });
}

// orders/edited: the payload describes the edit (quantity deltas / address change flag),
// not the resulting order, so the order is re-fetched from Shopify and mirrored in full.
// Idempotent - syncing twice (this + the update endpoint + orders/updated) is harmless.
async function orderEdited(req, res) {
  const payload = req.shopifyPayload;
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

async function orderCancelled(req, res) {
  const payload = req.shopifyPayload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/cancelled', payload);
    // Restocking (if any) is handled by Shopify itself at cancellation time - this
    // handler only mirrors the resulting status locally, it never adjusts inventory.
    console.log('[inventory] order cancelled in Shopify', payload.id, '- restock is Shopify-managed');
    await Order.update({ status: 'cancelled' }, { where: { shopifyOrderId: String(payload.id) } });
  });
}

async function orderPaid(req, res) {
  const payload = req.shopifyPayload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/paid', payload);
    await Order.update({ financialStatus: 'PENDING' }, { where: { shopifyOrderId: String(payload.id) } });
  });
}

async function orderFulfilled(req, res) {
  const payload = req.shopifyPayload;
  respondThenProcess(res, async () => {
    await logWebhook('orders/fulfilled', payload);
    await Order.update(
      { fulfillmentStatus: 'fulfilled' },
      { where: { shopifyOrderId: String(payload.id) } }
    );
  });
}

async function fulfillmentCreate(req, res) {
  const payload = req.shopifyPayload;
  respondThenProcess(res, async () => {
    await logWebhook('fulfillments/create', payload);
    await Order.update(
      {
        trackingNumber: payload.tracking_number,
        trackingUrl: payload.tracking_url,
        carrier: payload.tracking_company,
        fulfillmentStatus: payload.status,
      },
      { where: { shopifyOrderId: String(payload.order_id) } }
    );
  });
}

async function fulfillmentUpdate(req, res) {
  const payload = req.shopifyPayload;
  respondThenProcess(res, async () => {
    await logWebhook('fulfillments/update', payload);
    await Order.update(
      {
        trackingNumber: payload.tracking_number,
        trackingUrl: payload.tracking_url,
        carrier: payload.tracking_company,
        fulfillmentStatus: payload.status,
      },
      { where: { shopifyOrderId: String(payload.order_id) } }
    );
  });
}

async function refundCreate(req, res) {
  const payload = req.shopifyPayload;
  respondThenProcess(res, async () => {
    await logWebhook('refunds/create', payload);
    // Same as cancellation: Shopify applies any restock itself based on the refund's
    // line-item restock settings. We just mirror status locally.
    console.log('[inventory] refund created in Shopify for order', payload.order_id, '- restock is Shopify-managed');
    await Order.update(
      { status: 'refunded', financialStatus: 'refunded' },
      { where: { shopifyOrderId: String(payload.order_id) } }
    );
  });
}

module.exports = {
  inventoryUpdate,
  productCreate,
  productUpdate,
  orderCreate,
  orderUpdated,
  orderEdited,
  orderCancelled,
  orderPaid,
  orderFulfilled,
  fulfillmentCreate,
  fulfillmentUpdate,
  refundCreate,
};
