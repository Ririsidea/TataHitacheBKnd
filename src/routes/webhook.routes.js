const express = require('express');
const verifyShopifyWebhook = require('../middleware/verifyShopifyWebhook');
const controller = require('../controllers/webhook.controller');

const router = express.Router();

// express.raw keeps the body as an untouched Buffer so the HMAC check in
// verifyShopifyWebhook can hash exactly what Shopify signed.
const rawJson = express.raw({ type: 'application/json' });

router.post('/inventory-update', rawJson, verifyShopifyWebhook, controller.inventoryUpdate);
router.post('/products/create', rawJson, verifyShopifyWebhook, controller.productCreate);
router.post('/products/update', rawJson, verifyShopifyWebhook, controller.productUpdate);
router.post('/orders/create', rawJson, verifyShopifyWebhook, controller.orderCreate);
router.post('/orders/updated', rawJson, verifyShopifyWebhook, controller.orderUpdated);
// Same handler, same HMAC verification - this is the path the Shopify "Order update"
// webhook subscription points at (https://<public-host>/order-update).
router.post('/order-update', rawJson, verifyShopifyWebhook, controller.orderUpdated);
// orders/edited carries only the edit's deltas, so the handler re-fetches the order.
router.post('/orders/edited', rawJson, verifyShopifyWebhook, controller.orderEdited);
router.post('/orders/cancelled', rawJson, verifyShopifyWebhook, controller.orderCancelled);
router.post('/orders/paid', rawJson, verifyShopifyWebhook, controller.orderPaid);
router.post('/orders/fulfilled', rawJson, verifyShopifyWebhook, controller.orderFulfilled);
router.post('/fulfillments/create', rawJson, verifyShopifyWebhook, controller.fulfillmentCreate);
router.post('/fulfillments/update', rawJson, verifyShopifyWebhook, controller.fulfillmentUpdate);
router.post('/refunds/create', rawJson, verifyShopifyWebhook, controller.refundCreate);

module.exports = router;
