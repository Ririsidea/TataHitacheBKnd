import type { NextFunction, Request, Response } from 'express';
import { WebhookLog } from '../models';
import { PAGE_SIZE, parsePageQuery, offsetOf, pageMeta } from '../utils/paginate';
import { parseOrderListQuery, listOrders } from '../services/orderList.service';
import * as orderEvents from '../services/orderEvents';

// Webhook log, newest first - one page of PAGE_SIZE (utils/paginate.ts).
export async function getEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parsePageQuery(req.query);
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { rows, count } = await WebhookLog.findAndCountAll({
      order: [
        ['receivedAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: PAGE_SIZE,
      offset: offsetOf(parsed.page),
    });
    res.json({ success: true, data: rows, meta: pageMeta({ page: parsed.page, total: count }) });
  } catch (err) {
    next(err);
  }
}

// One employee's orders, newest first, one page at a time. The list is always scoped to one
// employee by the required ?employeeEmail= parameter - the query itself filters, never
// "fetch everything and filter in the frontend". Optional: status, fromDate, toDate, page.
export async function getOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parseOrderListQuery(req.query, { employeeRequired: true });
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { data, meta } = await listOrders(parsed.params);
    res.json({ success: true, data, meta });
  } catch (err) {
    next(err);
  }
}

const HEARTBEAT_MS = 25000;

// Server-Sent Events: pushes an "order" event whenever an order's status changes, however it
// changed (admin action, cancel, Shopify webhook), so open screens update without a
// refresh. ?employeeEmail= limits the stream to that employee's orders (the Orders page);
// without it every order is streamed (the admin Order Management page).
// The comment-line heartbeat keeps proxies (ngrok, load balancers) from closing an idle stream.
export function streamOrderEvents(req: Request, res: Response): void {
  const employeeEmail = typeof req.query.employeeEmail === 'string' ? req.query.employeeEmail.trim().toLowerCase() : '';

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write('event: ready\ndata: {}\n\n');

  const unsubscribe = orderEvents.subscribe((event) => {
    if (employeeEmail && String(event.employeeEmail || '').toLowerCase() !== employeeEmail) return;
    res.write(`event: order\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
