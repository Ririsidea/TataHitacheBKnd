import express from 'express';
import { getHealth } from '../controllers/health.controller';

const router = express.Router();

router.get('/health', getHealth);

export default router;
