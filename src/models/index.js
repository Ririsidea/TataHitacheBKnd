const Order = require('./Order');
const OrderLineItem = require('./OrderLineItem');
const WebhookLog = require('./WebhookLog');
const InventorySnapshot = require('./InventorySnapshot');
const User = require('./User');
const DailyExport = require('./DailyExport');
const { attachOrderHooks } = require('../services/orderEvents');

Order.hasMany(OrderLineItem, { as: 'lineItems', foreignKey: 'orderId', onDelete: 'CASCADE' });
OrderLineItem.belongsTo(Order, { foreignKey: 'orderId' });

// Every order write is announced to the live (SSE) clients - see services/orderEvents.js.
attachOrderHooks(Order);

module.exports = { Order, OrderLineItem, WebhookLog, InventorySnapshot, User, DailyExport };
