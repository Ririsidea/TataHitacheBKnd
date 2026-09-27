import axios from 'axios';
import { alert } from '../config/env';

// "Log + alert" for server-side failures a client cannot fix (misconfiguration, unexpected errors).
// Every alert is written to the log as an [ALERT] line. If ALERT_WEBHOOK_URL is set (a Slack-style
// incoming webhook that takes { text }), it is also posted there - at most once a minute per `key`,
// so a failing dependency cannot flood the channel. Only the title and the requestId are sent:
// never a stack trace, request data or a secret.
export const THROTTLE_MS = 60 * 1000;
const lastSent = new Map<string, number>();

export interface AlertInput {
  key: string;
  title: string;
  requestId?: string;
  detail?: string;
}

export async function alertServerError({ key, title, requestId, detail }: AlertInput): Promise<void> {
  console.error(`[ALERT] ${title} (requestId ${requestId || '-'})`, detail || '');
  if (!alert.webhookUrl) return;

  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < THROTTLE_MS) return;
  lastSent.set(key, now);
  try {
    await axios.post(alert.webhookUrl, { text: `[THCM MAP] ${title} (requestId ${requestId || '-'})` }, { timeout: 5000 });
  } catch (err) {
    console.error('[alert] could not deliver the alert:', err instanceof Error ? err.message : err);
  }
}
