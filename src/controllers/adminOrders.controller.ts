import type { NextFunction, Request, Response } from 'express';
import * as orderStatusService from '../services/orderStatus.service';
import { parseOrderListQuery, listOrders as listOrdersPage } from '../services/orderList.service';

// Admin order management (mounted under /api/admin, so authenticate + requireAdmin already ran).
// :shopifyOrderId is the Shopify order id, the same id the cancel endpoint takes.

// Every order, newest first, one page at a time. Optional: q (Shopify order id / employee name /
// email), employeeEmail, status, fromDate, toDate, page.
export async function listOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parseOrderListQuery(req.query, { allowSearch: true });
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { data, meta } = await listOrdersPage(parsed.params);
    res.json({ success: true, data, meta });
  } catch (err) {
    next(err);
  }
}

export async function markPaid(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await orderStatusService.markOrderPaid(req.params.shopifyOrderId);
    res.json({ success: true, message: 'Order marked as paid', data });
  } catch (err) {
    next(err);
  }
}

export async function markFulfilled(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await orderStatusService.markOrderFulfilled(req.params.shopifyOrderId);
    res.json({ success: true, message: 'Order marked as fulfilled', data });
  } catch (err) {
    next(err);
  }
}
