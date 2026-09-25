const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const Order = sequelize.define(
  'Order',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    shopifyOrderId: { type: DataTypes.STRING(255), unique: true, field: 'shopify_order_id' },
    employeeName: { type: DataTypes.STRING(255), field: 'employee_name' },
    employeeEmail: { type: DataTypes.STRING(255), field: 'employee_email' },
    employeePhone: { type: DataTypes.STRING(30), field: 'employee_phone' },
    status: { type: DataTypes.STRING(50), defaultValue: 'open' },
    financialStatus: { type: DataTypes.STRING(50), field: 'financial_status' },
    fulfillmentStatus: { type: DataTypes.STRING(50), field: 'fulfillment_status' },
    deliveryStatus: { type: DataTypes.STRING(50), field: 'delivery_status' },
    closedAt: { type: DataTypes.DATE, field: 'closed_at' },
    totalPrice: { type: DataTypes.DECIMAL(10, 2), field: 'total_price' },
    trackingNumber: { type: DataTypes.STRING(255), field: 'tracking_number' },
    trackingUrl: { type: DataTypes.STRING(1000), field: 'tracking_url' },
    carrier: { type: DataTypes.STRING(255) },
    channel: { type: DataTypes.STRING(50) },
  },
  {
    tableName: 'orders',
    underscored: true,
  }
);

module.exports = Order;
