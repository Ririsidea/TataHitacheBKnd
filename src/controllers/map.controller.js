const { Order, OrderLineItem, User } = require('../models');
const shopify = require('../services/shopify');
const { mapShopifyProduct, mapProductDetail } = require('../utils/productMapper');
const { shopifyOrderStatusLabel } = require('../utils/orderStatus');

async function getStock(req, res, next) {
  try {
    const products = await shopify.listProductsCatalog();
    const data = products.map(mapShopifyProduct).filter(Boolean);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getProductDetail(req, res, next) {
  try {
    const gid = `gid://shopify/Product/${req.params.id}`;
    const product = await shopify.getProductDetail(gid);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    res.json({ success: true, data: mapProductDetail(product) });
  } catch (err) {
    next(err);
  }
}

function inventoryLog(...args) {
  console.log('[inventory]', ...args);
}

// All-or-nothing stock validation against live Shopify inventory, read as close to
// order submission as possible. This is the first of two guards against overselling -
// see the post-completion re-check below for the second (handles the race where two
// requests both pass this check before either one's deduction lands on Shopify).
function validateStock(items, variants) {
  const shortages = [];
  const resolved = items.map((item) => {
    const variant = variants.find((v) => v.sku === item.sku);
    if (!variant) {
      shortages.push(`Unknown SKU: ${item.sku}`);
      return null;
    }
    const available = variant.inventoryQuantity ?? 0;
    if (item.quantity > available) {
      shortages.push(
        `${item.sku}: requested ${item.quantity}, only ${available} available`
      );
    }
    return variant;
  });

  if (shortages.length) {
    const err = new Error(`Insufficient stock - ${shortages.join('; ')}`);
    err.statusCode = 409;
    throw err;
  }

  return resolved;
}

// Safety net for the rare concurrent-order race: re-reads live inventory for every
// SKU in the order right after Shopify completes it. If any variant went negative -
// meaning this order's deduction landed on top of another one that already used up
// the remaining stock - the order is cancelled with restock so Shopify's inventory
// is handed back, and the caller sees a clear "conflict" error instead of a silently
// oversold order.
async function verifyNoNegativeStock(items) {
  const skus = items.map((item) => item.sku);
  const variants = await shopify.findVariantsBySku(skus);
  const negative = variants.filter((v) => (v.inventoryQuantity ?? 0) < 0);
  return { negative, variants };
}

async function createOrder(req, res, next) {
  try {
    const { items, shippingAddress, phone } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one item is required' });
    }
    if (items.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
      return res.status(400).json({ success: false, message: 'Each item quantity must be a positive integer' });
    }

    // The order is always placed as the logged-in employee - there is no separate
    // "employee ID" field to trust from the client. The mobile number is the one
    // piece of employee detail we don't already have, so we ask for it here and
    // save it back to the profile so future checkouts come pre-filled.
    const employee = await User.findByPk(req.user.userId);
    if (!employee) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    if (phone && phone !== employee.phone) {
      employee.phone = phone;
      await employee.save();
    }

    const skus = items.map((item) => item.sku);
    const variants = await shopify.findVariantsBySku(skus);
    validateStock(items, variants);
    inventoryLog('stock check passed for', items.map((i) => `${i.sku}x${i.quantity}`).join(', '));

    // variant_id is what actually links a draft order line item to real Shopify
    // inventory - sku/title/price alone (the previous behaviour) create a "custom"
    // line item with no inventory linkage at all, so nothing was ever deducted.
    const lineItemsForShopify = items.map((item) => {
      const variant = variants.find((v) => v.sku === item.sku);
      return {
        variant_id: Number(shopify.extractNumericId(variant.id)),
        quantity: item.quantity,
      };
    });

    const draftOrder = await shopify.createDraftOrder({
      line_items: lineItemsForShopify,
      shipping_address: shippingAddress,
      email: employee.email,
      note: `Employee: ${employee.name} <${employee.email}>`,
      note_attributes: [
        { name: 'employeeName', value: employee.name || '' },
        { name: 'employeeEmail', value: employee.email },
        { name: 'employeePhone', value: employee.phone || '' },
      ],
      // The actual Shopify-side inventory deduction happens on completion, gated by
      // this behaviour - "bypass" (Shopify's default for draft orders) would silently
      // leave inventory untouched, which was the root cause of stock never updating.
      inventory_behaviour: 'decrement_obeying_policy',
    });
    inventoryLog('draft order created', draftOrder.id);

    let completedDraftOrder;
    try {
      completedDraftOrder = await shopify.completeDraftOrder(draftOrder.id);
    } catch (completeErr) {
      // Completion failed (e.g. Shopify rejected it) - the draft never became a real
      // order, so no inventory was touched. Clean up the dangling draft and surface a
      // clear error rather than a generic 500.
      inventoryLog('draft order completion FAILED', draftOrder.id, completeErr.message);
      await shopify.deleteDraftOrder(draftOrder.id).catch((cleanupErr) => {
        console.error('[inventory] failed to delete dangling draft order', draftOrder.id, cleanupErr.message);
      });
      const err = new Error('Could not complete the order - it may be out of stock. Please try again.');
      err.statusCode = 409;
      throw err;
    }

    const shopifyOrder = await shopify.getOrder(completedDraftOrder.order_id);
    inventoryLog('order completed', shopifyOrder.id, 'inventory deducted via Shopify');

    // Second guard: confirm the deduction that just happened didn't push any variant
    // below zero (only possible if a concurrent order landed in between our stock
    // check and this order's completion). If it did, reverse this order.
    const { negative } = await verifyNoNegativeStock(items);
    if (negative.length) {
      inventoryLog(
        'CONFLICT - order pushed inventory negative, rolling back',
        shopifyOrder.id,
        negative.map((v) => `${v.sku}=${v.inventoryQuantity}`).join(', ')
      );
      // Cancel marks the order voided in Shopify Admin. restock is explicitly false
      // here - Shopify's own restock-on-cancel proved inconsistent in testing
      // (sometimes a no-op, sometimes applying on its own), and combining it with
      // our own explicit restock below caused a double hand-back. The restock call
      // right after this is the single, deterministic source of the inventory
      // adjustment.
      await shopify.cancelOrder(shopifyOrder.id, { restock: false, reason: 'other' }).catch((cancelErr) => {
        console.error('[inventory] failed to cancel conflicting order', shopifyOrder.id, cancelErr.message);
      });
      await shopify
        .restockInventoryForOrder(
          items.map((item) => ({
            inventoryItemId: variants.find((v) => v.sku === item.sku).inventoryItem.id,
            quantity: item.quantity,
          }))
        )
        .then(() => inventoryLog('restocked inventory for rolled-back order', shopifyOrder.id))
        .catch((restockErr) => {
          console.error(
            '[inventory] CRITICAL - failed to restock after rollback',
            shopifyOrder.id,
            restockErr.message
          );
        });
      const err = new Error(
        'Another order used up the remaining stock at the same time. Your order was not placed - please try again.'
      );
      err.statusCode = 409;
      throw err;
    }

    const order = await Order.create({
      shopifyOrderId: String(shopifyOrder.id),
      employeeName: employee.name,
      employeeEmail: employee.email,
      employeePhone: employee.phone,
      status: 'open',
      financialStatus: shopifyOrder.financial_status,
      fulfillmentStatus: shopifyOrder.fulfillment_status,
      totalPrice: shopifyOrder.total_price ? Number(shopifyOrder.total_price) : undefined,
    });

    const orderLineItems = (shopifyOrder.line_items || []).map((li) => ({
      orderId: order.id,
      sku: li.sku,
      title: li.title,
      quantity: li.quantity,
      price: li.price ? Number(li.price) : undefined,
    }));
    if (orderLineItems.length) {
      await OrderLineItem.bulkCreate(orderLineItems);
    }

    const createdOrder = await Order.findByPk(order.id, {
      include: [{ model: OrderLineItem, as: 'lineItems' }],
    });

    res.status(201).json({ success: true, data: createdOrder });
  } catch (err) {
    next(err);
  }
}

async function getOrderStatus(req, res, next) {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    // Ownership check - an order id is never trusted on its own, it must
    // belong to whoever is asking.
    if (order.employeeEmail !== req.user.email) {
      return res.status(403).json({ success: false, message: 'You are not authorized to view this order' });
    }
    res.json({
      success: true,
      data: {
        id: order.id,
        shopifyOrderId: order.shopifyOrderId,
        status: order.status,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        trackingNumber: order.trackingNumber,
        trackingUrl: order.trackingUrl,
        carrier: order.carrier,
      },
    });
  } catch (err) {
    next(err);
  }
}

