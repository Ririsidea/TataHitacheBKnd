import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';

// Historical "all employees, one day" exports, tracked separately from DailyExport (which is
// scoped to one employee). New consolidated workbooks are no longer generated.
export interface AdminDailyExportAttributes {
  id: number;
  // A DATEONLY column: "YYYY-MM-DD". One row per day, ever - never regenerated once it exists.
  exportDate: string;
  orderCount: number;
  fileName: string;
  createdAt: Date;
  updatedAt: Date;
}

export type AdminDailyExportCreationAttributes = Partial<AdminDailyExportAttributes> & {
  exportDate: string;
  fileName: string;
};

export interface AdminDailyExportInstance
  extends Model<AdminDailyExportAttributes, AdminDailyExportCreationAttributes>,
    AdminDailyExportAttributes {}

const AdminDailyExport = sequelize.define<AdminDailyExportInstance>(
  'AdminDailyExport',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    exportDate: { type: DataTypes.DATEONLY, allowNull: false, unique: true, field: 'export_date' },
    orderCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'order_count' },
    fileName: { type: DataTypes.STRING(255), allowNull: false, field: 'file_name' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    tableName: 'admin_daily_exports',
    underscored: true,
  }
);

export default AdminDailyExport;
