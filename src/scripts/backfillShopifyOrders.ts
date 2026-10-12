import { QueryTypes } from 'sequelize';
import { sequelize } from '../config/db';
import '../models';
import { backfillMissingMapOrders } from '../services/shopifyOrderBackfill.service';

async function main(): Promise<void> {
  try {
    await sequelize.authenticate();
    const [database] = await sequelize.query<{ name: string | null }>('SELECT DATABASE() AS name', {
      type: QueryTypes.SELECT,
    });
    const result = await backfillMissingMapOrders();
    console.log(JSON.stringify({ database: database?.name ?? null, ...result }));
  } catch (err) {
    console.error('[shopify-backfill] failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

void main();
