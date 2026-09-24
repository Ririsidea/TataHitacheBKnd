const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const ExcelJS = require('exceljs');
const { DailyExport } = require('../models');
const { dailyExportDir, generateDailyExport } = require('../services/orderExport.service');

const DAILY_EXPORT_PAGE_SIZE_DEFAULT = 10;
const DAILY_EXPORT_PAGE_SIZE_MAX = 50;

async function exportDailyOrders(req, res, next) {
  try {
    const { fileName, count } = await generateDailyExport(req.user.email);
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

async function findOwnedDailyExport(req) {
  const record = await DailyExport.findByPk(req.params.id);
  if (!record) {
    const err = new Error('Export not found');
    err.statusCode = 404;
    throw err;
  }
  // Ownership check - an export id is never trusted on its own, exactly like the
  // order ownership checks in map.controller.js.
  if (record.employeeEmail !== req.user.email) {
    const err = new Error('You are not authorized to access this export');
    err.statusCode = 403;
    throw err;
  }
  return record;
}

async function listDailyExports(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(
      Math.max(parseInt(req.query.pageSize, 10) || DAILY_EXPORT_PAGE_SIZE_DEFAULT, 1),
      DAILY_EXPORT_PAGE_SIZE_MAX
    );

    const where = { employeeEmail: req.user.email };
    if (req.query.from || req.query.to) {
      where.exportDate = {};
      if (req.query.from) where.exportDate[Op.gte] = req.query.from;
      if (req.query.to) where.exportDate[Op.lte] = req.query.to;
    }

    const { rows, count } = await DailyExport.findAndCountAll({
      where,
      order: [['exportDate', 'DESC']],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    res.json({
      success: true,
      data: {
        items: rows,
        page,
        pageSize,
        total: count,
        totalPages: Math.max(1, Math.ceil(count / pageSize)),
      },
    });
  } catch (err) {
    next(err);
  }
}

async function viewDailyExport(req, res, next) {
  try {
    const record = await findOwnedDailyExport(req);
    const filePath = path.join(dailyExportDir(), record.fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(410).json({ success: false, message: 'Export file is no longer available on disk' });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = await workbook.csv.readFile(filePath);
    let columns = [];
    const rows = [];
    worksheet.eachRow((row, rowNumber) => {
      // ExcelJS row.values is 1-indexed with an empty slot at index 0.
      const values = row.values.slice(1);
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

async function downloadDailyExport(req, res, next) {
  try {
    const record = await findOwnedDailyExport(req);
    const filePath = path.join(dailyExportDir(), record.fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(410).json({ success: false, message: 'Export file is no longer available on disk' });
    }
    res.download(filePath, record.fileName);
  } catch (err) {
    next(err);
  }
}

async function deleteDailyExport(req, res, next) {
  try {
    const record = await findOwnedDailyExport(req);
    const filePath = path.join(dailyExportDir(), record.fileName);
    await fs.promises.unlink(filePath).catch((unlinkErr) => {
      if (unlinkErr.code !== 'ENOENT') {
        console.error('[daily-export] failed to remove file', filePath, unlinkErr.message);
      }
    });
    await record.destroy();
    res.json({ success: true, message: 'Export deleted successfully' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  exportDailyOrders,
  listDailyExports,
  viewDailyExport,
  downloadDailyExport,
  deleteDailyExport,
};
