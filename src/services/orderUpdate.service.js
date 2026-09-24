// PUT /api/map/orders/:id - update an existing Shopify order (item quantities, add/remove
// items, shipping address, phone, email, note) and mirror the result into MySQL.
//
// The dependencies are injected (createOrderUpdateService) so the flow and the inventory
// rules can be unit-tested against a fake Shopify without a database or network. The
// default export wires the real ones.
//
// Inventory contract (Shopify does the stock movement, this code never adjusts stock):
//   - increase / add  -> the order edit deducts stock when committed
//   - decrease / remove -> orderEditSetQuantity is always called with restock: true, so
//     Shopify hands the units back once; inventoryAdjustQuantities is NEVER called here
//   - an edit that fails before commit is discarded by Shopify - stock is unchanged
const { Order, OrderLineItem } = require('../models');
const shopify = require('./shopify/client');
const shopifyOrderEdit = require('./shopify/orderEdit');
const { syncLocalOrderFromShopify } = require('./orderSync.service');

const ADDRESS_FIELDS = ['address1', 'address2', 'city', 'province', 'zip', 'country', 'firstName', 'lastName', 'phone'];
const TOP_LEVEL_FIELDS = ['items', 'shippingAddress', 'phone', 'email', 'note'];
const MAX_ITEMS = 50;
const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{4,19}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const httpError = shopifyOrderEdit.httpError;

// ---------------------------------------------------------------------------
// 1. validation
// ---------------------------------------------------------------------------
function validateInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((k) => !TOP_LEVEL_FIELDS.includes(k));
  if (unknown.length) throw httpError(400, `Unknown field(s): ${unknown.join(', ')}`);

  const input = {};

  if (body.items !== undefined) {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw httpError(400, 'items must be a non-empty array');
    }
    if (body.items.length > MAX_ITEMS) throw httpError(400, `items may contain at most ${MAX_ITEMS} entries`);
    const seen = new Set();
    input.items = body.items.map((item, i) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw httpError(400, `items[${i}] must be an object`);
      }
      const extra = Object.keys(item).filter((k) => k !== 'sku' && k !== 'quantity');
      if (extra.length) throw httpError(400, `items[${i}] has unknown field(s): ${extra.join(', ')}`);
      const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
      if (!sku) throw httpError(400, `items[${i}].sku is required`);
      if (!Number.isInteger(item.quantity) || item.quantity < 0) {
        throw httpError(400, `items[${i}].quantity must be an integer >= 0`);
      }
      if (seen.has(sku)) throw httpError(400, `Duplicate SKU in items: ${sku}`);
      seen.add(sku);
      return { sku, quantity: item.quantity };
    });
  }

  if (body.shippingAddress !== undefined) {
    const addr = body.shippingAddress;
    if (!addr || typeof addr !== 'object' || Array.isArray(addr) || Object.keys(addr).length === 0) {
      throw httpError(400, 'shippingAddress must be a non-empty object');
    }
    const extra = Object.keys(addr).filter((k) => !ADDRESS_FIELDS.includes(k));
    if (extra.length) throw httpError(400, `shippingAddress has unknown field(s): ${extra.join(', ')}`);
    input.shippingAddress = {};
    for (const [key, value] of Object.entries(addr)) {
      if (typeof value !== 'string' || value.length > 255) {
        throw httpError(400, `shippingAddress.${key} must be a string of at most 255 characters`);
      }
      input.shippingAddress[key] = value.trim();
    }
  }

  if (body.phone !== undefined) {
    if (typeof body.phone !== 'string' || !PHONE_PATTERN.test(body.phone.trim())) {
      throw httpError(400, 'phone must be a valid phone number (digits, optional leading +)');
    }
    input.phone = body.phone.trim();
  }
  if (body.email !== undefined) {
    if (typeof body.email !== 'string' || body.email.length > 254 || !EMAIL_PATTERN.test(body.email.trim())) {
      throw httpError(400, 'email must be a valid email address');
    }
    input.email = body.email.trim();
  }
  if (body.note !== undefined) {
    if (typeof body.note !== 'string' || body.note.length > 5000) {
      throw httpError(400, 'note must be a string of at most 5000 characters');
    }
    input.note = body.note;
  }

  if (Object.keys(input).length === 0) {
    throw httpError(400, `At least one of ${TOP_LEVEL_FIELDS.join(', ')} is required`);
  }
  return input;
}

