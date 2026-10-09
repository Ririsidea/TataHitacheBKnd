import type { NextFunction, Request, Response } from 'express';
import { Order, OrderLineItem, User } from '../models';
import type { OrderCreationAttributes } from '../models/Order';
import * as shopify from '../services/shopify/client';
import { parseCatalogQuery, searchCatalog } from '../services/catalogSearch';
import { getCatalogIndex, lookupProduct } from '../services/catalog.service';
import {
  shopifyOrderStatusLabel,
  isOrderFulfilled,
  isShopifyOrderId,
  LOCKED_MESSAGE,
  SHOPIFY_ORDER_ID_MESSAGE,
} from '../utils/orderStatus';
import { httpError, errorMessage } from '../utils/errors';
import { validateIndianAddress, lookupPincode } from '../services/pincode.service';
import { readRenamed } from '../utils/fieldAliases';
import type { SkuVariantNode } from '../types/shopify';

const MAX_KEY_LENGTH = 100;

function storedShippingAddress(address: Record<string, unknown> | undefined): Partial<OrderCreationAttributes> {
  if (!address) return {};
  const text = (value: unknown): string | undefined => {
    if (value === null || value === undefined) return undefined;
    const valueText = String(value).trim();
    return valueText || undefined;
  };
  const firstName = text(address.first_name);
  const lastName = text(address.last_name);
  return {
    shippingName: text(address.name) || [firstName, lastName].filter(Boolean).join(' ') || undefined,
    shippingAddress1: text(address.address1),
    shippingAddress2: text(address.address2),
    shippingCity: text(address.city),
    shippingState: text(address.province),
    shippingZip: text(address.zip),
    shippingCountry: text(address.country),
    shippingPhone: text(address.phone),
  };
}

// Product list + search: one cursor page of variant rows, ?limit= (default 50) at a time
// (see services/catalogSearch.ts).
export async function getStock(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parseCatalogQuery(req.query);
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const index = await getCatalogIndex({ fresh: parsed.params.fresh });
    const { data, pageInfo } = searchCatalog(index, parsed.params);
    res.json({ success: true, data, pageInfo });
  } catch (err) {
    next(err);
  }
}

// Single product by product id, variant id, SKU or handle (see services/catalog.service.ts).
export async function getProductDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const key = String(req.params.key ?? '').trim();
    if (!key) {
      res.status(400).json({ success: false, message: 'A product id, variant id, SKU or handle is required' });
      return;
    }
    if (key.length > MAX_KEY_LENGTH) {
      res.status(400).json({ success: false, message: `The product key must be at most ${MAX_KEY_LENGTH} characters` });
      return;
    }
    const product = await lookupProduct(key);
    if (!product) {
      res.status(404).json({ success: false, message: `Product not found for '${key}'` });
      return;
    }
    res.json({ success: true, data: product });
  } catch (err) {
    next(err);
  }
}

// A PIN's state, district and the exact list of city names validate-address / create-order
// accept for it (see services/pincode.service.ts - the same list both places use).
export async function getPincode(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const pin = String(req.params.pin ?? '').trim();
    const result = lookupPincode(pin);
    if (result.error === 'INVALID_FORMAT') {
      res.status(400).json({ success: false, message: 'pin must be a 6-digit Indian PIN code' });
      return;
    }
    if (result.error === 'NOT_FOUND') {
      res.status(404).json({ success: false, message: `No PIN code found for '${pin}'` });
      return;
    }
    res.json({ success: true, data: result.info });
  } catch (err) {
    next(err);
  }
}

function inventoryLog(...args: unknown[]): void {
  console.log('[inventory]', ...args);
}

interface OrderItem {
  sku: string;
  quantity: number;
}

// All-or-nothing stock validation against live Shopify inventory, read as close to
// order submission as possible. This is the first of two guards against overselling -
// see the post-completion re-check below for the second (handles the race where two
// requests both pass this check before either one's deduction lands on Shopify).
function validateStock(items: OrderItem[], variants: SkuVariantNode[]): (SkuVariantNode | null)[] {
  const shortages: string[] = [];
  const resolved = items.map((item) => {
    const variant = variants.find((v) => v.sku === item.sku);
    if (!variant) {
      shortages.push(`Unknown SKU: ${item.sku}`);
      return null;
    }
    const available = variant.inventoryQuantity ?? 0;
    if (item.quantity > available) {
      shortages.push(`${item.sku}: requested ${item.quantity}, only ${available} available`);
    }
    return variant;
  });

  if (shortages.length) throw httpError(409, `Insufficient stock - ${shortages.join('; ')}`);

  return resolved;
}

