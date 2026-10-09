// Order fields that only ever come from the RAW webhook payload (req.shopifyPayload), never from
// a live Shopify read. Verified empirically against this store's own orders: a REST or GraphQL
// read comes back with these fields redacted (absent, null, or - for GraphQL - an explicit
// "not approved to access the Customer object" error), because the app does not have Protected
// Customer Data access approved in the Shopify admin. The webhook body is not subject to that
// restriction.
//
// Nothing in this file may be called with a value from shopify.getOrder() or any other live API
// read - only webhook.controller.ts, from req.shopifyPayload, may call it. services/orderSync.ts
// carries every field that IS safe from either source; keeping the two apart structurally (not
// just by convention) is what guarantees a live-read mirror (the fulfillment webhooks' REST
// remirror, admin mark-paid/fulfilled, the reconciler) can never blank out a real address with a
// redacted one.
import type { ShopifyAddress, ShopifyOrder } from '../types/shopify';

function shippingAddressFields(address: ShopifyAddress | null | undefined): Record<string, unknown> {
  if (!address) return {};
  const name = address.name || [address.first_name, address.last_name].filter(Boolean).join(' ').trim();
  const fields: Record<string, unknown> = {
    shippingName: name || undefined,
    shippingAddress1: address.address1 ?? undefined,
    shippingAddress2: address.address2 ?? undefined,
    shippingCity: address.city ?? undefined,
    shippingState: address.province ?? undefined,
    shippingZip: address.zip ?? undefined,
    shippingCountry: address.country ?? undefined,
    shippingPhone: address.phone ?? undefined,
  };
  Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
  return fields;
}

function billingAddressFields(address: ShopifyAddress | null | undefined): Record<string, unknown> {
  if (!address) return {};
  const name = address.name || [address.first_name, address.last_name].filter(Boolean).join(' ').trim();
  const fields: Record<string, unknown> = {
    billingName: name || undefined,
    billingAddress1: address.address1 ?? undefined,
    billingAddress2: address.address2 ?? undefined,
    billingCity: address.city ?? undefined,
    billingState: address.province ?? undefined,
    billingZip: address.zip ?? undefined,
    billingCountry: address.country ?? undefined,
    billingPhone: address.phone ?? undefined,
  };
  Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
  return fields;
}

// Shopify's own order/customer email+phone - distinct from orders.email/phone, which are the
// EMPLOYEE's identity (set by create-order's note_attributes, never Shopify's customer object).
function customerContactFields(payload: ShopifyOrder): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    customerEmail: payload.customer?.email ?? payload.email ?? undefined,
    customerPhone: payload.customer?.phone ?? payload.phone ?? undefined,
  };
  Object.keys(fields).forEach((key) => fields[key] === undefined && delete fields[key]);
  return fields;
}

// Call this ONLY with req.shopifyPayload. Merge its result into orderFieldsFromShopify's output
// (see services/orderSync.service.ts) before writing to the orders table.
export function piiFieldsFromWebhookPayload(payload: ShopifyOrder): Record<string, unknown> {
  return {
    ...shippingAddressFields(payload.shipping_address),
    ...billingAddressFields(payload.billing_address),
    ...customerContactFields(payload),
  };
}
