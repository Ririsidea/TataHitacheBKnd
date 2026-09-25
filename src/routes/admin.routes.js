const express = require('express');
const controller = require('../controllers/admin.controller');
const ordersController = require('../controllers/adminOrders.controller');

const router = express.Router();

router.get('/employees', controller.listEmployees);
router.post('/employees', controller.addEmployee);
router.delete('/employees/:id', controller.deleteEmployee);

// Order Management: all orders, and the pending -> paid -> fulfilled status actions.
router.get('/orders', ordersController.listOrders);
router.post('/orders/:shopifyOrderId/mark-paid', ordersController.markPaid);
router.post('/orders/:shopifyOrderId/mark-fulfilled', ordersController.markFulfilled);

module.exports = router;
