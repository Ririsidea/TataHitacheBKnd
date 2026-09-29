import express from 'express';
import * as controller from '../controllers/admin.controller';
import * as ordersController from '../controllers/adminOrders.controller';

const router = express.Router();

router.get('/employees', controller.listEmployees);
router.post('/employees', controller.addEmployee);
router.put('/employees/:id', controller.updateEmployee);
router.delete('/employees/:id', controller.deleteEmployee);

// Order Management: all orders, and the pending -> paid -> fulfilled status actions.
router.get('/orders', ordersController.listOrders);
router.post('/orders/:shopifyOrderId/mark-paid', ordersController.markPaid);
router.post('/orders/:shopifyOrderId/mark-fulfilled', ordersController.markFulfilled);

export default router;
