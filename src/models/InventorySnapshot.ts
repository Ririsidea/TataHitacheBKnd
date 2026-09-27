import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';

export interface InventorySnapshotAttributes {
  id: number;
  inventoryItemId: string;
  locationId: string | null;
  available: number | null;
  updatedAt: Date;
}

export type InventorySnapshotCreationAttributes = Partial<InventorySnapshotAttributes> & { inventoryItemId: string };

export interface InventorySnapshotInstance
  extends Model<InventorySnapshotAttributes, InventorySnapshotCreationAttributes>,
    InventorySnapshotAttributes {}

const InventorySnapshot = sequelize.define<InventorySnapshotInstance>(
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

export default InventorySnapshot;
