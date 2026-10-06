import { Sequelize } from 'sequelize';
import { mysql } from './env';

// TEMPORARY (perf analysis task) - set PERF_DEBUG=1 to log every SQL query's duration.
// Remove this whole PERF_DEBUG branch (and the ones in app.ts / services/shopify/client.ts)
// once the analysis is done, or leave it - it's a no-op unless the env var is set.
const perfDebug = process.env.PERF_DEBUG === '1';

export const sequelize = new Sequelize(mysql.database, mysql.user, mysql.password, {
  host: mysql.host,
  port: mysql.port,
  dialect: 'mysql',
  logging: perfDebug ? (sql: string, timing?: number) => console.log(`[perf][sql] ${Math.round(timing || 0)}ms`, sql.replace(/\s+/g, ' ').slice(0, 200)) : false,
  benchmark: perfDebug,
});

export default async function connectDB(): Promise<void> {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected');
  } catch (err) {
    console.error('MySQL connect failed:', err instanceof Error ? err.message : err);
    throw err;
  }
}
