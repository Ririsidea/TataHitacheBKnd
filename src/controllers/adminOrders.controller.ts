import type { NextFunction, Request, Response } from 'express';
import * as orderStatusService from '../services/orderStatus.service';
import { parseOrderListQuery, listOrders as listOrdersPage } from '../services/orderList.service';
import { warnDeprecatedNames } from '../utils/fieldAliases';

// Admin order management (mounted under /api/admin, so authenticate + requireAdmin already ran).
// :shopifyOrderId is the Shopify order id, the same id the cancel endpoint takes.

// Every order, newest first, one cursor page at a time. Optional: q (Shopify order id / employee
// name / email), email (alias: the old employeeEmail), status, fromDate, toDate, limit, after, before.
export async function listOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    warnDeprecatedNames(req, req.query, 'query parameter');
    const parsed = parseOrderListQuery(req.query, { allowSearch: true, allowLegacyEmailAlias: true });
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { data, pageInfo } = await listOrdersPage(parsed.params);
    res.json({ success: true, data, pageInfo });
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
