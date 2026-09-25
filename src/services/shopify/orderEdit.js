// Shopify Admin GraphQL helpers for editing an existing order (Order Editing API +
// orderUpdate). Verified against the Shopify Admin GraphQL docs:
//   orderEditBegin / orderEditSetQuantity / orderEditAddVariant / orderEditCommit
//   https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/edit-orders
//   orderUpdate (shippingAddress, email, phone, note, tags, customAttributes, ...)
//   https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderUpdate
// Required scopes: write_order_edits (edit flow) + write_orders (orderUpdate);
// read_all_orders to touch orders older than 60 days.
const { graphqlRequest } = require('./client');

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const toOrderGid = (shopifyOrderId) => `gid://shopify/Order/${shopifyOrderId}`;

// Every mutation returns userErrors; a non-empty list means Shopify rejected the
// operation, so it must stop the flow (and, before commit, discards the edit).
function assertNoUserErrors(userErrors, what) {
  if (userErrors && userErrors.length) {
    throw httpError(409, `Shopify rejected ${what}: ${userErrors.map((e) => e.message).join('; ')}`);
  }
}

const ORDER_FOR_EDIT_QUERY = `
  query OrderForEdit($id: ID!) {
    order(id: $id) {
      id
      cancelledAt
      closedAt
      displayFulfillmentStatus
      email
      phone
      note
      tags
      customAttributes { key value }
      shippingAddress {
        firstName lastName company address1 address2 city province provinceCode
        zip country countryCode phone
      }
      lineItems(first: 250) {
        edges {
          node {
            id sku title quantity currentQuantity unfulfilledQuantity
            variant { id }
          }
        }
      }
    }
  }
`;

// Live order, as it stands in Shopify right now. currentQuantity excludes refunded and
// removed units; unfulfilledQuantity is what an order edit is still allowed to change
// (LineItem.fulfillableQuantity is deprecated, so it is deliberately not used).
async function getOrderForEdit(shopifyOrderId) {
  const data = await graphqlRequest(ORDER_FOR_EDIT_QUERY, { id: toOrderGid(shopifyOrderId) });
  const order = data.order;
  if (!order) return null;
  return {
    id: order.id,
    cancelledAt: order.cancelledAt,
    closedAt: order.closedAt,
    fulfillmentStatus: order.displayFulfillmentStatus,
    email: order.email,
    phone: order.phone,
    note: order.note,
    tags: order.tags || [],
    customAttributes: order.customAttributes || [],
    shippingAddress: order.shippingAddress,
    lineItems: order.lineItems.edges.map(({ node }) => ({
      id: node.id,
      sku: node.sku,
      title: node.title,
      quantity: node.quantity,
      currentQuantity: node.currentQuantity,
      unfulfilledQuantity: node.unfulfilledQuantity,
      variantId: node.variant ? node.variant.id : null,
    })),
  };
}

const ORDER_EDIT_BEGIN = `
  mutation OrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        lineItems(first: 250) {
          edges { node { id sku quantity editableQuantity variant { id } } }
        }
      }
      userErrors { field message }
    }
  }
`;

// Starts an edit session. The returned line item ids are CalculatedLineItem ids - the
// ones orderEditSetQuantity needs - not the order's own LineItem ids.
async function beginEdit(shopifyOrderId) {
  const data = await graphqlRequest(ORDER_EDIT_BEGIN, { id: toOrderGid(shopifyOrderId) });
  const payload = data.orderEditBegin;
  assertNoUserErrors(payload.userErrors, 'starting the order edit');
  const calculated = payload.calculatedOrder;
  return {
    id: calculated.id,
    lineItems: calculated.lineItems.edges.map(({ node }) => ({
      id: node.id,
      sku: node.sku,
      quantity: node.quantity,
      editableQuantity: node.editableQuantity,
      variantId: node.variant ? node.variant.id : null,
    })),
  };
}

const ORDER_EDIT_SET_QUANTITY = `
  mutation OrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!, $restock: Boolean) {
    orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: $restock) {
      calculatedLineItem { id quantity }
      userErrors { field message }
    }
  }
`;

// quantity 0 removes the line. restock defaults to true here because Shopify's own
// default is false, which would shrink the order without handing stock back.
async function setQuantity(calculatedOrderId, calculatedLineItemId, quantity, restock = true) {
  const data = await graphqlRequest(ORDER_EDIT_SET_QUANTITY, {
    id: calculatedOrderId,
    lineItemId: calculatedLineItemId,
    quantity,
    restock,
  });
  assertNoUserErrors(data.orderEditSetQuantity.userErrors, 'the quantity change');
  return data.orderEditSetQuantity.calculatedLineItem;
}

const ORDER_EDIT_ADD_VARIANT = `
  mutation OrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity) {
      calculatedLineItem { id quantity }
      userErrors { field message }
    }
  }
`;

async function addVariant(calculatedOrderId, variantId, quantity) {
  const data = await graphqlRequest(ORDER_EDIT_ADD_VARIANT, { id: calculatedOrderId, variantId, quantity });
  assertNoUserErrors(data.orderEditAddVariant.userErrors, 'adding the item');
  return data.orderEditAddVariant.calculatedLineItem;
}

const ORDER_EDIT_COMMIT = `
  mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order { id }
      userErrors { field message }
    }
  }
`;

async function commitEdit(calculatedOrderId, { notifyCustomer = false, staffNote } = {}) {
  const data = await graphqlRequest(ORDER_EDIT_COMMIT, { id: calculatedOrderId, notifyCustomer, staffNote });
  assertNoUserErrors(data.orderEditCommit.userErrors, 'committing the order edit');
  return data.orderEditCommit.order;
}

const ORDER_UPDATE = `
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

// input holds only the fields being changed (phone/email/note/shippingAddress).
// tags and customAttributes are never sent: orderUpdate overwrites them when present,
// and omitting them leaves the existing "MAP" tag / employee attributes untouched.
async function updateOrderDetails(shopifyOrderId, input) {
  const data = await graphqlRequest(ORDER_UPDATE, { input: { id: toOrderGid(shopifyOrderId), ...input } });
  assertNoUserErrors(data.orderUpdate.userErrors, 'the order details update');
  return data.orderUpdate.order;
}

module.exports = {
  httpError,
  toOrderGid,
  getOrderForEdit,
  beginEdit,
  setQuantity,
  addVariant,
  commitEdit,
  updateOrderDetails,
};