// Safety net for the rare concurrent-order race: re-reads live inventory for every
// SKU in the order right after Shopify completes it. If any variant went negative -
// meaning this order's deduction landed on top of another one that already used up
// the remaining stock - the order is cancelled with restock so Shopify's inventory
// is handed back, and the caller sees a clear "conflict" error instead of a silently
// oversold order.
async function verifyNoNegativeStock(items: OrderItem[]): Promise<{ negative: SkuVariantNode[]; variants: SkuVariantNode[] }> {
  const skus = items.map((item) => item.sku);
  const variants = await shopify.findVariantsBySku(skus);
  const negative = variants.filter((v) => (v.inventoryQuantity ?? 0) < 0);
  return { negative, variants };
}

type ShippingAddressCheck = { error?: undefined } | { error: string; code: string };

// Validates the shipping address synchronously against the bundled Indian PIN dataset
// before stock is touched or anything is sent to Shopify.
function validateShippingAddress(shippingAddress: Record<string, unknown> | undefined): ShippingAddressCheck {
  const result = validateIndianAddress({
    country: shippingAddress?.country,
    state: shippingAddress?.province,
    city: shippingAddress?.city,
    pincode: shippingAddress?.zip,
  });
  return result.valid ? {} : { error: result.message, code: result.code };
}

export function validateAddress(req: Request, res: Response, next: NextFunction): void {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateIndianAddress({
      country: body.country,
      state: body.state,
      city: body.city,
      pincode: body.pincode,
    });
    if (!result.valid) {
      res.status(400).json({ success: false, code: result.code, message: result.message });
      return;
    }
    res.json({
      success: true,
      data: { valid: true, pincode: result.pincode, state: result.state, city: result.city },
    });
  } catch (err) {
    next(err);
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type OrderIdentity = { name: string; email: string; channel: string; error?: undefined } | { error: string };

// There is no logged-in user on this key-authenticated route, so the employee the order
// is placed for comes from the request body (name / email; the old employeeName /
// employeeEmail are still accepted as aliases). Returns { error } or the cleaned identity.
function parseOrderIdentity(req: Request, body: Record<string, unknown>): OrderIdentity {
  const rawName = readRenamed(req, body, 'name', 'body field');
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name || name.length > 255) return { error: 'name is required (max 255 characters)' };

  const rawEmail = readRenamed(req, body, 'email', 'body field');
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
  if (!email || email.length > 255 || !EMAIL_PATTERN.test(email)) {
    return { error: 'email is required and must be a valid email address' };
  }

  let channel = 'MAP';
  if (body.channel !== undefined && body.channel !== null) {
    channel = typeof body.channel === 'string' ? body.channel.trim() : '';
    if (!channel || channel.length > 50) return { error: 'channel must be a non-empty string of at most 50 characters' };
  }

  return { name, email, channel };
}

