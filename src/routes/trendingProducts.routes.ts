import express from 'express';
import { getTrendingProductsController } from '../controllers/trendingProducts.controller';

const router = express.Router();

router.post('/trending-products', getTrendingProductsController);

export default router;
