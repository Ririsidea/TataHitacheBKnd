import { createHash } from 'crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/db';

const TARGET_DATABASE = 'tata_hitache';

type UserSnapshotRow = {
  id: number;
  email: string;
  employee_id: string;
  ticket_id: string | null;
  name: string | null;
  phone: string | null;
  password_hash: string;
  role: string;
  must_reset_password: number;
  created_at: Date | string | null;
  updated_at: Date | string | null;
};

function stableValue(value: unknown): string {
  if (value === null || value === undefined) return '<null>';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function snapshot(rows: UserSnapshotRow[]): string {
  const serialized = rows
    .map((row) => [
      row.id,
      row.email,
      row.employee_id,
      row.ticket_id,
      row.name,
      row.phone,
      row.password_hash,
      row.role,
      row.must_reset_password,
      row.created_at,
      row.updated_at,
    ].map(stableValue).join('\u001f'))
    .join('\u001e');
  return createHash('sha256').update(serialized).digest('hex');
}

async function getUserSnapshot(): Promise<UserSnapshotRow[]> {
  return sequelize.query<UserSnapshotRow>(
    `SELECT id, email, employee_id, ticket_id, name, phone, password_hash,
            role, must_reset_password, created_at, updated_at
       FROM users
      ORDER BY id`,
    { type: QueryTypes.SELECT }
  );
}

async function main(): Promise<void> {
  const [database] = await sequelize.query<{ name: string | null }>('SELECT DATABASE() AS name', {
    type: QueryTypes.SELECT,
  });
  if (database?.name?.toLowerCase() !== TARGET_DATABASE) {
    throw new Error(`Refusing to run outside ${TARGET_DATABASE}`);
  }

  const [table] = await sequelize.query<{ present: number }>(
    "SELECT COUNT(*) AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'",
    { type: QueryTypes.SELECT }
  );
  if (!table || Number(table.present) !== 1) throw new Error('users table does not exist');

  const [column] = await sequelize.query<{ present: number }>(
    "SELECT COUNT(*) AS present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_dummy'",
    { type: QueryTypes.SELECT }
  );
  if (!column || Number(column.present) === 0) {
    console.log(JSON.stringify({ database: database.name, columnDropped: false, alreadyAbsent: true }));
    return;
  }

  const indexes = await sequelize.query<{ name: string }>(
    "SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_dummy'",
    { type: QueryTypes.SELECT }
  );
  if (indexes.length) throw new Error('Refusing to drop is_dummy while an index depends on it');

  const foreignKeys = await sequelize.query<{ name: string }>(
    "SELECT DISTINCT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_dummy' AND REFERENCED_TABLE_NAME IS NOT NULL",
    { type: QueryTypes.SELECT }
  );
  if (foreignKeys.length) throw new Error('Refusing to drop is_dummy while a foreign key depends on it');

  const before = await getUserSnapshot();
  const beforeDigest = snapshot(before);

  // MySQL DDL implicitly commits, so the pre/post snapshot verifies preservation instead of
  // pretending ALTER TABLE can be rolled back as a normal transaction.
  await sequelize.query('ALTER TABLE users DROP COLUMN `is_dummy`');

  const [remaining] = await sequelize.query<{ present: number }>(
    "SELECT COUNT(*) AS present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'is_dummy'",
    { type: QueryTypes.SELECT }
  );
  if (Number(remaining?.present) !== 0) throw new Error('is_dummy column still exists after migration');

  const after = await getUserSnapshot();
  const afterDigest = snapshot(after);
  if (before.length !== after.length || beforeDigest !== afterDigest) {
    throw new Error('User records changed while dropping is_dummy');
  }

  console.log(JSON.stringify({
    database: database.name,
    columnDropped: true,
    usersPreserved: after.length,
    userSnapshotPreserved: true,
  }));
}

main()
  .catch((error: unknown) => {
    console.error('drop-users-is-dummy failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