export async function createOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { items, shippingAddress } = body as { items?: unknown; shippingAddress?: Record<string, unknown> };
    const phone = body.phone as string | undefined;

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, message: 'At least one item is required' });
      return;
    }
    const orderItems = items as OrderItem[];
    if (orderItems.some((item) => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
      res.status(400).json({ success: false, message: 'Each item quantity must be a positive integer' });
      return;
    }

    const addressCheck = validateShippingAddress(shippingAddress);
    if (addressCheck.error !== undefined) {
      res.status(400).json({ success: false, code: addressCheck.code, message: addressCheck.error });
      return;
    }

    // The order is placed for the employee named in the request (name / email, plus
    // optional phone and channel) - this route is authenticated by the MAP API key, so
    // there is no logged-in user to read them from.
    const identity = parseOrderIdentity(req, body);
    if (identity.error !== undefined) {
      res.status(400).json({ success: false, message: identity.error });
      return;
    }
    const employee: { name: string; email: string; phone: string | undefined } = {
      name: identity.name,
      email: identity.email,
      phone: phone || undefined,
    };
    const { channel } = identity;

    const includeLineItems = [{ model: OrderLineItem, as: 'lineItems' }];

    // The mobile number is the one piece of employee detail we don't already have, so
    // it is saved back to the employee's profile (when one exists) and future checkouts
    // come pre-filled.
    const profile = await User.findOne({ where: { email: employee.email } });
    if (profile) {
      if (phone && phone !== profile.phone) {
        profile.phone = phone;
        await profile.save();
      }
      if (!employee.phone) employee.phone = profile.phone || undefined;
    }

    const skus = orderItems.map((item) => item.sku);
    const variants = await shopify.findVariantsBySku(skus);
    validateStock(orderItems, variants);
    inventoryLog('stock check passed for', orderItems.map((i) => `${i.sku}x${i.quantity}`).join(', '));

    // variant_id is what actually links a draft order line item to real Shopify
    // inventory - sku/title/price alone (the previous behaviour) create a "custom"
    // line item with no inventory linkage at all, so nothing was ever deducted.
    const lineItemsForShopify = orderItems.map((item) => {
      const variant = variants.find((v) => v.sku === item.sku) as SkuVariantNode;
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
        { name: 'channel', value: channel },
      ],
      tags: 'MAP',
      // The actual Shopify-side inventory deduction happens on completion, gated by
      // this behaviour - "bypass" (Shopify's default for draft orders) would silently
      // leave inventory untouched, which was the root cause of stock never updating.
      inventory_behaviour: 'decrement_obeying_policy',
    });
    inventoryLog('draft order created', draftOrder.id);

    let completedDraftOrder: { order_id: number | string };
    try {
      completedDraftOrder = await shopify.completeDraftOrder(draftOrder.id);
    } catch (completeErr) {
      // Completion failed (e.g. Shopify rejected it) - the draft never became a real
      // order, so no inventory was touched. Clean up the dangling draft and surface a
      // clear error rather than a generic 500.
      inventoryLog('draft order completion FAILED', draftOrder.id, errorMessage(completeErr));
      await shopify.deleteDraftOrder(draftOrder.id).catch((cleanupErr: unknown) => {
        console.error('[inventory] failed to delete dangling draft order', draftOrder.id, errorMessage(cleanupErr));
      });
      throw httpError(409, 'Could not complete the order - it may be out of stock. Please try again.');
    }

    const shopifyOrder = await shopify.getOrder(completedDraftOrder.order_id);
    inventoryLog('order completed', shopifyOrder.id, 'inventory deducted via Shopify');

    // Second guard: confirm the deduction that just happened didn't push any variant
    // below zero (only possible if a concurrent order landed in between our stock
    // check and this order's completion). If it did, reverse this order.
    const { negative } = await verifyNoNegativeStock(orderItems);
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
      await shopify.cancelOrder(shopifyOrder.id, { restock: false, reason: 'other' }).catch((cancelErr: unknown) => {
        console.error('[inventory] failed to cancel conflicting order', shopifyOrder.id, errorMessage(cancelErr));
      });
      await shopify
        .restockInventoryForOrder(
          orderItems.map((item) => ({
            inventoryItemId: (variants.find((v) => v.sku === item.sku) as SkuVariantNode).inventoryItem.id,
            quantity: item.quantity,
          }))
        )
        .then(() => inventoryLog('restocked inventory for rolled-back order', shopifyOrder.id))
        .catch((restockErr: unknown) => {
          console.error('[inventory] CRITICAL - failed to restock after rollback', shopifyOrder.id, errorMessage(restockErr));
        });
      throw httpError(
        409,
        'Another order used up the remaining stock at the same time. Your order was not placed - please try again.'
      );
    }

    const order = await Order.create({
      shopifyOrderId: String(shopifyOrder.id),
      name: employee.name,
      email: employee.email,
      phone: employee.phone,
      status: 'open',
      financialStatus: shopifyOrder.financial_status,
      fulfillmentStatus: shopifyOrder.fulfillment_status,
      totalPrice: shopifyOrder.total_price ? Number(shopifyOrder.total_price) : undefined,
      channel,
      // The create-order route receives the checkout address directly. Persist it now so
      // exports do not depend on a later Shopify webhook arriving with protected PII.
      ...storedShippingAddress(shippingAddress),
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

    const createdOrder = await Order.findByPk(order.id, { include: includeLineItems });

    res.status(201).json({ success: true, data: createdOrder });
  } catch (err) {
    next(err);
  }
}

// :shopifyOrderId is the Shopify order id (data.shopifyOrderId of Create Order). The order is
// looked up by shopify_order_id only - the internal orders.id is never accepted here.
export async function getOrderStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const shopifyOrderId = String(req.params.shopifyOrderId);
    if (!isShopifyOrderId(shopifyOrderId)) {
      res.status(400).json({ success: false, message: SHOPIFY_ORDER_ID_MESSAGE });
      return;
    }
    const order = await Order.findOne({ where: { shopifyOrderId } });
    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }
    res.json({
      success: true,
      data: {
        id: order.id,
        shopifyOrderId: order.shopifyOrderId,
        status: order.status,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        deliveryStatus: order.deliveryStatus,
        trackingNumber: order.trackingNumber,
        trackingUrl: order.trackingUrl,
        carrier: order.carrier,
      },
    });
  } catch (err) {
    next(err);
  }
}

