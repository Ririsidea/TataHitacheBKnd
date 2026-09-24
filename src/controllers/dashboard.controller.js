const { WebhookLog, Order, OrderLineItem } = require('../models');
const shopify = require('../services/shopify/client');
const { mapShopifyProduct } = require('../services/shopify/productMapper');
const { isOrderUpdatable } = require('../utils/orderStatus');

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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The list is always scoped to one employee, by the required ?employeeEmail= query
// param - the query itself filters, never "fetch everything and filter in the frontend".
async function getOrders(req, res, next) {
  try {
    const employeeEmail = typeof req.query.employeeEmail === 'string' ? req.query.employeeEmail.trim().toLowerCase() : '';
    if (!employeeEmail || employeeEmail.length > 255 || !EMAIL_PATTERN.test(employeeEmail)) {
      return res.status(400).json({ success: false, message: 'A valid employeeEmail query parameter is required' });
    }
    const orders = await Order.findAll({
      where: { employeeEmail },
      order: [['createdAt', 'DESC']],
      include: [{ model: OrderLineItem, as: 'lineItems' }],
    });
    const data = orders.map((o) => ({
      ...o.toJSON(),
      canCancel: isLocallyCancellable(o),
      canUpdate: isOrderUpdatable(o),
    }));
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
