import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';

export interface DailyExportAttributes {
  id: number;
  employeeEmail: string;
  // A DATEONLY column: "YYYY-MM-DD".
  exportDate: string;
  orderCount: number;
  fileName: string;
  createdAt: Date;
  updatedAt: Date;
}

export type DailyExportCreationAttributes = Partial<DailyExportAttributes> & {
  employeeEmail: string;
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
    employeeEmail: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'employee_email',
      set(this: DailyExportInstance, value: unknown) {
        this.setDataValue('employeeEmail', String(value).trim().toLowerCase());
      },
    },
    exportDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'export_date' },
    orderCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'order_count' },
    fileName: { type: DataTypes.STRING(255), allowNull: false, field: 'file_name' },
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
