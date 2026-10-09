import path from 'path';
import fs from 'fs';
import { Op } from 'sequelize';
import ExcelJS from 'exceljs';
import type { NextFunction, Request, Response } from 'express';
import { DailyExport } from '../models';
import type { DailyExportInstance } from '../models/DailyExport';
import { dailyExportDir, generateDailyExport } from '../services/orderExport.service';
import { parseCursorQuery, parseDayRange, pageInfo } from '../utils/paginate';
import { httpError, errorMessage } from '../utils/errors';

export async function exportDailyOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const email = req.user?.email;
    if (!email) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }
    const { fileName, count } = await generateDailyExport(email);
    res.json({
      success: true,
      message: `Exported ${count} order(s) for your account`,
      file: fileName,
      downloadUrl: `/exports/${fileName}`,
    });
  } catch (err) {
    next(err);
  }
}

async function findOwnedDailyExport(req: Request): Promise<DailyExportInstance> {
  const record = await DailyExport.findByPk(String(req.params.id));
  if (!record) throw httpError(404, 'Export not found');
  // Ownership check - an export id is never trusted on its own, exactly like the
  // order ownership checks in map.controller.ts.
  // Someone else's export is answered exactly like a missing one (no 403 in the client contract, and
  // it does not reveal that the id exists).
  if (record.email !== req.user?.email) throw httpError(404, 'Export not found');
  return record;
}

// The signed-in employee's daily exports, newest first, one cursor page at a time.
// Optional: from / to (YYYY-MM-DD, inclusive, on the export date), limit, after, before.
export async function listDailyExports(req: Request, res: Response, next: NextFunction): Promise<void> {
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

    const where: Record<string, unknown> = { email: req.user?.email };
    if (range.from || range.to) {
      const exportDate: Record<symbol, string> = {};
      if (range.from) exportDate[Op.gte] = range.from;
      if (range.to) exportDate[Op.lte] = range.to;
      where.exportDate = exportDate;
    }

    const { rows, count } = await DailyExport.findAndCountAll({
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

export async function viewDailyExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const record = await findOwnedDailyExport(req);
    const filePath = path.join(dailyExportDir(), record.fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: 'Export file is no longer available' });
      return;
    }

    // Exports written before the .xlsx switch are still .csv on disk - both must stay viewable.
    const workbook = new ExcelJS.Workbook();
    const worksheet = record.fileName.toLowerCase().endsWith('.xlsx')
      ? (await workbook.xlsx.readFile(filePath)).worksheets[0]
      : await workbook.csv.readFile(filePath);
    let columns: unknown[] = [];
    const rows: unknown[][] = [];
    worksheet?.eachRow((row, rowNumber) => {
      // ExcelJS row.values is 1-indexed with an empty slot at index 0.
      const values = (row.values as unknown[]).slice(1);
      if (rowNumber === 1) {
        columns = values;
      } else {
        rows.push(values);
      }
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

export async function downloadDailyExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const record = await findOwnedDailyExport(req);
    const filePath = path.join(dailyExportDir(), record.fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: 'Export file is no longer available' });
      return;
    }
    res.download(filePath, record.fileName);
  } catch (err) {
    next(err);
  }
}

export async function deleteDailyExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const record = await findOwnedDailyExport(req);
    const filePath = path.join(dailyExportDir(), record.fileName);
    await fs.promises.unlink(filePath).catch((unlinkErr: NodeJS.ErrnoException) => {
      if (unlinkErr.code !== 'ENOENT') {
        console.error('[daily-export] failed to remove file', filePath, errorMessage(unlinkErr));
      }
    });
    await record.destroy();
    res.json({ success: true, message: 'Export deleted successfully' });
  } catch (err) {
    next(err);
  }
}
