import path from 'path';
import fs from 'fs';
import { Op } from 'sequelize';
import ExcelJS from 'exceljs';
import { Order, OrderLineItem, User, DailyExport } from '../models';
import type { OrderInstance } from '../models/Order';
import type { OrderLineItemInstance } from '../models/OrderLineItem';
import type { UserInstance } from '../models/User';
import { sap } from '../config/env';
import { errorMessage } from '../utils/errors';

// Export generation shared by the employeeDailyExportCron job (src/jobs), the per-employee HTTP
// handlers in controllers/sap.controller.ts, and the admin HTTP handlers in
// controllers/adminExports.controller.ts: builds the order worksheet, writes the .xlsx file, and
// records the export. No req/res handling lives here, and no Shopify API call happens here - every
// column is read straight off the `orders` / `order_line_items` rows (see services/orderDetails.ts
// for how the address columns get there, and services/orderBackfill.service.ts for orders that
// predate them).

const DAILY_EXPORT_SUBDIR = 'daily';
const ALL_ORDERS_SUBDIR = 'all';

export function dailyExportDir(): string {
  return path.resolve(sap.localDir, DAILY_EXPORT_SUBDIR);
}

export function allOrdersExportDir(): string {
  return path.resolve(sap.localDir, DAILY_EXPORT_SUBDIR, ALL_ORDERS_SUBDIR);
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// "DD-MM-YYYY HH:mm" in IST, computed from the parts directly (not from the server's own
// timezone) so this is correct no matter where the process runs.
function formatIST(value: Date | string | number | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(IST_PARTS.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}`;
}

// "YYYY-MM-DD" -> "DD-MM-YYYY". exportDate is already a plain calendar-day string (toDateOnly's
// output), so this is a pure string reshuffle - no timezone conversion needed or wanted here.
function formatDateOnly(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}-${month}-${year}`;
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const RUPEE_FORMAT = '"₹"#,##0.00';
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };

export type ExclusionReason = 'cancelled' | 'voided' | 'refunded';

export interface ExcludedOrderSummary {
  total: number;
  cancelled: number;
  voided: number;
  refunded: number;
}

// An order excluded from every sheet: cancelled, or Shopify marked its payment voided/refunded.
export function exclusionReason(order: OrderInstance): ExclusionReason | null {
  if (order.cancelledAt || String(order.status || '').toLowerCase() === 'cancelled') return 'cancelled';
  const financial = String(order.financialStatus || '').toLowerCase();
  if (financial === 'voided') return 'voided';
  if (financial === 'refunded') return 'refunded';
  return null;
}

export function isExcludedOrder(order: OrderInstance): boolean {
  return exclusionReason(order) !== null;
}

export function summarizeExcludedOrders(orders: OrderInstance[]): ExcludedOrderSummary {
  const summary: ExcludedOrderSummary = { total: 0, cancelled: 0, voided: 0, refunded: 0 };
  for (const order of orders) {
    const reason = exclusionReason(order);
    if (!reason) continue;
    summary.total += 1;
    summary[reason] += 1;
  }
  return summary;
}

// address1, address2, city, state, zip, country - comma-joined, empty parts skipped. A plain
// string value (not a number, no apostrophe hack): ExcelJS writes a JS string as a true string
// cell, so Excel never auto-detects it as numeric - ones like "442203" stay text on their own.
function addressCell(order: OrderInstance): string {
  return [order.shippingAddress1, order.shippingAddress2, order.shippingCity, order.shippingState, order.shippingZip, order.shippingCountry]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Worksheet columns - Id, Name, Email, Export Date, Product SKU, Product Name, Unit Price,
// Quantity, Total Price (line total, not the order's), Address, Created At, Updated At.
// ---------------------------------------------------------------------------

interface ColumnSpec {
  header: string;
  key: string;
  money?: boolean;
}

const COLUMNS: ColumnSpec[] = [
  { header: 'Id', key: 'id' },
  { header: 'Name', key: 'name' },
  { header: 'Email', key: 'email' },
  { header: 'Export Date', key: 'exportDate' },
  { header: 'Product SKU', key: 'sku' },
  { header: 'Product Name', key: 'productName' },
  { header: 'Unit Price', key: 'unitPrice', money: true },
  { header: 'Quantity', key: 'quantity' },
  { header: 'Total Price', key: 'totalPrice', money: true },
  { header: 'Address', key: 'address' },
  { header: 'Created At', key: 'createdAt' },
  { header: 'Updated At', key: 'updatedAt' },
];

// One employee lookup for a whole export (never one query per row). orders.email is the join
// key - it is the EMPLOYEE's email (set by create-order, distinct from orders.customerEmail,
// which is Shopify's own order/customer email and may differ for a storefront order).
async function buildUsersByEmail(emails: (string | null | undefined)[]): Promise<Map<string, UserInstance>> {
  const unique = [...new Set(emails.filter((e): e is string => Boolean(e)))];
  if (!unique.length) return new Map();
  const users = await User.findAll({
    where: { email: { [Op.in]: unique } },
    attributes: ['email', 'employeeId', 'ticketId', 'name', 'phone'],
  });
  return new Map(users.map((u) => [u.email, u]));
}

// One row per line item; Id/Name/Email/Export Date/Address/Created At/Updated At repeat on each
// of an order's rows. An order with no line items (should not normally happen, but a
// webhook-only row is possible) still gets exactly one row, with the product columns blank.
function orderRows(order: OrderInstance, usersByEmail: Map<string, UserInstance>, exportDateLabel: string): Record<string, unknown>[] {
  const lookup = order.email ? usersByEmail.get(order.email) : undefined;

  const base: Record<string, unknown> = {
    id: displayOrderNumber(order),
    name: order.name || lookup?.name || '',
    email: order.email || lookup?.email || '',
    exportDate: exportDateLabel,
    address: addressCell(order),
    createdAt: formatIST(order.createdAt),
    updatedAt: formatIST(order.updatedAt),
  };

  const lineItems: (OrderLineItemInstance | null)[] = order.lineItems?.length ? order.lineItems : [null];

  return lineItems.map((li) => {
    const quantity = li?.quantity ?? null;
    const unitPrice = li ? toNumberOrNull(li.price) : null;
    const totalPrice = quantity !== null && unitPrice !== null ? Math.round(quantity * unitPrice * 100) / 100 : null;
    return {
      ...base,
      sku: li?.sku || '',
      productName: li ? `${li.title || ''}${li.variantTitle ? ` - ${li.variantTitle}` : ''}` : '',
      unitPrice,
      quantity,
      totalPrice,
    };
  });
}

function displayOrderNumber(order: OrderInstance): string {
  const raw = String(order.orderNumber || order.shopifyOrderId || '').trim();
  if (!raw) return '';
  return `#${raw.replace(/^#+/, '')}`;
}

interface WorksheetStats {
  includedCount: number;
  excludedCount: number;
  totalQuantity: number;
  totalPrice: number;
}

// Shared by the on-demand and employee-wise daily export paths so columns cannot drift.
// Cancelled/voided/refunded
// orders are left out everywhere this is used (isExcludedOrder). Rows are ordered oldest-created
// first, then by Id, then in each order's own line-item order - regardless of how `orders` was
// queried. A trailing bold "Total" row sums Quantity and Total Price. A 0-order (or
// all-excluded) sheet still gets a correctly-shaped result: header + Total(0) rows, no error.
function buildOrdersWorksheet(
  workbook: ExcelJS.Workbook,
  orders: OrderInstance[],
  usersByEmail: Map<string, UserInstance>,
  exportDateLabel: string
): WorksheetStats {
  const worksheet = workbook.addWorksheet('Orders');
  worksheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key }));

  const included = orders.filter((order) => !isExcludedOrder(order));
  included.sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (at !== bt) return at - bt;
    return String(a.orderNumber || a.shopifyOrderId || '').localeCompare(String(b.orderNumber || b.shopifyOrderId || ''));
  });

  let totalQuantity = 0;
  let totalPrice = 0;
  for (const order of included) {
    for (const row of orderRows(order, usersByEmail, exportDateLabel)) {
      worksheet.addRow(row);
      if (typeof row.quantity === 'number') totalQuantity += row.quantity;
      if (typeof row.totalPrice === 'number') totalPrice += row.totalPrice;
    }
  }
  totalPrice = Math.round(totalPrice * 100) / 100;

  const totalRow = worksheet.addRow({ id: 'Total', quantity: totalQuantity, totalPrice });
  totalRow.font = { bold: true };

  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
  });
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  const lastColumnLetter = worksheet.getColumn(COLUMNS.length).letter;
  worksheet.autoFilter = `A1:${lastColumnLetter}1`;

  for (const col of COLUMNS) {
    if (col.money) worksheet.getColumn(col.key).numFmt = RUPEE_FORMAT;
  }
  worksheet.getColumn('address').alignment = { wrapText: true, vertical: 'top' };

  worksheet.columns.forEach((column, index) => {
    const spec = COLUMNS[index];
    if (spec?.key === 'address') {
      column.width = 60;
      return;
    }
    let maxLength = spec?.header.length ?? 10;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const text = cell.value === null || cell.value === undefined ? '' : String(cell.value);
      if (text.length > maxLength) maxLength = text.length;
    });
    column.width = Math.min(Math.max(maxLength + 2, 10), 40);
  });

  return { includedCount: included.length, excludedCount: orders.length - included.length, totalQuantity, totalPrice };
}

