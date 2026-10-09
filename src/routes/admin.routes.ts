import express from 'express';
import * as controller from '../controllers/admin.controller';
import * as ordersController from '../controllers/adminOrders.controller';
import * as exportsController from '../controllers/adminExports.controller';

const router = express.Router();

router.get('/employees', controller.listEmployees);
router.post('/employees', controller.addEmployee);
router.put('/employees/:id', controller.updateEmployee);
router.delete('/employees/:id', controller.deleteEmployee);

// Order Management: all orders, and the pending -> paid -> fulfilled status actions.
router.get('/orders', ordersController.listOrders);
router.post('/orders/:shopifyOrderId/mark-paid', ordersController.markPaid);
router.post('/orders/:shopifyOrderId/mark-fulfilled', ordersController.markFulfilled);
// Today's orders, live from the DB (not a file).
router.get('/orders/today', exportsController.getTodayOrders);

// Historical all-employees daily export files (distinct from the per-employee
// /api/sap/daily-exports, which this does not touch). New consolidated files are not generated.
// Mounted under /api/admin, so authenticate + requireAdmin already
// ran (see app.ts) - an employee JWT here gets requireAdmin's 404, same as every other admin route.
router.get('/daily-exports', exportsController.listAdminDailyExports);
router.get('/daily-exports/:id', exportsController.getAdminDailyExport);
router.get('/daily-exports/:id/download', exportsController.downloadAdminDailyExport);

export default router;
