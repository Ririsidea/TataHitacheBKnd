const { WebhookLog, Order, OrderLineItem } = require('../models');
const shopify = require('../services/shopify/client');
const { mapShopifyProduct } = require('../services/shopify/productMapper');
const { orderFlags } = require('../utils/orderStatus');
const orderEvents = require('../services/orderEvents');

async function getEvents(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const events = await WebhookLog.findAll({ order: [['receivedAt', 'DESC']], limit });
    res.json({ success: true, data: events });
  } catch (err) {
    next(err);
  }
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
    const data = orders.map((o) => ({ ...o.toJSON(), ...orderFlags(o) }));
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const HEARTBEAT_MS = 25000;

// Server-Sent Events: pushes an "order" event whenever an order's status changes, however it
// changed (admin action, cancel, edit, Shopify webhook), so open screens update without a
// refresh. ?employeeEmail= limits the stream to that employee's orders (the Orders page);
// without it every order is streamed (the admin Order Management page).
// The comment-line heartbeat keeps proxies (ngrok, load balancers) from closing an idle stream.
function streamOrderEvents(req, res) {
  const employeeEmail = typeof req.query.employeeEmail === 'string' ? req.query.employeeEmail.trim().toLowerCase() : '';

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write('event: ready\ndata: {}\n\n');

  const unsubscribe = orderEvents.subscribe((event) => {
    if (employeeEmail && String(event.employeeEmail || '').toLowerCase() !== employeeEmail) return;
    res.write(`event: order\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
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

module.exports = { getEvents, getOrders, getProducts, streamOrderEvents };
