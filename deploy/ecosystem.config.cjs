/**
 * PM2 process file for the School ERP API.
 *
 *   pm2 start deploy/ecosystem.config.cjs --env production
 *   pm2 reload school-erp-api          # zero-downtime restart after a deploy
 *
 * Cluster mode runs one API process per CPU core (set API_INSTANCES to override). Only instance 0
 * runs the scheduler (late fees, fee reminders, scheduled announcements, delivery retries); see
 * src/server.js. All configuration comes from the .env file in the backend folder.
 */
module.exports = {
  apps: [
    {
      name: 'school-erp-api',
      cwd: __dirname + '/..',
      script: 'src/server.js',
      exec_mode: 'cluster',
      instances: process.env.API_INSTANCES || 'max',
      // Gives in-flight requests and queued notifications time to finish (server.js waits up to 10 s).
      kill_timeout: 12000,
      listen_timeout: 15000,
      max_memory_restart: '600M',
      exp_backoff_restart_delay: 200,
      merge_logs: true,
      time: true,
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
