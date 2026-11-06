// npm run export:daily -- [--date=YYYY-MM-DD] [--force] [--dry-run]
// Manual trigger for the admin consolidated daily export - the exact same logic the cron
// (src/jobs/employeeDailyExportCron.ts) runs, for one explicit day instead of waiting for 00:05 IST.
//   --date=   defaults to yesterday, same default the cron uses.
//   --force   deletes any existing AdminDailyExport record (and its file) for that date first,
//             then regenerates - the normal run always skips a date it already has.
//   --dry-run reports qualifying/excluded orders and whether one consolidated file would be made,
//             without writing any file or DB row.
import fs from 'fs';
import path from 'path';
import { Op } from 'sequelize';
import connectDB from '../config/db';
import { Order, OrderLineItem, AdminDailyExport } from '../models';
import { runDailyAdminExport, isExcludedOrder, summarizeExcludedOrders, dayBounds, toDateOnly, allOrdersExportDir, previousDateInIST } from '../services/orderExport.service';
import { cloudinaryFileFromRecord, destroyPrivateRawFile } from '../services/cloudinaryStorage.service';
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
  const record = await AdminDailyExport.findOne({ where: { exportDate } });
  if (!record) return;
  const cloudinaryFile = cloudinaryFileFromRecord(record);
  if (cloudinaryFile) await destroyPrivateRawFile(cloudinaryFile).catch(() => undefined);
  else await fs.promises.unlink(path.join(allOrdersExportDir(), record.fileName)).catch(() => undefined);
  await record.destroy();
}

// Mirrors runDailyAdminExport's own decisions, read-only.
async function dryRun(date: string | Date): Promise<void> {
  const { start, end } = dayBounds(date);
  const exportDate = toDateOnly(start);
  const existing = await AdminDailyExport.findOne({ where: { exportDate } });
  const orders = await Order.findAll({
    where: { createdAt: { [Op.gte]: start, [Op.lte]: end } },
    include: [{ model: OrderLineItem, as: 'lineItems' }],
  });
  const qualifyingOrders = orders.filter((order) => !isExcludedOrder(order));
  const excluded = summarizeExcludedOrders(orders);

  const wouldCreate = !existing && qualifyingOrders.length > 0;
  console.log(
    `[dry-run] ${exportDate}: ${wouldCreate ? 'would create 1 consolidated file' : existing ? 'already has a consolidated record' : 'no file would be created'}, ` +
      `${qualifyingOrders.length} qualifying order(s), ${excluded.total} order(s) excluded ` +
      `(cancelled ${excluded.cancelled}, voided ${excluded.voided}, refunded ${excluded.refunded}). ` +
      `No file or DB row was written.`
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

  const result = await runDailyAdminExport(date);
  console.log(
    `[export:daily] ${result.exportDate}: ` +
      `${result.noOrders ? 'no orders' : result.created ? `created 1 consolidated file with ${result.orderCount} orders` : `already existed with ${result.orderCount} orders`}, ` +
      `${result.excludedOrders} excluded`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('runDailyExport failed:', errorMessage(err));
    process.exit(1);
  });
