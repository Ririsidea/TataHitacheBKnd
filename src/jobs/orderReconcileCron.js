const cron = require('node-cron');
const { reconcileActiveOrders } = require('../services/orderReconcile.service');

let running = false;

async function runReconcile() {
  if (running) return; // the previous run is still going: skip rather than overlap
  running = true;
  try {
    const { checked, updated, failed } = await reconcileActiveOrders();
    if (updated || failed) {
      console.log(`[Order Reconcile] ${checked} checked, ${updated} updated from Shopify, ${failed} failed`);
    }
  } catch (err) {
    console.error('[Order Reconcile] Failed to run:', err.message);
  } finally {
    running = false;
  }
}

// Keeps MAP's order status in step with Shopify even when a webhook is missed: every 30 seconds
// the still-changing orders are compared with Shopify and any difference is mirrored (and pushed
// to the open screens). Also runs once at startup to catch what changed while the server was down.
function scheduleOrderReconcile() {
  cron.schedule('*/30 * * * * *', runReconcile);
  runReconcile();
}

module.exports = scheduleOrderReconcile;
