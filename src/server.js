import { env } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { processDeliveryQueue, settleBackgroundWork } from './modules/notifications/notification.service.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

async function main() {
  await connectDB();
  const app = createApp();
  // Deliver notifications queued before a restart.
  processDeliveryQueue().catch((err) => logger.error({ err }, 'Notification delivery failed'));
  if (env.jobsEnabled) startScheduler();
  const server = app.listen(env.PORT, () => logger.info(`API listening on http://localhost:${env.PORT}/api/v1 (${env.NODE_ENV})`));

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    server.close(async () => {
      await settleBackgroundWork();
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
