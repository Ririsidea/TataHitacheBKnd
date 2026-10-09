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

// Additive, idempotent upgrade for the users table. Safe to re-run: only touches what
// isn't already in the target shape.
//   users.employee_id    - 5-digit login id, backfilled below for any row without one.
//   users.ticket_id       - optional 5-digit login id, same column type as employee_id so
//                           a leading zero survives; unlike employee_id, stays nullable and
//                           is never backfilled (most accounts simply have no ticket id).
//   users.role            - ENUM('admin','employee'); not yet read by any access check
//                           (see middleware/requireAdmin.ts), kept for future use.
//   users.is_dummy        - TINYINT(1) NOT NULL DEFAULT 0; true marks seeded test employees (see
//                           ensureDummyFlag below).
//   users.token_version   - retired (sessions now end only on JWT expiry; there is no
//                           server-side revocation); dropped if still present.
//   users.is_active       - retired (never read or written by any current code); dropped
//                           if still present.
export async function ensureUserColumns(): Promise<void> {
  const [cols] = (await sequelize.query(
    "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
  )) as [ColumnRow[], unknown];
  const columns = new Map(cols.map((c) => [c.name, c]));

  // role: add it for a fresh install that predates this column; existing databases
  // (this one included) already have it with the right type and default.
  if (!columns.has('role')) {
    await sequelize.query("ALTER TABLE users ADD COLUMN role ENUM('admin','employee') NOT NULL DEFAULT 'employee'");
    console.log("[schema] added users.role");
  }

  // token_version: no longer read anywhere (middleware/authenticate.ts only checks that
  // the user still exists); drop it if an earlier version of this app created it.
  if (columns.has('token_version')) {
    await sequelize.query('ALTER TABLE users DROP COLUMN token_version');
    console.log('[schema] dropped users.token_version');
  }

  // is_active: never read or written by any current code; drop it if present.
  if (columns.has('is_active')) {
    await sequelize.query('ALTER TABLE users DROP COLUMN is_active');
    console.log('[schema] dropped users.is_active');
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

  // ticket_id: same column type as employee_id (VARCHAR(5), so a leading zero like "01234"
  // is preserved), but stays NULL-able - most accounts have no ticket id, and a plain
  // UNIQUE index allows any number of NULLs in MySQL, so that's never an issue.
  if (!columns.has('ticket_id')) {
    await sequelize.query('ALTER TABLE users ADD COLUMN ticket_id VARCHAR(5) NULL');
    console.log('[schema] added users.ticket_id');
  }
  const [ticketIdxRows] = (await sequelize.query(
    "SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'ticket_id' AND NON_UNIQUE = 0"
  )) as [{ name: string }[], unknown];
  if (!ticketIdxRows.length) {
    await sequelize.query('ALTER TABLE users ADD UNIQUE INDEX ticket_id (ticket_id)');
    console.log('[schema] added unique index users.ticket_id');
  }

  await ensureDummyFlag();
}

// The fake domain the first seeded employees used. It is read here ONLY to flag those rows once;
// after that every script and mail check relies on users.is_dummy, never on the email domain.
export const LEGACY_SEED_DOMAIN = 'thcm-test.local';

// Adds users.is_dummy and flags the employees the seed script created before the flag existed.
// Idempotent: the backfill only touches rows still at 0, never an admin, and matches nothing
// once the domain has been renamed.
export async function ensureDummyFlag(): Promise<void> {
  const [cols] = (await sequelize.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_dummy'"
  )) as [{ name: string }[], unknown];
  if (!cols.length) {
    await sequelize.query('ALTER TABLE users ADD COLUMN is_dummy TINYINT(1) NOT NULL DEFAULT 0');
    console.log('[schema] added users.is_dummy');
  }
  const [result] = (await sequelize.query(
    "UPDATE users SET is_dummy = 1 WHERE is_dummy = 0 AND role <> 'admin' AND email LIKE ?",
    { replacements: [`%@${LEGACY_SEED_DOMAIN}`] }
  )) as [unknown, unknown];
  const flagged = (result as { affectedRows?: number }).affectedRows || 0;
  if (flagged) console.log(`[schema] flagged ${flagged} @${LEGACY_SEED_DOMAIN} users as is_dummy`);
}

