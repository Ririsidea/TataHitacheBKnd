
import express from 'express';
import * as controller from '../controllers/dashboard.controller';
import requireApiKeyOrJwt from '../middleware/requireApiKeyOrJwt';

const router = express.Router();

// Existing API-key clients and signed-in JWT employees are both supported.
router.get('/orders', requireApiKeyOrJwt, controller.getOrders);

// The same dual authentication applies to the live order-status feed.
router.get('/order-events', requireApiKeyOrJwt, controller.streamOrderEvents);

export default router;