// A customer can cancel an order only while it is still OPEN (not fulfilled,
// cancelled, or closed). Ownership and status are both re-verified here against
// live data - the frontend hiding the button is a convenience, not the guard.
async function cancelOrder(req, res, next) {
  try {
    const order = await Order.findByPk(req.params.id, {
      include: [{ model: OrderLineItem, as: 'lineItems' }],
    });
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.employeeEmail !== req.user.email) {
      return res.status(403).json({ success: false, message: 'You are not authorized to cancel this order' });
    }

    // Atomic local gate: only one request can flip this order from 'open' to
    // 'cancelled'. A duplicate cancel request (double click, retry, accidental
    // resend) sees 0 rows affected and is rejected here, before any Shopify call
    // or inventory restock happens - this is what makes cancellation idempotent
    // and guarantees inventory is never restored twice for the same order.
    const [claimed] = await Order.update(
      { status: 'cancelled' },
      { where: { id: order.id, status: 'open' } }
    );
    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: `Order cannot be cancelled - current status is ${order.status.toUpperCase()}`,
      });
    }

    if (!order.shopifyOrderId) {
      await Order.update({ status: 'open' }, { where: { id: order.id } });
      return res.status(409).json({ success: false, message: 'Order cannot be cancelled' });
    }

    // Authoritative re-check against live Shopify status, not just the local
    // mirror - covers a webhook (e.g. fulfilment) that hasn't landed locally yet
    // even though the order is no longer actually open.
    const shopifyOrder = await shopify.getOrder(order.shopifyOrderId);
    const label = shopifyOrderStatusLabel(shopifyOrder);
    if (label !== 'OPEN') {
      await Order.update(
        {
          status: label.toLowerCase(),
          fulfillmentStatus: shopifyOrder.fulfillment_status,
          closedAt: shopifyOrder.closed_at || null,
        },
        { where: { id: order.id } }
      );
      return res.status(409).json({ success: false, message: `Order cannot be cancelled - current status is ${label}` });
    }

    try {
      inventoryLog('cancelling order', order.shopifyOrderId, 'requested by', req.user.email);
      // restock: false - see the matching comment in the create-order rollback path
      // above. The explicit shopify.restockInventoryForOrder call below is the one
      // and only place inventory is handed back, so it can never be double-applied.
      await shopify.cancelOrder(order.shopifyOrderId, { restock: false, reason: 'customer' });
    } catch (shopifyErr) {
      // The cancel didn't actually happen in Shopify - release the local gate so a
      // legitimate retry isn't permanently blocked.
      await Order.update({ status: 'open' }, { where: { id: order.id } });
      console.error('[inventory] order cancel failed at Shopify', order.shopifyOrderId, shopifyErr.message);
      const err = new Error('Could not cancel the order right now. Please try again.');
      err.statusCode = 502;
      throw err;
    }

    // Reuse the exact same restock mechanism as the order-creation concurrency
    // safety net (shopify.restockInventoryForOrder) - no duplicate inventory logic.
    // Only the quantities actually recorded against this order's own line items are
    // restored, and only once, since the gate above already guarantees this whole
    // handler runs at most one time per order.
    const skus = order.lineItems.map((li) => li.sku).filter(Boolean);
    if (skus.length) {
      try {
        const variants = await shopify.findVariantsBySku(skus);
        const restockItems = order.lineItems
          .filter((li) => li.sku)
          .map((li) => {
            const variant = variants.find((v) => v.sku === li.sku);
            return variant ? { inventoryItemId: variant.inventoryItem.id, quantity: li.quantity } : null;
          })
          .filter(Boolean);
        await shopify.restockInventoryForOrder(restockItems);
        inventoryLog('restocked', restockItems.length, 'line item(s) for cancelled order', order.shopifyOrderId);
      } catch (restockErr) {
        // The order IS cancelled at this point (correct) - inventory just couldn't
        // be handed back automatically. Logged loudly for manual reconciliation
        // rather than silently losing stock.
        console.error(
          '[inventory] CRITICAL - order cancelled but restock failed',
          order.shopifyOrderId,
          restockErr.message
        );
      }
    }

    const updated = await Order.findByPk(order.id, { include: [{ model: OrderLineItem, as: 'lineItems' }] });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStock, getProductDetail, createOrder, getOrderStatus, cancelOrder };
