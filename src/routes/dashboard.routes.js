const express = require('express');
const controller = require('../controllers/dashboard.controller');
const authenticate = require('../middleware/authenticate');
const { requireApiKey } = require('../middleware/apiKeyAuth');

const router = express.Router();

// Live Events feed is an internal screen - still JWT.
router.get('/events', authenticate, controller.getEvents);
// Shopify-related lists use the MAP API key (orders needs ?employeeEmail=).
router.get('/orders', requireApiKey, controller.getOrders);
router.get('/products', requireApiKey, controller.getProducts);

module.exports = router;
