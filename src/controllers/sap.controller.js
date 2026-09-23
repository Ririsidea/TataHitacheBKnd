const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const ExcelJS = require('exceljs');
const { Order, OrderLineItem, User, DailyExport } = require('../models');
const { sap } = require('../config/env');

// Per-employee daily export history (Section: Employee Orders page) lives in its
// own subfolder, separate from the legacy ad hoc / nightly-SAP files below - this
// keeps the two features' filenames from ever colliding, and keeps these files off
// the public, unauthenticated `/exports` static mount (see app.js). They are only
// ever served through the authenticated endpoints at the bottom of this file.
const DAILY_EXPORT_SUBDIR = 'daily';
const DAILY_EXPORT_PAGE_SIZE_DEFAULT = 10;
const DAILY_EXPORT_PAGE_SIZE_MAX = 50;

function dailyExportDir() {
  return path.resolve(sap.localDir, DAILY_EXPORT_SUBDIR);
}

// Shared by every export path below so a column can never drift between the
// legacy nightly/on-demand export and the new per-employee daily export.
function buildOrdersWorksheet(workbook, orders) {
  const worksheet = workbook.addWorksheet('Orders');
  worksheet.columns = [
    { header: 'Shopify Order ID', key: 'shopifyOrderId' },
    { header: 'Status', key: 'status' },
    { header: 'Financial Status', key: 'financialStatus' },
    { header: 'Fulfillment Status', key: 'fulfillmentStatus' },
    { header: 'Line Items', key: 'lineItems' },
    { header: 'Total Price', key: 'totalPrice' },
    { header: 'Tracking Number', key: 'trackingNumber' },
    { header: 'Carrier', key: 'carrier' },
    { header: 'Created At', key: 'createdAt' },
  ];

  orders.forEach((order) => {
    worksheet.addRow({
      shopifyOrderId: order.shopifyOrderId,
      status: order.status,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      lineItems: (order.lineItems || []).map((li) => `${li.sku} x${li.quantity}`).join('; '),
      totalPrice: order.totalPrice,
      trackingNumber: order.trackingNumber,
      carrier: order.carrier,
      createdAt: order.createdAt ? order.createdAt.toISOString() : '',
    });
  });

  return worksheet;
}

// With no employeeEmail, this is the full nightly SAP hand-off (all
// employees, today's orders only) - used by the 8 PM cron job. With an
// employeeEmail, it's an on-demand export for that one employee, scoped to
// their own orders only, across all dates (not just today's).
// Unchanged behaviour - only the worksheet-building step was factored out above.
async function generateDailyExport(employeeEmail) {
  const where = {};
  if (employeeEmail) {
    where.employeeEmail = employeeEmail;
  } else {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    where.createdAt = { [Op.gte]: startOfDay, [Op.lte]: endOfDay };
  }

  const orders = await Order.findAll({
    where,
    include: [{ model: OrderLineItem, as: 'lineItems' }],
    order: [['createdAt', 'DESC']],
    raw: false,
  });

  const workbook = new ExcelJS.Workbook();
  buildOrdersWorksheet(workbook, orders);

  const dir = path.resolve(sap.localDir);
  fs.mkdirSync(dir, { recursive: true });
  const datePart = new Date().toISOString().slice(0, 10);
  // Per-employee exports get their own file name (slug of their email) so they
  // never collide with each other or overwrite the cron job's full daily file.
  const employeeSlug = employeeEmail ? `-${employeeEmail.replace(/[^a-z0-9]+/gi, '-')}` : '';
  const fileName = `sap-orders${employeeSlug}-${datePart}.csv`;
  const filePath = path.join(dir, fileName);

  // Demo mode writes the CSV to a local folder. In production, swap this
  // for an SFTP/S3 upload based on SAP_EXPORT_MODE, e.g.:
  //   if (sap.exportMode === 'sftp') await sftpClient.put(filePath, remotePath);
  //   if (sap.exportMode === 's3') await s3.putObject({ Bucket, Key, Body: fs.createReadStream(filePath) }).promise();
  await workbook.csv.writeFile(filePath);

  return { filePath, fileName, count: orders.length };
}

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

// ---------------------------------------------------------------------------
// Employee Orders page: one export per employee per calendar day
// ---------------------------------------------------------------------------

function dayBounds(dateInput) {
  const start = typeof dateInput === 'string' ? new Date(`${dateInput}T00:00:00`) : new Date(dateInput);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// Deliberately NOT toISOString().slice(0, 10) - that round-trips through UTC and
// rolls back to the previous calendar day for any timezone ahead of UTC (e.g. IST)
// once the local time-of-day is early enough, which silently mislabels the file.
function toDateOnly(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Same shape as generateDailyExport, but scoped to one employee AND one explicit
// calendar day (rather than "today" or "all time") - this is what the midnight
// per-employee cron uses, and it reuses buildOrdersWorksheet so the columns are
// always identical to the existing exports.
async function generateEmployeeDailyExport(employeeEmail, dateInput) {
  const { start, end } = dayBounds(dateInput);
  const exportDate = toDateOnly(start);

  const orders = await Order.findAll({
    where: { employeeEmail, createdAt: { [Op.gte]: start, [Op.lte]: end } },
    include: [{ model: OrderLineItem, as: 'lineItems' }],
    order: [['createdAt', 'DESC']],
  });

  const workbook = new ExcelJS.Workbook();
  buildOrdersWorksheet(workbook, orders);

  const dir = dailyExportDir();
  fs.mkdirSync(dir, { recursive: true });
  const employeeSlug = String(employeeEmail).replace(/[^a-z0-9]+/gi, '-');
  const fileName = `daily-orders-${employeeSlug}-${exportDate}.csv`;
  const filePath = path.join(dir, fileName);
  await workbook.csv.writeFile(filePath);

  return { fileName, filePath, count: orders.length, exportDate };
}

// Runs once daily (see src/jobs/employeeDailyExportCron.js), separately from the
// existing 8 PM all-employees SAP hand-off cron, which is untouched. Loops every
// employee and, for each, generates one file for the given day - even if that
// employee had zero orders that day, so history stays complete. Skips (does not
// regenerate/overwrite) any (employee, day) pair that already has a record, so a
// re-run or a delayed restart can never duplicate or clobber a previous day's file.
async function runDailyEmployeeExports(dateInput) {
  const { start } = dayBounds(dateInput);
  const exportDate = toDateOnly(start);
  const employees = await User.findAll({ attributes: ['email'] });

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const { email } of employees) {
    try {
      const existing = await DailyExport.findOne({ where: { employeeEmail: email, exportDate } });
      if (existing) {
        skipped += 1;
        continue;
      }
      const { fileName, count } = await generateEmployeeDailyExport(email, dateInput);
      await DailyExport.create({ employeeEmail: email, exportDate, orderCount: count, fileName });
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(`[daily-export] failed for ${email} on ${exportDate}:`, err.message);
    }
  }

  return { exportDate, totalEmployees: employees.length, created, skipped, failed };
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
  generateDailyExport,
  generateEmployeeDailyExport,
  runDailyEmployeeExports,
  listDailyExports,
  viewDailyExport,
  downloadDailyExport,
  deleteDailyExport,
};
