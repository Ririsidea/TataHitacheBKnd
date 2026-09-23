const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const OrderLineItem = sequelize.define(
  'OrderLineItem',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    orderId: { type: DataTypes.INTEGER, allowNull: false, field: 'order_id' },
    sku: { type: DataTypes.STRING(255) },
    title: { type: DataTypes.STRING(500) },
    quantity: { type: DataTypes.INTEGER },
    price: { type: DataTypes.DECIMAL(10, 2) },
  },
  {
    tableName: 'order_line_items',
    underscored: true,
    timestamps: false,
    indexes: [{ fields: ['order_id'] }],
  }
);

module.exports = OrderLineItem;
