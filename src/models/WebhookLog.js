const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const WebhookLog = sequelize.define(
  'WebhookLog',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    topic: { type: DataTypes.STRING(255), allowNull: false },
    payload: { type: DataTypes.JSON },
    verified: { type: DataTypes.BOOLEAN, defaultValue: false },
    receivedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'received_at' },
  },
  {
    tableName: 'webhook_logs',
    underscored: true,
    timestamps: false,
    indexes: [{ fields: ['topic'] }, { fields: ['received_at'] }],
  }
);

module.exports = WebhookLog;
