const app = require('./app');
const { port, nodeEnv, map, shopify } = require('./config/env');
const connectDB = require('./config/db');
const { ensureOrderColumns } = require('./config/ensureSchema');
// const scheduleSapExport = require('./jobs/sapExportCron');
const scheduleEmployeeDailyExport = require('./jobs/employeeDailyExportCron');
const shopifyClient = require('./services/shopify/client');

// The three credentials must stay separate: the MAP external API key is not a Shopify
// credential and is never derived from one.
function checkCredentialConfig() {
  if (!map.apiKey) {
    console.warn('MAP_API_KEY is not set - x-api-key protected routes will reject every request');
  } else if (map.apiKey === shopify.apiKey || map.apiKey === shopify.accessToken) {
    console.warn('MAP_API_KEY must not reuse a Shopify credential - generate a dedicated key');
  }
}

async function start() {
  checkCredentialConfig();
  await connectDB();
  await ensureOrderColumns();
  scheduleEmployeeDailyExport();

  app.listen(port, () => {
    console.log(`Server running in ${nodeEnv} mode on port ${port}`);
    // Warm the product catalog cache so the first Shop/Products request is not the slow one.
    shopifyClient.listProductsCatalog().catch((err) => console.warn('[catalog] warm-up failed:', err.message));
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