// ---------------------------------------------------------------------------
// 4. diff per SKU
// ---------------------------------------------------------------------------
function planItemChanges(items, liveLines) {
  return items.map(({ sku, quantity }) => {
    const lines = liveLines.filter((l) => l.sku === sku);
    if (lines.length > 1) {
      throw httpError(409, `SKU ${sku} is on more than one order line and cannot be edited automatically`);
    }
    const line = lines[0] || null;
    const from = line ? line.currentQuantity : 0;

    let action;
    if (quantity === from) action = 'unchanged';
    else if (from === 0) action = 'add';
    else if (quantity === 0) action = 'remove';
    else if (quantity > from) action = 'increase';
    else action = 'decrease';

    return { sku, from, to: quantity, action, line };
  });
}

function assertEditable(plan, liveLines) {
  for (const p of plan) {
    // Only unfulfilled units can be edited: a line with any fulfilled unit is off limits.
    if (p.line && p.action !== 'unchanged' && p.action !== 'add' && p.line.unfulfilledQuantity < p.line.currentQuantity) {
      throw httpError(409, `SKU ${p.sku} has already been fulfilled and can no longer be edited`);
    }
  }
  // An order with no items left is a cancellation, which has its own endpoint.
  const bySku = new Map(plan.map((p) => [p.sku, p]));
  let remaining = plan.filter((p) => !p.line && p.to > 0).length;
  for (const line of liveLines) {
    if (line.currentQuantity <= 0) continue;
    const p = bySku.get(line.sku);
    if ((p ? p.to : line.currentQuantity) > 0) remaining += 1;
  }
  if (remaining === 0) {
    throw httpError(409, 'An order must keep at least one item - cancel the order instead');
  }
}

