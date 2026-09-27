import { Sequelize } from 'sequelize';
import { mysql } from './env';

export const sequelize = new Sequelize(mysql.database, mysql.user, mysql.password, {
  host: mysql.host,
  port: mysql.port,
  dialect: 'mysql',
  logging: false,
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
