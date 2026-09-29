import { sequelize } from './db';

// Additive, idempotent schema upgrade run at startup (the project has no migration tool;
// schema.sql is the source of truth for fresh installs, this brings an existing database
// up to date). Adds nullable columns, and drops the retired orders.crf_id column.
//   orders.channel  - where the order came from (default "MAP")
//   orders.delivery_status - carrier / Shopify delivery state of the shipment (in_transit,
//                     out_for_delivery, delivered, ...), mirrored from Shopify
//   orders.crf_id   - retired (the idempotency key is no longer used); dropped if still present
export async function ensureOrderColumns(): Promise<void> {
  const [rows] = (await sequelize.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'"
  )) as [{ name: string }[], unknown];
  const have = new Set(rows.map((r) => r.name));

  if (!have.has('channel')) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN channel VARCHAR(50) NULL');
    console.log('[schema] added orders.channel');
  }
  if (!have.has('delivery_status')) {
    await sequelize.query('ALTER TABLE orders ADD COLUMN delivery_status VARCHAR(50) NULL');
    console.log('[schema] added orders.delivery_status');
  }
  // Every order route looks orders up by shopify_order_id, so it must be unique. Existing databases
  // already have uq_orders_shopify_order_id; this only adds it to one created without it.
  const [uniques] = (await sequelize.query(
    "SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'shopify_order_id' AND NON_UNIQUE = 0"
  )) as [{ name: string }[], unknown];
  if (!uniques.length) {
    await sequelize.query('ALTER TABLE orders ADD UNIQUE INDEX uq_orders_shopify_order_id (shopify_order_id)');
    console.log('[schema] added unique index orders.shopify_order_id');
  }
  // Nothing reads or writes this column any more. Dropping it also drops its unique key,
  // and it only runs when the column exists, so restarts are a no-op.
  if (have.has('crf_id')) {
    await sequelize.query('ALTER TABLE orders DROP COLUMN crf_id');
    console.log('[schema] dropped orders.crf_id');
  }
}

interface ColumnRow {
  name: string;
  type: string;
  nullable: string;
}

// Additive, idempotent upgrade for users.employee_id (5-digit login id) and users.token_version
// (bumped on an admin password reset to invalidate old JWTs - see middleware/authenticate.ts).
// Safe to re-run: only touches what isn't already in the target shape.
export async function ensureUserColumns(): Promise<void> {
  const [cols] = (await sequelize.query(
    "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
  )) as [ColumnRow[], unknown];
  const columns = new Map(cols.map((c) => [c.name, c]));

  if (!columns.has('token_version')) {
    await sequelize.query('ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0');
    console.log('[schema] added users.token_version');
  }

  const employeeIdCol = columns.get('employee_id');
  if (!employeeIdCol) {
    await sequelize.query('ALTER TABLE users ADD COLUMN employee_id VARCHAR(5) NULL');
    console.log('[schema] added users.employee_id');
  } else if (employeeIdCol.type !== 'varchar(5)') {
    // Widening is never needed (5 digits max); shrinking is safe here because every
    // existing value in this database is NULL (checked before this ships).
    await sequelize.query('ALTER TABLE users MODIFY COLUMN employee_id VARCHAR(5) NULL');
    console.log(`[schema] resized users.employee_id from ${employeeIdCol.type} to varchar(5)`);
  }

  // Collapse duplicate unique indexes on employee_id (seen: employee_id, employee_id_2) down to one.
  const [idxRows] = (await sequelize.query(
    "SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'employee_id' AND NON_UNIQUE = 0 ORDER BY INDEX_NAME"
  )) as [{ name: string }[], unknown];
  const [keep, ...extra] = idxRows.map((r) => r.name);
  for (const name of extra) {
    await sequelize.query(`ALTER TABLE users DROP INDEX \`${name}\``);
    console.log(`[schema] dropped duplicate index users.${name}`);
  }
  if (!keep) {
    await sequelize.query('ALTER TABLE users ADD UNIQUE INDEX employee_id (employee_id)');
    console.log('[schema] added unique index users.employee_id');
  }

  // Backfill: every user without an employee_id gets the next free 5-digit id, starting at
  // 12345, in id order - skipping ids a previous partial run (or manual entry) already used.
  const [usedRows] = (await sequelize.query(
    "SELECT employee_id AS id FROM users WHERE employee_id IS NOT NULL AND employee_id <> ''"
  )) as [{ id: string }[], unknown];
  const used = new Set(usedRows.map((r) => r.id));
  const [missingRows] = (await sequelize.query(
    "SELECT id FROM users WHERE employee_id IS NULL OR employee_id = '' ORDER BY id"
  )) as [{ id: number }[], unknown];
  let next = 12345;
  for (const row of missingRows) {
    while (used.has(String(next))) next += 1;
    const candidate = String(next);
    used.add(candidate);
    await sequelize.query('UPDATE users SET employee_id = ? WHERE id = ?', { replacements: [candidate, row.id] });
    console.log(`[schema] assigned employee_id ${candidate} to users.id=${row.id}`);
    next += 1;
  }

  const [nullableCheck] = (await sequelize.query(
    "SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'employee_id'"
  )) as [{ nullable: string }[], unknown];
  if (nullableCheck[0]?.nullable === 'YES') {
    await sequelize.query('ALTER TABLE users MODIFY COLUMN employee_id VARCHAR(5) NOT NULL');
    console.log('[schema] set users.employee_id NOT NULL');
  }
}
