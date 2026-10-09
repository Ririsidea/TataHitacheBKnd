
import cron from 'node-cron';
import { runDailyEmployeeExports } from '../services/orderExport.service';
import { errorMessage } from '../utils/errors';

function currentDateInIST(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export default function scheduleEmployeeDailyExport(): void {
  cron.schedule(
    '*/5 * * * *',
    async () => {
      const exportDate = currentDateInIST();

      try {
        const result = await runDailyEmployeeExports(exportDate);

        console.log(
          `[Employee Daily Export] ${result.exportDate}: ` +
            `${result.created} created, ` +
            `${result.skipped} already existed, ` +
            `${result.noOrders} had no orders, ` +
            `${result.excludedOrders} excluded, ` +
            `${result.failed} failed ` +
            `(of ${result.totalEmployees} employees)`
        );
      } catch (err: unknown) {
        console.error(
          '[Employee Daily Export] Failed:',
          errorMessage(err)
        );
      }
    },
    { timezone: 'Asia/Kolkata' }
  );
}