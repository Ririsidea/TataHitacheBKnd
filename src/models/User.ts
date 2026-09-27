import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';

export interface UserAttributes {
  id: number;
  email: string;
  name: string | null;
  phone: string | null;
  passwordHash: string;
  mustResetPassword: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type UserCreationAttributes = Partial<UserAttributes> & { email: string; passwordHash: string };

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
