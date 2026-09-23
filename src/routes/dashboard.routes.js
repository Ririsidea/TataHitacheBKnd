const express = require('express');
const controller = require('../controllers/dashboard.controller');

const router = express.Router();

router.get('/events', controller.getEvents);
router.get('/orders', controller.getOrders);
router.get('/products', controller.getProducts);

module.exports = router;
