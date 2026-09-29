import express from 'express';
import * as controller from '../controllers/map.controller';
import { requireApiKey } from '../middleware/apiKeyAuth';

const router = express.Router();

// Every Shopify-related MAP route is authenticated with the static MAP API key
// (x-api-key). There is no logged-in user on these routes: the caller identifies the
// employee in the request itself (create-order body / dashboard query), and the key
// holder is trusted for everything else.
router.get('/stock', requireApiKey, controller.getStock);
router.get('/product/:key', requireApiKey, controller.getProductDetail);
router.get('/pincode/:pin', requireApiKey, controller.getPincode);
router.post('/validate-address', requireApiKey, controller.validateAddress);
router.post('/create-order', requireApiKey, controller.createOrder);
// Both take the Shopify order id (data.shopifyOrderId), never the internal orders.id.
router.get('/order-status/:shopifyOrderId', requireApiKey, controller.getOrderStatus);
router.post('/orders/:shopifyOrderId/cancel', requireApiKey, controller.cancelOrder);

export default router;
