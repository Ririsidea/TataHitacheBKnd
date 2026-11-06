import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';

// "All employees, one day" admin exports, tracked separately from DailyExport (which is scoped
// to one employee). New consolidated workbooks are stored as private Cloudinary raw files.
export interface AdminDailyExportAttributes {
  id: number;
  // A DATEONLY column: "YYYY-MM-DD". One row per day, ever - never regenerated once it exists
  // unless the manual command is run with --force.
  exportDate: string;
  orderCount: number;
  fileName: string;
  storageProvider: string;
  cloudinaryPublicId: string | null;
  cloudinaryResourceType: string | null;
  cloudinaryType: string | null;
  cloudinaryVersion: number | null;
  cloudinaryBytes: number | null;
  cloudinaryFormat: string | null;
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
    storageProvider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'local', field: 'storage_provider' },
    cloudinaryPublicId: { type: DataTypes.STRING(500), allowNull: true, field: 'cloudinary_public_id' },
    cloudinaryResourceType: { type: DataTypes.STRING(32), allowNull: true, field: 'cloudinary_resource_type' },
    cloudinaryType: { type: DataTypes.STRING(32), allowNull: true, field: 'cloudinary_type' },
    cloudinaryVersion: { type: DataTypes.BIGINT, allowNull: true, field: 'cloudinary_version' },
    cloudinaryBytes: { type: DataTypes.BIGINT, allowNull: true, field: 'cloudinary_bytes' },
    cloudinaryFormat: { type: DataTypes.STRING(32), allowNull: true, field: 'cloudinary_format' },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    tableName: 'admin_daily_exports',
    underscored: true,
  }
);

export default AdminDailyExport;
