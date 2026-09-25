const { sequelize } = require('./db');

// Additive, idempotent schema upgrade run at startup (the project has no migration tool;
// schema.sql is the source of truth for fresh installs, this brings an existing database
// up to date). Adds nullable columns, and drops the retired orders.crf_id column.
//   orders.channel  - where the order came from (default "MAP")
//   orders.delivery_status - carrier / Shopify delivery state of the shipment (in_transit,
//                     out_for_delivery, delivered, ...), mirrored from Shopify
//   orders.crf_id   - retired (the idempotency key is no longer used); dropped if still present
async function ensureOrderColumns() {
  const [rows] = await sequelize.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'"
  );
  const have = new Set(rows.map((r) => r.name));

  if (!have.has('channel')) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN channel VARCHAR(50) NULL');
    console.log('[schema] added orders.channel');
  }
  if (!have.has('delivery_status')) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN delivery_status VARCHAR(50) NULL');
    console.log('[schema] added orders.delivery_status');
  }
  // Nothing reads or writes this column any more. Dropping it also drops its unique key,
  // and it only runs when the column exists, so restarts are a no-op.
  if (have.has('crf_id')) {
    await sequelize.query('ALTER TABLE orders DROP COLUMN crf_id');
    console.log('[schema] dropped orders.crf_id');
  }
}

module.exports = { ensureOrderColumns };
