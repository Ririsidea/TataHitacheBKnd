
import express from 'express';
import * as controller from '../controllers/dashboard.controller';
import { requireApiKey } from '../middleware/apiKeyAuth';

const router = express.Router();

// Orders API uses API-key authentication.
router.get('/orders', requireApiKey, controller.getOrders);

// Live order-status feed uses API-key authentication.
router.get('/order-events', requireApiKey, controller.streamOrderEvents);

export default router;