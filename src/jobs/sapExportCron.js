const cron = require('node-cron');
const { generateDailyExport } = require('../controllers/sap.controller');

// Runs once a day at 20:00 server time so the file is ready for SAP's
// nightly batch pickup.
function scheduleSapExport() {
  cron.schedule('0 20 * * *', async () => {
    try {
      const { filePath, count } = await generateDailyExport();
      console.log(`[SAP Export] Generated ${filePath} with ${count} order(s)`);
    } catch (err) {
      console.error('[SAP Export] Failed to generate daily export:', err.message);
    }
  });
}

module.exports = scheduleSapExport;
