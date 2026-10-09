import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';
import { EMPLOYEE_ID_PATTERN } from '../utils/employeeId';
import { TICKET_ID_PATTERN } from '../utils/ticketId';

// The two roles an account can have. Not used to gate admin access today (see
// middleware/requireAdmin.ts, which compares the signed-in email against ADMIN_EMAIL) -
// this is stored for future use and to match the live database.
export type UserRole = 'admin' | 'employee';

export interface UserAttributes {
  // Internal primary key - never exposed as a lookup key to API callers.
  id: number;
  // Login identifier; always stored trimmed and lower-case (see the `set` hook below).
  email: string;
  // 5-digit login id, the other way an employee can log in besides email.
  employeeId: string;
  // Optional 5-digit login id, a third way to log in besides email/employeeId. Same
  // format as employeeId by coincidence only - the two are never cross-checked, so the
  // same digits can be one user's employeeId and a different user's ticketId. null means
  // this account has none; multiple users may each have a null ticketId at once (the
  // unique index on this column allows that - see config/ensureSchema.ts).
  ticketId: string | null;
  // Display name, optional.
  name: string | null;
  // Mobile number, kept as free text (not a number type) so a leading zero, a "+91"
  // prefix or spaces are preserved exactly as entered.
  phone: string | null;
  // bcrypt hash only - a plain-text password is never stored.
  passwordHash: string;
  // 'admin' or 'employee'. Stored for completeness; not yet read by any access check.
  role: UserRole;
  // true until the employee sets their own password (after account creation or an
  // admin-assigned password); the frontend uses this to decide whether to prompt a change.
  mustResetPassword: boolean;
  // true only for the fake employees made by `npm run seed:employees`. The seed / clean / rename-domain
  // scripts and any mail code use this flag - never the email domain - to tell dummy users from real ones.
  isDummy: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type UserCreationAttributes = Partial<UserAttributes> & { email: string; employeeId: string; passwordHash: string };

export interface UserInstance extends Model<UserAttributes, UserCreationAttributes>, UserAttributes {}

const User = sequelize.define<UserInstance>(
  'User',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // Trimmed and lower-cased on every write, so lookups never have to normalise it again.
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      set(this: UserInstance, value: unknown) {
        this.setDataValue('email', String(value).trim().toLowerCase());
      },
    },
    // 5-digit login id; format enforced by EMPLOYEE_ID_PATTERN.
    employeeId: {
      type: DataTypes.STRING(5),
      allowNull: false,
      unique: true,
      field: 'employee_id',
      validate: { is: EMPLOYEE_ID_PATTERN },
    },
    // Optional 5-digit login id; null is allowed and does not collide with other nulls
    // (a plain UNIQUE index permits any number of NULLs in MySQL). Format is only
    // checked when a value is actually set - an absent ticketId is valid.
    ticketId: {
      type: DataTypes.STRING(5),
      allowNull: true,
      unique: true,
      field: 'ticket_id',
      validate: {
        isValidFormatOrNull(value: string | null) {
          if (value !== null && value !== undefined && !TICKET_ID_PATTERN.test(value)) {
            throw new Error('Validation error: ticketId must be exactly 5 digits');
          }
        },
      },
    },
    name: { type: DataTypes.STRING(255) },
    // Text, not a number type - see the UserAttributes comment above.
    phone: { type: DataTypes.STRING(30) },
    // Never a plain `password` column - only the bcrypt hash is ever persisted.
    passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
    // Matches the ENUM already in the database; defaults new rows to 'employee'.
    role: {
      type: DataTypes.ENUM('admin', 'employee'),
      allowNull: false,
      defaultValue: 'employee',
    },
    mustResetPassword: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'must_reset_password',
    },
    isDummy: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_dummy',
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
