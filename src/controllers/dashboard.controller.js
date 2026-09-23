const { WebhookLog, Order, OrderLineItem } = require('../models');
const shopify = require('../services/shopify');
const { mapShopifyProduct } = require('../utils/productMapper');

async function getEvents(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const events = await WebhookLog.findAll({ order: [['receivedAt', 'DESC']], limit });
    res.json({ success: true, data: events });
  } catch (err) {
    next(err);
  }
}

// A cancel button is only worth showing for an order that's still open (not yet
// fulfilled or closed) - the actual cancel request re-validates this live against
// Shopify regardless, this is just a fast, non-authoritative signal for the UI.
function isLocallyCancellable(order) {
  return order.status === 'open' && !order.fulfillmentStatus && !order.closedAt;
}

// Customers only ever see their own orders - the query itself is scoped to the
// authenticated user, never "fetch everything and filter in the frontend".
async function getOrders(req, res, next) {
  try {
    const orders = await Order.findAll({
      where: { employeeEmail: req.user.email },
      order: [['createdAt', 'DESC']],
      include: [{ model: OrderLineItem, as: 'lineItems' }],
    });
    const data = orders.map((o) => ({ ...o.toJSON(), canCancel: isLocallyCancellable(o) }));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getProducts(req, res, next) {
  try {
    const products = await shopify.listProductsCatalog();
    const data = products.map(mapShopifyProduct).filter(Boolean);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

module.exports = { getEvents, getOrders, getProducts };
