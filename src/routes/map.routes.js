const express = require('express');
const controller = require('../controllers/map.controller');
const orderUpdateController = require('../controllers/orderUpdate.controller');
const { requireApiKey } = require('../middleware/apiKeyAuth');

const router = express.Router();

// Every Shopify-related MAP route is authenticated with the static MAP API key
// (x-api-key). There is no logged-in user on these routes: the caller identifies the
// employee in the request itself (create-order body / dashboard query), and the key
// holder is trusted for everything else.
router.get('/stock', requireApiKey, controller.getStock);
router.get('/product/:id', requireApiKey, controller.getProductDetail);
router.post('/create-order', requireApiKey, controller.createOrder);
router.get('/order-status/:id', requireApiKey, controller.getOrderStatus);
router.post('/orders/:id/cancel', requireApiKey, controller.cancelOrder);
// Live order detail (address, contact, per-line unfulfilled quantity) for the Edit Order screen.
router.get('/orders/:id', requireApiKey, orderUpdateController.getMapOrder);
// Update an existing Shopify order (items / address / phone / email / note).
router.put('/orders/:id', requireApiKey, orderUpdateController.updateMapOrder);

module.exports = router;
