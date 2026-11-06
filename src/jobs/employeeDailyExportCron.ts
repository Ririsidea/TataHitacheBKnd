import cron from 'node-cron';
import { previousDateInIST, runDailyAdminExport } from '../services/orderExport.service';
import { errorMessage } from '../utils/errors';

export default function scheduleEmployeeDailyExport(): void {
  cron.schedule(
    '*/15 * * * *',
    async () => {
      try {
        await runDailyAdminExport(previousDateInIST());
      } catch (err: unknown) {
        console.error('[Admin Daily Export] Failed:', errorMessage(err));
      }
    },
    { timezone: 'Asia/Kolkata' }
  );

  // Process only yesterday once when the server starts.
  void runDailyAdminExport(previousDateInIST()).catch((err: unknown) => {
    console.error(`[Admin Daily Export] Startup failed for ${previousDateInIST()}:`, errorMessage(err));
  });
}