// Additive-only columns that let the daily export sheet carry the full order detail (address,
// totals, payment, fulfillment dates) straight from the DB instead of calling Shopify at export
// time. Values come only from the raw webhook payload (see services/orderDetails.ts) - never
// from a live Shopify read, which this store's app returns with address/customer PII redacted.
//
// orders.raw_payload is deliberately NOT a Sequelize model attribute (see models/Order.ts) -
// it is written and read only via raw SQL in services/orderDetails.ts, so it can never be
// picked up by order.toJSON() and leak out of an existing API response by accident.
export async function ensureOrderDetailColumns(): Promise<void> {
  const [orderCols] = (await sequelize.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'"
  )) as [{ name: string }[], unknown];
  const haveOrderCol = new Set(orderCols.map((c) => c.name));

  const orderColumnsToAdd: [string, string][] = [
    ['order_number', 'VARCHAR(20) NULL'],
    ['shipping_name', 'VARCHAR(255) NULL'],
    ['shipping_address1', 'VARCHAR(500) NULL'],
    ['shipping_address2', 'VARCHAR(500) NULL'],
    ['shipping_city', 'VARCHAR(255) NULL'],
    ['shipping_state', 'VARCHAR(255) NULL'],
    ['shipping_zip', 'VARCHAR(20) NULL'],
    ['shipping_country', 'VARCHAR(255) NULL'],
    ['shipping_phone', 'VARCHAR(30) NULL'],
    ['billing_name', 'VARCHAR(255) NULL'],
    ['billing_address1', 'VARCHAR(500) NULL'],
    ['billing_address2', 'VARCHAR(500) NULL'],
    ['billing_city', 'VARCHAR(255) NULL'],
    ['billing_state', 'VARCHAR(255) NULL'],
    ['billing_zip', 'VARCHAR(20) NULL'],
    ['billing_country', 'VARCHAR(255) NULL'],
    ['billing_phone', 'VARCHAR(30) NULL'],
    ['customer_email', 'VARCHAR(255) NULL'],
    ['customer_phone', 'VARCHAR(30) NULL'],
    ['subtotal_price', 'DECIMAL(10,2) NULL'],
    ['total_discount', 'DECIMAL(10,2) NULL'],
    ['total_tax', 'DECIMAL(10,2) NULL'],
    ['shipping_charge', 'DECIMAL(10,2) NULL'],
    ['payment_method', 'VARCHAR(255) NULL'],
    ['order_note', 'TEXT NULL'],
    ['tags', 'VARCHAR(500) NULL'],
    ['cancel_reason', 'VARCHAR(100) NULL'],
    ['cancelled_at', 'DATETIME NULL'],
    ['shipped_at', 'DATETIME NULL'],
    ['delivered_at', 'DATETIME NULL'],
    // Backend-only, see the function comment above - never a model attribute.
    ['raw_payload', 'LONGTEXT NULL'],
  ];
  for (const [name, ddl] of orderColumnsToAdd) {
    if (!haveOrderCol.has(name)) {
      await sequelize.query(`ALTER TABLE orders ADD COLUMN ${name} ${ddl}`);
      console.log(`[schema] added orders.${name}`);
    }
  }

  const [lineCols] = (await sequelize.query(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_line_items'"
  )) as [{ name: string }[], unknown];
  const haveLineCol = new Set(lineCols.map((c) => c.name));
  const lineColumnsToAdd: [string, string][] = [
    ['variant_title', 'VARCHAR(255) NULL'],
    ['line_discount', 'DECIMAL(10,2) NULL'],
    ['line_tax', 'DECIMAL(10,2) NULL'],
  ];
  for (const [name, ddl] of lineColumnsToAdd) {
    if (!haveLineCol.has(name)) {
      await sequelize.query(`ALTER TABLE order_line_items ADD COLUMN ${name} ${ddl}`);
      console.log(`[schema] added order_line_items.${name}`);
    }
  }
}
