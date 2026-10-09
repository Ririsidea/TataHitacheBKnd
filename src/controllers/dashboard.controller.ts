import type { NextFunction, Request, Response } from 'express';
import { WebhookLog } from '../models';
import { parseCursorQuery, pageInfo } from '../utils/paginate';
import { parseOrderListQuery, listOrders } from '../services/orderList.service';
import * as orderEvents from '../services/orderEvents';

// Webhook log, newest first - one cursor page at a time (utils/paginate.ts).
export async function getEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parseCursorQuery(req.query);
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { limit, offset } = parsed;
    const { rows, count } = await WebhookLog.findAndCountAll({
      order: [
        ['receivedAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset,
    });
    res.json({ success: true, data: rows, pageInfo: pageInfo({ limit, offset, total: count }) });
  } catch (err) {
    next(err);
  }
}

// One employee's orders, newest first, one cursor page at a time. The list is always scoped to
// one employee by the required ?email= parameter - the query itself filters, never "fetch
// everything and filter in the frontend". Optional: status, fromDate, toDate, limit, after, before.
export async function getOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // JWT callers are always scoped to the authenticated employee. The API-key path remains
    // available for existing internal callers that explicitly provide an employee email.
    const query = req.user ? { ...req.query, email: req.user.email } : req.query;
    const parsed = parseOrderListQuery(query, { employeeRequired: true });
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { data, pageInfo } = await listOrders(parsed.params);
    res.json({ success: true, data, pageInfo });
  } catch (err) {
    next(err);
  }
}

const HEARTBEAT_MS = 25000;

// Server-Sent Events: pushes an "order" event whenever an order's status changes, however it
// changed (admin action, cancel, Shopify webhook), so open screens update without a
// refresh. ?email= limits the stream to that employee's orders (the Orders page);
// without it every order is streamed (the admin Order Management page).
// The comment-line heartbeat keeps proxies (ngrok, load balancers) from closing an idle stream.
export function streamOrderEvents(req: Request, res: Response): void {
  const rawEmail = req.query.email;
  const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

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
    if (email && String(event.email || '').toLowerCase() !== email) return;
    res.write(`event: order\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