export interface ExportFile {
  filePath: string;
  fileName: string;
  count: number;
  excludedCount: number;
}

// On-demand export for the signed-in employee ("Export My Orders" button, POST
// /api/sap/export-daily): all of their own orders, across every date (not just today's).
// Keeps its original file-naming scheme - the "<exportDate>_<employeeId>.xlsx" convention below
// was asked for the daily cron/admin sheets specifically, which this route is not.
export async function generateDailyExport(email: string): Promise<ExportFile> {
  const orders = await Order.findAll({
    where: { email },
    include: [{ model: OrderLineItem, as: 'lineItems' }],
    order: [['createdAt', 'DESC']],
    raw: false,
  });
  const usersByEmail = await buildUsersByEmail(orders.map((o) => o.email));

  const workbook = new ExcelJS.Workbook();
  const todayLabel = formatDateOnly(toDateOnly(new Date()));
  const stats = buildOrdersWorksheet(workbook, orders, usersByEmail, todayLabel);

  const dir = path.resolve(sap.localDir);
  fs.mkdirSync(dir, { recursive: true });
  const datePart = new Date().toISOString().slice(0, 10);
  // Slug of the employee's email, so two employees exporting on the same day never collide.
  const employeeSlug = email.replace(/[^a-z0-9]+/gi, '-');
  const fileName = `sap-orders-${employeeSlug}-${datePart}.xlsx`;
  const filePath = path.join(dir, fileName);

  await workbook.xlsx.writeFile(filePath);

  return { filePath, fileName, count: stats.includedCount, excludedCount: stats.excludedCount };
}

