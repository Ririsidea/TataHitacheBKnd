const { Order, OrderLineItem } = require('../models');
const { isOrderUpdatable } = require('../utils/orderStatus');

const PHONE_PATTERN = /^[0-9]{10}$/;

// Fields that may be changed through PUT /api/orders/:id. These are all existing
// columns on `orders`; status/financial/fulfillment/total stay Shopify-owned and are
// only ever changed by the Shopify webhooks (or the cancel endpoint).
const CLEARABLE_TEXT_FIELDS = { trackingNumber: 255, carrier: 255 };
const UPDATABLE_FIELDS = ['employeePhone', 'trackingNumber', 'trackingUrl', 'carrier'];

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Returns { changes } on success or { errors: [...] } describing every problem.
function validateUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object'] };
  }

  const unknown = Object.keys(body).filter((key) => !UPDATABLE_FIELDS.includes(key));
  if (unknown.length) {
    return { errors: [`Unknown or non-updatable field(s): ${unknown.join(', ')}`] };
  }

  const provided = UPDATABLE_FIELDS.filter((key) => body[key] !== undefined);
  if (provided.length === 0) {
    return { errors: [`At least one of ${UPDATABLE_FIELDS.join(', ')} is required`] };
  }

  const errors = [];
  const changes = {};

  for (const key of provided) {
    const raw = body[key];

    if (key === 'employeePhone') {
      const phone = typeof raw === 'string' ? raw.trim() : raw;
      if (typeof phone !== 'string' || !PHONE_PATTERN.test(phone)) {
        errors.push('employeePhone must be a 10-digit mobile number');
      } else {
        changes.employeePhone = phone;
      }
      continue;
    }

    // Tracking fields: null or an empty string clears the value.
    if (raw !== null && typeof raw !== 'string') {
      errors.push(`${key} must be a string or null`);
      continue;
    }
    const value = raw === null ? '' : raw.trim();
    if (value === '') {
      changes[key] = null;
      continue;
    }

    if (key === 'trackingUrl') {
      if (value.length > 1000) errors.push('trackingUrl must be at most 1000 characters');
      else if (!isHttpUrl(value)) errors.push('trackingUrl must be a valid http(s) URL');
      else changes[key] = value;
    } else if (value.length > CLEARABLE_TEXT_FIELDS[key]) {
      errors.push(`${key} must be at most ${CLEARABLE_TEXT_FIELDS[key]} characters`);
    } else {
      changes[key] = value;
    }
  }

  return errors.length ? { errors } : { changes };
}

// PUT /api/orders/:id - authenticated by x-api-key in the route; the key holder may
// change every field below on any order.
// :id is the MAP order id (orders.id), the same id used by /api/map/order-status/:id.
async function updateOrder(req, res, next) {
  try {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Order id must be a positive integer' });
    }

    const { changes, errors } = validateUpdate(req.body);
    if (errors) {
      return res.status(400).json({ success: false, message: errors.join('; ') });
    }

    const order = await Order.findByPk(id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (!isOrderUpdatable(order)) {
      return res.status(409).json({
        success: false,
        message: `Order cannot be updated - current status is ${order.status.toUpperCase()}`,
      });
    }

    await order.update(changes);

    const updated = await Order.findByPk(order.id, {
      include: [{ model: OrderLineItem, as: 'lineItems' }],
    });
    res.json({ success: true, message: 'Order updated successfully', data: updated });
  } catch (err) {
    next(err);
  }
}

module.exports = { updateOrder };
