const express = require('express');
const controller = require('../controllers/map.controller');

const router = express.Router();

router.get('/stock', controller.getStock);
router.get('/product/:id', controller.getProductDetail);
router.post('/create-order', controller.createOrder);
router.get('/order-status/:id', controller.getOrderStatus);
router.post('/orders/:id/cancel', controller.cancelOrder);

module.exports = router;
