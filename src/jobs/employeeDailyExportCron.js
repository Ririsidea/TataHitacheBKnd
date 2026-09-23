const cron = require('node-cron');
const { runDailyEmployeeExports } = require('../controllers/sap.controller');

// Separate from - and does not touch - the existing 8 PM all-employees SAP
// hand-off cron (sapExportCron.js). Runs once daily at 00:05 server time and
// exports the PREVIOUS full calendar day (00:00-23:59), which is guaranteed to
// be complete by the time this runs. A day with zero orders still gets a
// recorded (0-order) export for every employee - that is expected, not an error.
function scheduleEmployeeDailyExport() {
  cron.schedule('* * * * *', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    try {
      const result = await runDailyEmployeeExports(yesterday);
      console.log(
        `[Employee Daily Export] ${result.exportDate}: ${result.created} created, ` +
          `${result.skipped} already existed, ${result.failed} failed (of ${result.totalEmployees} employees)`
      );
    } catch (err) {
      console.error('[Employee Daily Export] Failed to run:', err.message);
    }
  });
}

module.exports = scheduleEmployeeDailyExport;
