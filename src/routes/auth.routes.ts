import express from 'express';
import * as controller from '../controllers/auth.controller';
import authenticate from '../middleware/authenticate';
import loginRateLimit from '../middleware/loginRateLimit';

const router = express.Router();

router.post('/login', loginRateLimit, controller.login);
router.post('/reset-password', controller.resetPassword);
router.get('/me', authenticate, controller.me);

export default router;
