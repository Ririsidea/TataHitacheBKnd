import path from 'path';
import fs from 'fs';
import { Op } from 'sequelize';
import ExcelJS from 'exceljs';
import type { NextFunction, Request, Response } from 'express';
import { AdminDailyExport, Order, OrderLineItem } from '../models';
import { allOrdersExportDir, dayBounds, toDateOnly } from '../services/orderExport.service';
import { exportStatusLabel } from '../utils/orderStatus';
import { parseCursorQuery, parseDayRange, pageInfo } from '../utils/paginate';
import { httpError } from '../utils/errors';

// Admin, all-employees daily exports (mounted under /api/admin, so authenticate + requireAdmin
// already ran - see app.ts/admin.routes.ts). Distinct from /api/sap/daily-exports, which is each
// employee's own export history and is left untouched by this file.

// Every admin export, newest first, one cursor page at a time. Optional: from / to (YYYY-MM-DD,
// inclusive, on the export date), limit, after, before - same pagination contract as every other
// list in this app (utils/paginate.ts); there is no ?page= here either.
export async function listAdminDailyExports(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = parseCursorQuery(req.query, ['from', 'to']);
    if (parsed.error !== undefined) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { limit, offset } = parsed;
    const range = parseDayRange(req.query, 'from', 'to');
    if (range.error !== undefined) {
      res.status(400).json({ success: false, message: range.error });
      return;
    }

    const where: Record<string, unknown> = {};
    if (range.from || range.to) {
      const exportDate: Record<symbol, string> = {};
      if (range.from) exportDate[Op.gte] = range.from;
      if (range.to) exportDate[Op.lte] = range.to;
      where.exportDate = exportDate;
    }

    const { rows, count } = await AdminDailyExport.findAndCountAll({
      where,
      order: [
        ['exportDate', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
      offset,
    });

    res.json({
      success: true,
      data: rows,
      pageInfo: pageInfo({ limit, offset, total: count, filters: { from: range.from, to: range.to } }),
    });
  } catch (err) {
    next(err);
  }
}

async function loadRecord(req: Request): Promise<InstanceType<typeof AdminDailyExport>> {
  const record = await AdminDailyExport.findByPk(String(req.params.id));
  if (!record) throw httpError(404, 'Export not found');
  return record;
}

// Same inline-preview shape as GET /api/sap/daily-exports/:id/view, for the admin sheet.
export async function getAdminDailyExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const record = await loadRecord(req);
    const filePath = path.join(allOrdersExportDir(), record.fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: 'Export file is no longer available' });
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = (await workbook.xlsx.readFile(filePath)).worksheets[0];
    let columns: unknown[] = [];
    const rows: unknown[][] = [];
    worksheet?.eachRow((row, rowNumber) => {
      const values = (row.values as unknown[]).slice(1);
      if (rowNumber === 1) columns = values;
      else rows.push(values);
    });

    res.json({
      success: true,
      data: {
        id: record.id,
        exportDate: record.exportDate,
        orderCount: record.orderCount,
        fileName: record.fileName,
        columns,
        rows,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function downloadAdminDailyExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const record = await loadRecord(req);
    const filePath = path.join(allOrdersExportDir(), record.fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: 'Export file is no longer available' });
      return;
    }
    res.download(filePath, record.fileName);
  } catch (err) {
    next(err);
  }
}

// Today's orders, live from the DB (not a file) - rows, a count, and the total value, for an
// admin dashboard tile. "Today" uses the server's local calendar day, same caveat as the export
// cron (see orderExport.service.ts dayBounds's comment on IST vs server TZ).
export async function getTodayOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { start, end } = dayBounds(new Date());
    const orders = await Order.findAll({
      where: { createdAt: { [Op.gte]: start, [Op.lte]: end } },
      include: [{ model: OrderLineItem, as: 'lineItems' }],
      order: [['createdAt', 'DESC']],
    });

    const total = orders.reduce((sum, order) => sum + (Number(order.totalPrice) || 0), 0);
    res.json({
      success: true,
      data: {
        date: toDateOnly(start),
        count: orders.length,
        total: Math.round(total * 100) / 100,
        orders: orders.map((order) => ({ ...order.toJSON(), orderStatusLabel: exportStatusLabel(order) })),
      },
    });
  } catch (err) {
    next(err);
  }
}