// An order can be cancelled only while it is still OPEN (not fulfilled, cancelled,
// or closed). Status is re-verified here against live data - the frontend hiding the
// button is a convenience, not the guard. (Authenticated by the MAP API key; the key
// holder is trusted, so there is no per-employee ownership check.)
// :shopifyOrderId is the SHOPIFY order id (the id visible in Shopify Admin / the order's
// shopifyOrderId field), not the internal orders.id.
export async function cancelOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const shopifyOrderId = String(req.params.shopifyOrderId);
    if (!isShopifyOrderId(shopifyOrderId)) {
      res.status(400).json({ success: false, message: SHOPIFY_ORDER_ID_MESSAGE });
      return;
    }
    const order = await Order.findOne({
      where: { shopifyOrderId },
      include: [{ model: OrderLineItem, as: 'lineItems' }],
    });
    if (!order) {
      res.status(404).json({ success: false, message: 'Order not found' });
      return;
    }

    // A fulfilled order is final and locked. Refused before anything is claimed or sent to
    // Shopify, so the order is left exactly as it is.
    if (isOrderFulfilled(order)) {
      res.status(409).json({ success: false, locked: true, message: LOCKED_MESSAGE });
      return;
    }

    // Atomic local gate: only one request can flip this order from 'open' to
    // 'cancelled'. A duplicate cancel request (double click, retry, accidental
    // resend) sees 0 rows affected and is rejected here, before any Shopify call
    // or inventory restock happens - this is what makes cancellation idempotent
    // and guarantees inventory is never restored twice for the same order.
    const [claimed] = await Order.update({ status: 'cancelled' }, { where: { id: order.id, status: 'open' } });
    if (!claimed) {
      res.status(409).json({
        success: false,
        message: `Order cannot be cancelled - current status is ${order.status.toUpperCase()}`,
      });
      return;
    }

    if (!order.shopifyOrderId) {
      await Order.update({ status: 'open' }, { where: { id: order.id } });
      res.status(409).json({ success: false, message: 'Order cannot be cancelled' });
      return;
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
          closedAt: shopifyOrder.closed_at ? new Date(shopifyOrder.closed_at) : null,
        },
        { where: { id: order.id } }
      );
      res.status(409).json({ success: false, message: `Order cannot be cancelled - current status is ${label}` });
      return;
    }

    try {
      inventoryLog('cancelling order', order.shopifyOrderId, 'requested via API key');
      // restock: false - see the matching comment in the create-order rollback path
      // above. The explicit shopify.restockInventoryForOrder call below is the one
      // and only place inventory is handed back, so it can never be double-applied.
      await shopify.cancelOrder(order.shopifyOrderId, { restock: false, reason: 'customer' });
    } catch (shopifyErr) {
      // The cancel didn't actually happen in Shopify - release the local gate so a
      // legitimate retry isn't permanently blocked.
      await Order.update({ status: 'open' }, { where: { id: order.id } });
      console.error('[inventory] order cancel failed at Shopify', order.shopifyOrderId, errorMessage(shopifyErr));
      throw httpError(502, 'Could not cancel the order right now. Please try again.');
    }

    // Reuse the exact same restock mechanism as the order-creation concurrency
    // safety net (shopify.restockInventoryForOrder) - no duplicate inventory logic.
    // Only the quantities actually recorded against this order's own line items are
    // restored, and only once, since the gate above already guarantees this whole
    // handler runs at most one time per order.
    const lineItems = order.lineItems ?? [];
    const skus = lineItems.map((li) => li.sku).filter(Boolean);
    if (skus.length) {
      try {
        const variants = await shopify.findVariantsBySku(skus);
        const restockItems = lineItems
          .filter((li) => li.sku)
          .map((li) => {
            const variant = variants.find((v) => v.sku === li.sku);
            return variant ? { inventoryItemId: variant.inventoryItem.id, quantity: li.quantity as number } : null;
          })
          .filter((item): item is { inventoryItemId: string; quantity: number } => item !== null);
        await shopify.restockInventoryForOrder(restockItems);
        inventoryLog('restocked', restockItems.length, 'line item(s) for cancelled order', order.shopifyOrderId);
      } catch (restockErr) {
        // The order IS cancelled at this point (correct) - inventory just couldn't
        // be handed back automatically. Logged loudly for manual reconciliation
        // rather than silently losing stock.
        console.error('[inventory] CRITICAL - order cancelled but restock failed', order.shopifyOrderId, errorMessage(restockErr));
      }
    }

    const updated = await Order.findByPk(order.id, { include: [{ model: OrderLineItem, as: 'lineItems' }] });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
}
