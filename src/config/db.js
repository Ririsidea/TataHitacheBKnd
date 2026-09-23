const { Sequelize } = require('sequelize');
const { mysql } = require('./env');

const sequelize = new Sequelize(mysql.database, mysql.user, mysql.password, {
  host: mysql.host,
  port: mysql.port,
  dialect: 'mysql',
  logging: false,
});

async function connectDB() {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected');
  } catch (err) {
    console.error('MySQL connect failed:', err.message);
    throw err;
  }
}

module.exports = connectDB;
module.exports.sequelize = sequelize;
