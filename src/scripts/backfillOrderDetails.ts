// npm run backfill:order-details
// One-off: fills the new order-detail columns for orders that predate them, from already-logged
// webhook payloads only - see services/orderBackfill.service.ts for exactly what this does and
// does not do (never calls Shopify, never invents data).
import connectDB from '../config/db';
import { backfillOrderDetailsFromLogs } from '../services/orderBackfill.service';
import { errorMessage } from '../utils/errors';

async function main(): Promise<void> {
  await connectDB();
  const result = await backfillOrderDetailsFromLogs();
  console.log(`Candidates checked: ${result.total}`);
  console.log(`Backfilled from a logged webhook payload: ${result.backfilled}`);
  console.log(`No logged payload found (left blank, not invented): ${result.noLogFound}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('backfillOrderDetails failed:', err instanceof Error ? err.message : errorMessage(err));
    process.exit(1);
  });