// ---------------------------------------------------------------------------
// address merge (orderUpdate overwrites the whole shippingAddress)
// ---------------------------------------------------------------------------
function mergeShippingAddress(existing, changes) {
  const base = {};
  for (const key of ['firstName', 'lastName', 'company', 'address1', 'address2', 'city', 'province', 'provinceCode', 'zip', 'country', 'countryCode', 'phone']) {
    if (existing && existing[key] !== null && existing[key] !== undefined) base[key] = existing[key];
  }
  const merged = { ...base, ...changes };
  // A changed province/country name must not be contradicted by the old code.
  if (changes.province !== undefined) delete merged.provinceCode;
  if (changes.country !== undefined) delete merged.countryCode;
  return merged;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------
function createOrderUpdateService(deps) {
  const { OrderModel, OrderLineItemModel, shopifyApi, edit, syncOrder, log } = deps;

  // Any failure that is not already an HTTP-shaped error is a transport / Shopify-side
  // problem: log the detail, return a clean 502.
  async function viaShopify(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.statusCode) throw err;
      log.error('[order-update] Shopify call failed:', err.message);
      if (/access denied|required access|write_order_edits/i.test(err.message)) {
        throw httpError(502, 'Shopify app is missing the write_order_edits scope - add it to the custom app and reinstall/approve it');
      }
      throw httpError(502, 'Could not reach Shopify right now. Please try again.');
    }
  }

  async function loadOrderForUpdate(orderId) {
    const order = await OrderModel.findByPk(orderId);
    if (!order) throw httpError(404, 'Order not found');
    return order;
  }

  // Same atomic-claim pattern as cancel: exactly one caller can flip open -> updating.
  // A concurrent update (or a cancel, which itself only accepts status "open") sees 0
  // rows affected and is turned away before any Shopify call is made.
  async function claim(order) {
    const [claimed] = await OrderModel.update({ status: 'updating' }, { where: { id: order.id, status: 'open' } });
    if (claimed) return;
    const current = await OrderModel.findByPk(order.id);
    const status = current ? current.status : order.status;
    if (status === 'updating') throw httpError(409, 'Order is being modified, try again');
    throw httpError(409, `Order cannot be updated - current status is ${String(status).toUpperCase()}`);
  }

  async function applyItemEdit(order, plan, stockVariants) {
    const changes = plan.filter((p) => p.action !== 'unchanged');
    if (!changes.length) return false;

    const session = await edit.beginEdit(order.shopifyOrderId);
    const calcBySku = new Map(session.lineItems.filter((l) => l.sku).map((l) => [l.sku, l]));

    // Any failure below throws before commitEdit, so Shopify discards the session and
    // nothing (order, stock) has changed.
    for (const p of changes) {
      const calc = calcBySku.get(p.sku);
      if (p.action === 'add' && !calc) {
        const variant = stockVariants.find((v) => v.sku === p.sku);
        await edit.addVariant(session.id, variant.id, p.to);
      } else {
        if (!calc) throw httpError(409, `Line item for SKU ${p.sku} was not found in the edit session`);
        // Reductions and removals ask Shopify to restock; increases ignore the flag.
        await edit.setQuantity(session.id, calc.id, p.to, true);
      }
    }

    await edit.commitEdit(session.id, { notifyCustomer: false, staffNote: 'Updated via MAP API' });
    return true;
  }

  function buildDetailsInput(input, live) {
    const detail = {};
    if (input.phone !== undefined) detail.phone = input.phone;
    if (input.email !== undefined) detail.email = input.email;
    if (input.note !== undefined) detail.note = input.note;
    if (input.shippingAddress !== undefined) {
      detail.shippingAddress = mergeShippingAddress(live.shippingAddress, input.shippingAddress);
    }
    return detail;
  }

  async function toResponseData(orderId) {
    const order = await OrderModel.findByPk(orderId, { include: [{ model: OrderLineItemModel, as: 'lineItems' }] });
    return {
      id: order.id,
      shopifyOrderId: order.shopifyOrderId,
      status: order.status,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      totalPrice: order.totalPrice,
      trackingNumber: order.trackingNumber,
      trackingUrl: order.trackingUrl,
      carrier: order.carrier,
      lineItems: (order.lineItems || []).map((li) => ({
        id: li.id,
        sku: li.sku,
        title: li.title,
        quantity: li.quantity,
        price: li.price,
      })),
    };
  }

  // Returns { data, summary } on success, or { partial: true, ... } when the item edit
  // committed but the follow-up orderUpdate failed. Everything else throws.
  async function updateOrder({ orderId, body }) {
    const input = validateInput(body); // 1. 400
    const order = await loadOrderForUpdate(orderId); // 2. 404
    if (!order.shopifyOrderId) throw httpError(409, 'Order cannot be updated');
    await claim(order); // 2. 409 (not open / busy)

    try {
      // 3. live Shopify state
      const live = await viaShopify(() => edit.getOrderForEdit(order.shopifyOrderId));
      if (!live) throw httpError(409, 'Order was not found in Shopify');
      if (live.cancelledAt) throw httpError(409, 'Order cannot be updated - it is cancelled in Shopify');
      if (live.closedAt) throw httpError(409, 'Order cannot be updated - it is closed in Shopify');

      // 4. per-SKU diff
      const plan = input.items ? planItemChanges(input.items, live.lineItems) : [];
      if (input.items) assertEditable(plan, live.lineItems);

      // 5. stock check - increases and additions only, for the extra units only
      const needing = plan.filter((p) => p.action === 'increase' || p.action === 'add');
      let stockVariants = [];
      if (needing.length) {
        stockVariants = await viaShopify(() => shopifyApi.findVariantsBySku(needing.map((p) => p.sku)));
        const shortages = [];
        for (const p of needing) {
          const variant = stockVariants.find((v) => v.sku === p.sku);
          if (!variant) {
            shortages.push(`Unknown SKU: ${p.sku}`);
            continue;
          }
          const extra = p.to - p.from;
          const available = variant.inventoryQuantity ?? 0;
          if (extra > available) shortages.push(`${p.sku}: requested ${extra} more, only ${available} available`);
        }
        if (shortages.length) throw httpError(409, `Insufficient stock - ${shortages.join('; ')}`);
      }

      // 6. item edit (begin -> set/add -> commit)
      const itemsUpdated = await viaShopify(() => applyItemEdit(order, plan, stockVariants));

      // 7. address / phone / email / note - after the item edit
      const detail = buildDetailsInput(input, live);
      const hasDetails = Object.keys(detail).length > 0;
      let detailsUpdated = false;
      let detailsError = null;
      if (hasDetails) {
        try {
          await viaShopify(() => edit.updateOrderDetails(order.shopifyOrderId, detail));
          detailsUpdated = true;
        } catch (err) {
          if (!itemsUpdated) throw err;
          detailsError = err; // items are already committed: report a partial result (8)
          log.error('[order-update] PARTIAL - items committed but orderUpdate failed for', order.shopifyOrderId, err.message);
        }
      }

      // 9. re-fetch and mirror to MySQL (only if something actually changed in Shopify)
      if (itemsUpdated || detailsUpdated) {
        try {
          const fresh = await shopifyApi.getOrder(order.shopifyOrderId);
          await syncOrder(fresh);
        } catch (syncErr) {
          log.error('[order-update] CRITICAL - Shopify updated but local sync failed', order.shopifyOrderId, syncErr.message);
          throw httpError(502, 'The order was updated in Shopify but MAP could not refresh its copy - it will resync automatically via webhook');
        }
      }

      if (detailsError) {
        return {
          partial: true,
          itemsUpdated,
          addressUpdated: false,
          message: `Items were updated, but the address/contact details were not: ${detailsError.message}`,
          data: await toResponseData(order.id),
        };
      }

      const summary = {
        items: plan.map((p) => ({ sku: p.sku, action: p.action, from: p.from, to: p.to })),
        detailsUpdated: Object.keys(detail),
      };
      return { data: await toResponseData(order.id), summary };
    } finally {
      // Release the claim on every path (success paths already had status rewritten from
      // Shopify by the sync, so this is a no-op there).
      await OrderModel.update({ status: 'open' }, { where: { id: order.id, status: 'updating' } }).catch((err) =>
        log.error('[order-update] failed to release claim for order', order.id, err.message)
      );
    }
  }

  // GET /api/map/orders/:id - the live order as the Edit Order screen needs it: address,
  // contact, note and per-line unfulfilled quantity, read from Shopify (getOrderForEdit),
  // plus whether it can be edited at all and, if not, why. Read-only: changes nothing.
  async function getOrderDetail({ orderId }) {
    const order = await OrderModel.findByPk(orderId, { include: [{ model: OrderLineItemModel, as: 'lineItems' }] });
    if (!order) throw httpError(404, 'Order not found');
    if (!order.shopifyOrderId) throw httpError(409, 'Order has no Shopify order to read');

    const live = await viaShopify(() => edit.getOrderForEdit(order.shopifyOrderId));
    if (!live) throw httpError(409, 'Order was not found in Shopify');

    // Unit prices are not part of the edit query; they come from MAP's own copy of the lines.
    const priceBySku = new Map((order.lineItems || []).map((li) => [li.sku, li.price]));
    const lineItems = live.lineItems
      .filter((l) => l.currentQuantity > 0)
      .map((l) => {
        const fulfilled = l.unfulfilledQuantity < l.currentQuantity;
        return {
          sku: l.sku,
          title: l.title,
          price: priceBySku.has(l.sku) ? priceBySku.get(l.sku) : null,
          quantity: l.currentQuantity,
          unfulfilledQuantity: l.unfulfilledQuantity,
          locked: fulfilled,
          lockedReason: fulfilled ? 'Already fulfilled - cannot be changed' : null,
        };
      });

    let readOnlyReason = null;
    if (live.cancelledAt) readOnlyReason = 'Order is cancelled in Shopify';
    else if (live.closedAt) readOnlyReason = 'Order is closed in Shopify';
    else if (order.status === 'updating') readOnlyReason = 'Order is being modified, try again in a moment';
    else if (order.status !== 'open') readOnlyReason = `Order is ${String(order.status).toUpperCase()} and can no longer be edited`;

    return {
      id: order.id,
      shopifyOrderId: order.shopifyOrderId,
      status: order.status,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      totalPrice: order.totalPrice,
      editable: readOnlyReason === null,
      readOnlyReason,
      email: live.email || null,
      phone: live.phone || null,
      note: live.note || null,
      shippingAddress: live.shippingAddress || null,
      lineItems,
    };
  }

  return { updateOrder, getOrderDetail };
}

const service = createOrderUpdateService({
  OrderModel: Order,
  OrderLineItemModel: OrderLineItem,
  shopifyApi: shopify,
  edit: shopifyOrderEdit,
  syncOrder: syncLocalOrderFromShopify,
  log: console,
});

module.exports = {
  updateOrder: service.updateOrder,
  getOrderDetail: service.getOrderDetail,
  createOrderUpdateService,
  validateInput,
  planItemChanges,
  mergeShippingAddress,
};
