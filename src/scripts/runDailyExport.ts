// npm run export:daily -- [--date=YYYY-MM-DD] [--force] [--dry-run]
// Manual trigger for the daily export - the exact same logic the cron (src/jobs/
// employeeDailyExportCron.ts) runs, for one explicit day instead of waiting for 00:05 IST.
//   --date=   defaults to yesterday, same default the cron uses.
//   --force   deletes any existing DailyExport/AdminDailyExport record (and its file) for that
//             date first, then regenerates - the normal run always skips a date it already has.
//   --dry-run computes what would happen - how many files would be created, how many employees
//             already have a record, how many have no non-cancelled order, how many orders would
//             be excluded as cancelled/voided/refunded - without writing any file or DB row.
import fs from 'fs';
import path from 'path';
import { Op } from 'sequelize';
import connectDB from '../config/db';
import { Order, OrderLineItem, User, DailyExport, AdminDailyExport } from '../models';
import { runDailyEmployeeExports, isExcludedOrder, summarizeExcludedOrders, dayBounds, toDateOnly, dailyExportDir, allOrdersExportDir, previousDateInIST } from '../services/orderExport.service';
import { errorMessage } from '../utils/errors';

interface Args {
  date: string | Date;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const dateArg = argv.find((a) => a.startsWith('--date='));
  let date: string | Date;
  if (dateArg) {
    date = dateArg.slice('--date='.length);
  } else {
    date = previousDateInIST();
  }
  return { date, force: argv.includes('--force'), dryRun: argv.includes('--dry-run') };
}

async function removeExistingRecords(exportDate: string): Promise<void> {
  const perEmployee = await DailyExport.findAll({ where: { exportDate } });
  for (const record of perEmployee) {
    await fs.promises.unlink(path.join(dailyExportDir(), record.fileName)).catch(() => undefined);
  }
  if (perEmployee.length) await DailyExport.destroy({ where: { exportDate } });

  const admin = await AdminDailyExport.findOne({ where: { exportDate } });
  if (admin) {
    await fs.promises.unlink(path.join(allOrdersExportDir(), admin.fileName)).catch(() => undefined);
    await admin.destroy();
  }
}

// Mirrors runDailyEmployeeExports' own decisions, read-only.
async function dryRun(date: string | Date): Promise<void> {
  const { start, end } = dayBounds(date);
  const exportDate = toDateOnly(start);
  const employees = await User.findAll({ attributes: ['email'] });
  const employeeEmails = employees.map(({ email }) => email);
  const existingRecords = employeeEmails.length
    ? await DailyExport.findAll({ where: { exportDate, email: { [Op.in]: employeeEmails } } })
    : [];
  const existingEmails = new Set(existingRecords.map((record) => record.email));
  const orders = employeeEmails.length
    ? await Order.findAll({
        where: { email: { [Op.in]: employeeEmails }, createdAt: { [Op.gte]: start, [Op.lte]: end } },
        include: [{ model: OrderLineItem, as: 'lineItems' }],
      })
    : [];
  const qualifyingByEmail = new Set(orders.filter((order) => Boolean(order.email) && !isExcludedOrder(order)).map((order) => order.email as string));
  const excluded = summarizeExcludedOrders(orders);

  let wouldCreate = 0;
  const alreadyHaveRecord = existingEmails.size;
  let noOrders = 0;

  for (const email of employeeEmails) {
    if (existingEmails.has(email)) continue;
    if (qualifyingByEmail.has(email)) wouldCreate += 1;
    else noOrders += 1;
  }

  console.log(
    `[dry-run] ${exportDate}: would create ${wouldCreate} file(s), ${alreadyHaveRecord} already have a record, ` +
      `${noOrders} have no qualifying order, ${excluded.total} order(s) excluded ` +
      `(cancelled ${excluded.cancelled}, voided ${excluded.voided}, refunded ${excluded.refunded}) ` +
      `(of ${employees.length} employees). No file or DB row was written.`
  );
}

async function main(): Promise<void> {
  await connectDB();
  const { date, force, dryRun: isDryRun } = parseArgs(process.argv.slice(2));

  if (isDryRun) {
    await dryRun(date);
    return;
  }

  if (force) {
    const { start } = dayBounds(date);
    const exportDate = toDateOnly(start);
    console.log(`--force: removing any existing export records/files for ${exportDate}`);
    await removeExistingRecords(exportDate);
  }

  const result = await runDailyEmployeeExports(date);
  console.log(
    `[export:daily] ${result.exportDate}: ${result.created} created, ${result.skipped} already existed, ` +
      `${result.noOrders} had no orders, ${result.failed} failed (of ${result.totalEmployees} employees)`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('runDailyExport failed:', errorMessage(err));
    process.exit(1);
  });
