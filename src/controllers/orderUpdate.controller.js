const { updateOrder, getOrderDetail } = require('../services/orderUpdate.service');

// Thin controller: PUT /api/map/orders/:id (authenticated by x-api-key in the route).
// All the logic lives in orderUpdate.service.js.
async function updateMapOrder(req, res, next) {
  try {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Order id must be a positive integer' });
    }

    const result = await updateOrder({ orderId: id, body: req.body });

    if (result.partial) {
      return res.status(207).json({
        success: false,
        partial: true,
        itemsUpdated: result.itemsUpdated,
        addressUpdated: result.addressUpdated,
        message: result.message,
        data: result.data,
      });
    }

    res.json({ success: true, message: 'Order updated successfully', data: result.data, summary: result.summary });
  } catch (err) {
    next(err);
  }
}

// GET /api/map/orders/:id - live order detail for the Edit Order screen (read-only).
async function getMapOrder(req, res, next) {
  try {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Order id must be a positive integer' });
    }
    const data = await getOrderDetail({ orderId: id });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

module.exports = { updateMapOrder, getMapOrder };
