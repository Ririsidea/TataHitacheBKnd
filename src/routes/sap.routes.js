const express = require('express');
const controller = require('../controllers/sap.controller');

const router = express.Router();

router.post('/export-daily', controller.exportDailyOrders);

// Employee Orders page: one row per daily export (not per order).
router.get('/daily-exports', controller.listDailyExports);
router.get('/daily-exports/:id/view', controller.viewDailyExport);
router.get('/daily-exports/:id/download', controller.downloadDailyExport);
router.delete('/daily-exports/:id', controller.deleteDailyExport);

module.exports = router;
