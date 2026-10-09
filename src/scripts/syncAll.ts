import { sequelize } from '../config/db';
import '../models';

async function main(): Promise<void> {
  try {
    await sequelize.authenticate();
    console.log('[syncAll] MySQL connected');
    // Deliberately omit force and alter: this creates missing model tables only.
    await sequelize.sync();
    console.log('[syncAll] Missing model tables created; existing tables were preserved');
  } catch (error) {
    console.error('[syncAll] Failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

void main();
