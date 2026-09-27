import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../config/db';

export interface WebhookLogAttributes {
  id: number;
  topic: string;
  payload: unknown;
  verified: boolean;
  receivedAt: Date;
}

export type WebhookLogCreationAttributes = Partial<WebhookLogAttributes> & { topic: string };

export interface WebhookLogInstance
  extends Model<WebhookLogAttributes, WebhookLogCreationAttributes>,
    WebhookLogAttributes {}

const WebhookLog = sequelize.define<WebhookLogInstance>(
  'WebhookLog',
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    topic: { type: DataTypes.STRING(255), allowNull: false },
    payload: { type: DataTypes.JSON },
    verified: { type: DataTypes.BOOLEAN, defaultValue: false },
    receivedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'received_at' },
  },
  {
    tableName: 'webhook_logs',
    underscored: true,
    timestamps: false,
    indexes: [{ fields: ['topic'] }, { fields: ['received_at'] }],
  }
);

export default WebhookLog;
