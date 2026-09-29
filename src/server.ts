import app from './app';
import { port, nodeEnv, map, shopify, jwtSecret, admin } from './config/env';
import { alertServerError } from './services/alert';
import connectDB from './config/db';
import { ensureOrderColumns, ensureUserColumns } from './config/ensureSchema';
import scheduleEmployeeDailyExport from './jobs/employeeDailyExportCron';
import scheduleOrderReconcile from './jobs/orderReconcileCron';
import * as shopifyClient from './services/shopify/client';
import { errorMessage } from './utils/errors';

// The three credentials must stay separate: the MAP external API key is not a Shopify
// credential and is never derived from one.
// A missing value is a server misconfiguration: the routes that need it answer a generic 500 (never a
// 503) - so it is alerted here, at startup, as well as on every request that hits it.
function checkCredentialConfig(): void {
  const required: [string, string | undefined][] = [
    ['MAP_API_KEY', map.apiKey],
    ['JWT_SECRET', jwtSecret],
    ['ADMIN_EMAIL', admin.email],
    ['SHOPIFY_STORE_DOMAIN', shopify.storeDomain],
    ['SHOPIFY_ACCESS_TOKEN', shopify.accessToken],
    ['SHOPIFY_WEBHOOK_SECRET', shopify.webhookSecret],
  ];
  for (const [name, value] of required) {
    if (!value) {
      void alertServerError({
        key: `missing-${name}`,
        title: `Server misconfiguration: ${name} is not set`,
        detail: 'the routes that need it answer 500',
      });
    }
  }
  if (map.apiKey && (map.apiKey === shopify.apiKey || map.apiKey === shopify.accessToken)) {
    console.warn('MAP_API_KEY must not reuse a Shopify credential - generate a dedicated key');
  }
}

async function start(): Promise<void> {
  checkCredentialConfig();
  await connectDB();
  await ensureOrderColumns();
  await ensureUserColumns();
  scheduleEmployeeDailyExport();
  scheduleOrderReconcile();

  app.listen(port, () => {
    console.log(`Server running in ${nodeEnv} mode on port ${port}`);
    // Warm the product catalog cache so the first Shop/Products request is not the slow one.
    shopifyClient.listProductsCatalog().catch((err: unknown) => console.warn('[catalog] warm-up failed:', errorMessage(err)));
  });
}

start().catch((err: unknown) => {
  console.error('Failed to start server:', errorMessage(err));
  process.exit(1);
});
