const app = require('./app');
const { port, nodeEnv } = require('./config/env');
const connectDB = require('./config/db');
const scheduleSapExport = require('./jobs/sapExportCron');
const scheduleEmployeeDailyExport = require('./jobs/employeeDailyExportCron');

async function start() {
  await connectDB();
  scheduleSapExport();
  scheduleEmployeeDailyExport();

  app.listen(port, () => {
    console.log(`Server running in ${nodeEnv} mode on port ${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
