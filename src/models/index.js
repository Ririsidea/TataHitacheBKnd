const Order = require('./Order');
const OrderLineItem = require('./OrderLineItem');
const WebhookLog = require('./WebhookLog');
const InventorySnapshot = require('./InventorySnapshot');
const User = require('./User');
const DailyExport = require('./DailyExport');

Order.hasMany(OrderLineItem, { as: 'lineItems', foreignKey: 'orderId', onDelete: 'CASCADE' });
OrderLineItem.belongsTo(Order, { foreignKey: 'orderId' });

module.exports = { Order, OrderLineItem, WebhookLog, InventorySnapshot, User, DailyExport };