// ---------------------------------------------------------------------------
// Employee Orders page: one export per employee per calendar day
// ---------------------------------------------------------------------------

// Calendar boundaries are constructed explicitly in IST, independent of the server process
// timezone. MySQL receives the corresponding UTC instants for its created_at comparison.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istDateParts(value: Date | string | number): { year: number; month: number; day: number } {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function istCalendarDateToUTC(dateOnly: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) throw new Error(`Invalid export date: ${dateOnly}`);
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(utcMidnight - IST_OFFSET_MS);
}

export function dayBounds(dateInput: string | Date | number): { start: Date; end: Date } {
  const dateOnly = typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)
    ? dateInput
    : toDateOnly(dateInput);
  const start = istCalendarDateToUTC(dateOnly);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

// Deliberately NOT toISOString().slice(0, 10) - that round-trips through UTC and
// rolls back to the previous calendar day for any timezone ahead of UTC (e.g. IST)
// once the local time-of-day is early enough, which silently mislabels the file.
export function toDateOnly(date: Date | string | number): string {
  const { year, month, day } = istDateParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function previousDateInIST(now: Date = new Date()): string {
  const { year, month, day } = istDateParts(now);
  const previous = new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000);
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}-${String(previous.getUTCDate()).padStart(2, '0')}`;
}

export interface EmployeeExportFile extends ExportFile {
  exportDate: string;
}

function isDailyExportDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; parent?: { errno?: unknown; code?: unknown } };
  return candidate.name === 'SequelizeUniqueConstraintError'
    || candidate.parent?.errno === 1062
    || candidate.parent?.code === 'ER_DUP_ENTRY';
}

async function writeEmployeeDailyExport(
  email: string,
  exportDate: string,
  orders: OrderInstance[],
  usersByEmail: Map<string, UserInstance>
): Promise<EmployeeExportFile | null> {
  const workbook = new ExcelJS.Workbook();
  const stats = buildOrdersWorksheet(workbook, orders, usersByEmail, formatDateOnly(exportDate));
  if (stats.includedCount === 0) return null;

  const employeeIdOrSlug = usersByEmail.get(email)?.employeeId || String(email).replace(/[^a-z0-9]+/gi, '-');
  const fileName = `${exportDate}_${employeeIdOrSlug}.xlsx`;
  const dir = dailyExportDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await workbook.xlsx.writeFile(filePath);

  return { fileName, filePath, count: stats.includedCount, excludedCount: stats.excludedCount, exportDate };
}

// Same shape as generateDailyExport, but scoped to one explicit calendar day (rather than
// "all time") - this is what the midnight per-employee cron uses, and it reuses
// buildOrdersWorksheet so the columns are always identical to the on-demand export. Returns null
// (writes nothing) when the employee has no non-cancelled order that day - the caller then
// records no DailyExport row either, so a day with nothing to show has no file, not an empty one.
export async function generateEmployeeDailyExport(
  email: string,
  dateInput: string | Date | number
): Promise<EmployeeExportFile | null> {
  const { start, end } = dayBounds(dateInput);
  const exportDate = toDateOnly(start);

  const orders = await Order.findAll({
    where: { email, createdAt: { [Op.gte]: start, [Op.lte]: end } },
    include: [{ model: OrderLineItem, as: 'lineItems' }],
    order: [['createdAt', 'DESC']],
  });
  const usersByEmail = await buildUsersByEmail(orders.map((o) => o.email));
  return writeEmployeeDailyExport(email, exportDate, orders, usersByEmail);
}

export interface DailyRunResult {
  exportDate: string;
  totalEmployees: number;
  created: number;
  skipped: number;
  noOrders: number;
  failed: number;
  excludedOrders: number;
  excludedByReason: Omit<ExcludedOrderSummary, 'total'>;
}

// Runs once daily (see src/jobs/employeeDailyExportCron.ts). The employee list and all orders for
// the date are fetched once, then orders are grouped in memory by employee email. An employee
// with none gets no file and no record. Existing (employee, day) records are skipped so a retry
// cannot duplicate or clobber a previous day's file.
export async function runDailyEmployeeExports(dateInput: string | Date | number): Promise<DailyRunResult> {
  const { start, end } = dayBounds(dateInput);
  const exportDate = toDateOnly(start);
  const employees = await User.findAll({ attributes: ['email', 'employeeId', 'ticketId', 'name', 'phone'] });
  const employeeEmails = employees.map(({ email }) => email);
  const existingRecords = employeeEmails.length
    ? await DailyExport.findAll({ where: { exportDate, email: { [Op.in]: employeeEmails } } })
    : [];
  const existingEmails = new Set(existingRecords.map((record) => record.email));
  const orders = employeeEmails.length
    ? await Order.findAll({
        where: { email: { [Op.in]: employeeEmails }, createdAt: { [Op.gte]: start, [Op.lte]: end } },
        include: [{ model: OrderLineItem, as: 'lineItems' }],
        order: [['createdAt', 'ASC']],
      })
    : [];
  const excluded = summarizeExcludedOrders(orders);
  const usersByEmail = new Map(employees.map((employee) => [employee.email, employee]));
  const ordersByEmail = new Map<string, OrderInstance[]>();
  for (const order of orders) {
    if (isExcludedOrder(order) || !order.email) continue;
    const employeeOrders = ordersByEmail.get(order.email) || [];
    employeeOrders.push(order);
    ordersByEmail.set(order.email, employeeOrders);
  }

  let created = 0;
  let skipped = existingEmails.size;
  let noOrders = 0;
  let failed = 0;

  for (const email of employeeEmails) {
    if (existingEmails.has(email)) continue;
    const employeeOrders = ordersByEmail.get(email);
    if (!employeeOrders?.length) {
      noOrders += 1;
      continue;
    }
    try {
      const file = await writeEmployeeDailyExport(email, exportDate, employeeOrders, usersByEmail);
      if (!file) {
        noOrders += 1;
        continue;
      }
      try {
        await DailyExport.create({ email, exportDate, orderCount: file.count, fileName: file.fileName });
        created += 1;
      } catch (err) {
        // The pre-check above avoids normal duplicates. The unique (employee_email, export_date)
        // index is still the authority when two cron/script processes overlap. Treat that race
        // as an idempotent skip instead of reporting a failed export.
        if (!isDailyExportDuplicateError(err)) throw err;
        skipped += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(`[daily-export] failed for ${email} on ${exportDate}:`, errorMessage(err));
    }
  }

  return {
    exportDate,
    totalEmployees: employees.length,
    created,
    skipped,
    noOrders,
    failed,
    excludedOrders: excluded.total,
    excludedByReason: { cancelled: excluded.cancelled, voided: excluded.voided, refunded: excluded.refunded },
  };
}
