// Shopify Admin GraphQL calls behind the admin order-status actions (Mark as Paid /
// Mark as Fulfilled).
//   orderMarkAsPaid  https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderMarkAsPaid
//                    (write_orders) - records a manual payment for an order with a pending payment
//   fulfillmentCreate https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
//                    (write_merchant_managed_fulfillment_orders, or write_assigned_fulfillment_orders
//                    for app/third-party locations) - fulfils the order's open fulfillment orders
const { graphqlRequest } = require('./client');
const { httpError, toOrderGid } = require('./orderEdit');

function assertNoUserErrors(userErrors, what) {
  if (userErrors && userErrors.length) {
    throw httpError(409, `Shopify rejected ${what}: ${userErrors.map((e) => e.message).join('; ')}`);
  }
}

const MARK_AS_PAID = `
  mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order { id displayFinancialStatus }
      userErrors { field message }
    }
  }
`;

async function markOrderAsPaid(shopifyOrderId) {
  const data = await graphqlRequest(MARK_AS_PAID, { input: { id: toOrderGid(shopifyOrderId) } });
  assertNoUserErrors(data.orderMarkAsPaid.userErrors, 'marking the order as paid');
  return data.orderMarkAsPaid.order;
}

const FULFILLMENT_ORDERS = `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 50) { nodes { id status } }
    }
  }
`;

const FULFILLMENT_CREATE = `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`;

// Only these can still be fulfilled; CLOSED / CANCELLED ones are already done or void.
const FULFILLABLE_STATUSES = ['OPEN', 'IN_PROGRESS'];

// Fulfils every open fulfillment order of the order in one fulfillment. notifyCustomer is
// off: the MAP API never emails customers (same rule as the order edit flow).
async function fulfillOrder(shopifyOrderId) {
  const data = await graphqlRequest(FULFILLMENT_ORDERS, { id: toOrderGid(shopifyOrderId) });
  if (!data.order) throw httpError(409, 'Order was not found in Shopify');

  const fulfillmentOrders = data.order.fulfillmentOrders.nodes;
  const fulfillable = fulfillmentOrders.filter((fo) => FULFILLABLE_STATUSES.includes(fo.status));
  if (!fulfillable.length) {
    const onHold = fulfillmentOrders.some((fo) => fo.status === 'ON_HOLD');
    throw httpError(
      409,
      onHold
        ? 'Order cannot be fulfilled - its fulfillment is on hold in Shopify'
        : 'Order has nothing left to fulfil in Shopify'
    );
  }

  const result = await graphqlRequest(FULFILLMENT_CREATE, {
    fulfillment: {
      notifyCustomer: false,
      lineItemsByFulfillmentOrder: fulfillable.map((fo) => ({ fulfillmentOrderId: fo.id })),
    },
  });
  assertNoUserErrors(result.fulfillmentCreate.userErrors, 'the fulfillment');
  return result.fulfillmentCreate.fulfillment;
}

module.exports = { markOrderAsPaid, fulfillOrder };
