import express from 'express';
import * as controller from '../controllers/dashboard.controller';
import authenticate from '../middleware/authenticate';
import { requireApiKey } from '../middleware/apiKeyAuth';

const router = express.Router();

// Live Events feed is an internal screen - still JWT.
router.get('/events', authenticate, controller.getEvents);
// The orders list uses the MAP API key (needs ?email=).
router.get('/orders', requireApiKey, controller.getOrders);
// Live order-status feed (Server-Sent Events) for the Orders and Order Management screens.
router.get('/order-events', requireApiKey, controller.streamOrderEvents);

export default router;
