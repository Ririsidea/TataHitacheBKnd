import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';

export interface DailyExportAttributes {
  id: number;
  // The employee the export belongs to (column employee_email).
  email: string;
  // A DATEONLY column: "YYYY-MM-DD".
  exportDate: string;
  orderCount: number;
  fileName: string;
  employeeId: string | null;
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

export type DailyExportCreationAttributes = Partial<DailyExportAttributes> & {
  email: string;
  exportDate: string;
  fileName: string;
};

export interface DailyExportInstance
  extends Model<DailyExportAttributes, DailyExportCreationAttributes>,
    DailyExportAttributes {}

// One row per employee per calendar day of exported orders - the index behind
// the "Employee Orders" export-history page. The file itself lives on disk
// (written by services/orderExport.service.ts); this table just tracks which day it covers, how
// many orders it had, and who it belongs to.
const DailyExport = sequelize.define<DailyExportInstance>(
  'DailyExport',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'employee_email',
      set(this: DailyExportInstance, value: unknown) {
        this.setDataValue('email', String(value).trim().toLowerCase());
      },
    },
    exportDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'export_date' },
    orderCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'order_count' },
    fileName: { type: DataTypes.STRING(255), allowNull: false, field: 'file_name' },
    employeeId: { type: DataTypes.STRING(100), allowNull: true, field: 'employee_id' },
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
    tableName: 'daily_exports',
    underscored: true,
    indexes: [{ unique: true, fields: ['employee_email', 'export_date'] }],
  }
);

export default DailyExport;
