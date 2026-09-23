const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const User = sequelize.define(
  'User',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      set(value) {
        this.setDataValue('email', String(value).trim().toLowerCase());
      },
    },
    name: { type: DataTypes.STRING(255) },
    phone: { type: DataTypes.STRING(30) },
    // Never a plain `password` column - only the bcrypt hash is ever persisted.
    passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
    mustResetPassword: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'must_reset_password',
    },
  },
  {
    tableName: 'users',
    underscored: true,
    timestamps: true,
  }
);

module.exports = User;
