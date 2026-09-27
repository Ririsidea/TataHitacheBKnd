import express from 'express';
import * as controller from '../controllers/auth.controller';
import authenticate from '../middleware/authenticate';

const router = express.Router();

router.post('/login', controller.login);
router.post('/reset-password', controller.resetPassword);
router.get('/me', authenticate, controller.me);

export default router;
