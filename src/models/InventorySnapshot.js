const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const InventorySnapshot = sequelize.define(
  'InventorySnapshot',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    inventoryItemId: { type: DataTypes.STRING(255), allowNull: false, field: 'inventory_item_id' },
    locationId: { type: DataTypes.STRING(255), field: 'location_id' },
    available: { type: DataTypes.INTEGER },
    updatedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'updated_at' },
  },
  {
    tableName: 'inventory_snapshots',
    underscored: true,
    timestamps: false,
    indexes: [{ unique: true, fields: ['inventory_item_id', 'location_id'] }],
  }
);

module.exports = InventorySnapshot;
