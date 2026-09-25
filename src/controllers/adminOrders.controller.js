const orderStatusService = require('../services/orderStatus.service');

// Admin order management (mounted under /api/admin, so authenticate + requireAdmin already ran).
// :shopifyOrderId is the Shopify order id, the same id the cancel endpoint takes.

async function listOrders(req, res, next) {
  try {
    const data = await orderStatusService.listOrders(req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function markPaid(req, res, next) {
  try {
    const data = await orderStatusService.markOrderPaid(req.params.shopifyOrderId);
    res.json({ success: true, message: 'Order marked as paid', data });
  } catch (err) {
    next(err);
  }
}

async function markFulfilled(req, res, next) {
  try {
    const data = await orderStatusService.markOrderFulfilled(req.params.shopifyOrderId);
    res.json({ success: true, message: 'Order marked as fulfilled', data });
  } catch (err) {
    next(err);
  }
}

module.exports = { listOrders, markPaid, markFulfilled };
