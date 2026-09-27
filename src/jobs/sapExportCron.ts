import cron from 'node-cron';
import { generateDailyExport } from '../services/orderExport.service';
import { errorMessage } from '../utils/errors';

// Runs once a day at 20:00 server time so the file is ready for SAP's
// nightly batch pickup.
export default function scheduleSapExport(): void {
  cron.schedule('0 20 * * *', async () => {
    try {
      const { filePath, count } = await generateDailyExport();
      console.log(`[SAP Export] Generated ${filePath} with ${count} order(s)`);
    } catch (err) {
      console.error('[SAP Export] Failed to generate daily export:', errorMessage(err));
    }
  });
}
