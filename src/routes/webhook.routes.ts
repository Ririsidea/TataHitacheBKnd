import express from 'express';
import verifyShopifyWebhook from '../middleware/verifyShopifyWebhook';
import * as controller from '../controllers/webhook.controller';

const router = express.Router();
const rawJson = express.raw({ type: 'application/json' });

router.post('/inventory-update', rawJson, verifyShopifyWebhook, controller.inventoryUpdate);
router.post('/orders/create', rawJson, verifyShopifyWebhook, controller.orderCreate);
router.post('/order-update', rawJson, verifyShopifyWebhook, controller.orderUpdated);
router.post('/orders/cancelled', rawJson, verifyShopifyWebhook, controller.orderCancelled);
router.post('/orders/paid', rawJson, verifyShopifyWebhook, controller.orderPaid);
router.post('/orders/fulfilled', rawJson, verifyShopifyWebhook, controller.orderFulfilled);
router.post('/fulfillments/create', rawJson, verifyShopifyWebhook, controller.fulfillmentCreate);
router.post('/fulfillments/update', rawJson, verifyShopifyWebhook, controller.fulfillmentUpdate);
export default router;
