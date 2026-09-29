import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';
import { EMPLOYEE_ID_PATTERN } from '../utils/employeeId';

export interface UserAttributes {
  id: number;
  email: string;
  employeeId: string;
  name: string | null;
  phone: string | null;
  passwordHash: string;
  mustResetPassword: boolean;
  // Bumped whenever an admin changes this user's password, so JWTs signed before the
  // bump stop working (see middleware/authenticate.ts).
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export type UserCreationAttributes = Partial<UserAttributes> & { email: string; employeeId: string; passwordHash: string };

export interface UserInstance extends Model<UserAttributes, UserCreationAttributes>, UserAttributes {}

const User = sequelize.define<UserInstance>(
  'User',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      set(this: UserInstance, value: unknown) {
        this.setDataValue('email', String(value).trim().toLowerCase());
      },
    },
    employeeId: {
      type: DataTypes.STRING(5),
      allowNull: false,
      unique: true,
      field: 'employee_id',
      validate: { is: EMPLOYEE_ID_PATTERN },
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
    tokenVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'token_version',
    },
    createdAt: { type: DataTypes.DATE, field: 'created_at' },
    updatedAt: { type: DataTypes.DATE, field: 'updated_at' },
  },
  {
    tableName: 'users',
    underscored: true,
    timestamps: true,
  }
);

export default User;
