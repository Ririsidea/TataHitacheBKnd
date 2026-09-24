const { sequelize } = require('./db');

// Additive, idempotent schema upgrade run at startup (the project has no migration tool;
// schema.sql is the source of truth for fresh installs, this brings an existing database
// up to date). Only ever ADDs nullable columns - never alters or drops data.
//   orders.channel  - where the order came from (default "MAP")
//   orders.crf_id   - caller-supplied CRF id; UNIQUE so the same CRF can never create two
//                     orders (MySQL allows many NULLs, so orders without one are unaffected)
async function ensureOrderColumns() {
  const [rows] = await sequelize.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'"
  );
  const have = new Set(rows.map((r) => r.name));

  if (!have.has('channel')) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN channel VARCHAR(50) NULL');
    console.log('[schema] added orders.channel');
  }
  if (!have.has('crf_id')) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN crf_id VARCHAR(100) NULL, ADD UNIQUE KEY uq_orders_crf_id (crf_id)');
    console.log('[schema] added orders.crf_id');
  }
}

module.exports = { ensureOrderColumns };
