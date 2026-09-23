const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

// One row per employee per calendar day of exported orders - the index behind
// the "Employee Orders" export-history page. The file itself lives on disk
// (see sap.controller.js); this table just tracks which day it covers, how
// many orders it had, and who it belongs to.
const DailyExport = sequelize.define(
  'DailyExport',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    employeeEmail: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'employee_email',
      set(value) {
        this.setDataValue('employeeEmail', String(value).trim().toLowerCase());
      },
    },
    exportDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'export_date' },
    orderCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'order_count' },
    fileName: { type: DataTypes.STRING(255), allowNull: false, field: 'file_name' },
  },
  {
    tableName: 'daily_exports',
    underscored: true,
    indexes: [{ unique: true, fields: ['employee_email', 'export_date'] }],
  }
);

module.exports = DailyExport;
