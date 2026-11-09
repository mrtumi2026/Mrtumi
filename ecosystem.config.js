'use strict';

/**
 * PM2 Enterprise Process Manager Configuration
 * ============================================
 * Optimized for multi-core high-throughput e-commerce workloads in production.
 *
 * Usage:
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload ecosystem.config.js --update-env
 *   pm2 stop ecosystem.config.js
 *   pm2 logs mrtumi-marketplace
 */

module.exports = {
  apps: [
    {
      name: 'mrtumi-marketplace',
      script: './app.js',
      instances: process.env.PM2_INSTANCES || 'max',
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '500M',
      autorestart: true,
      restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      listen_timeout: 8000,
      exp_backoff_restart_delay: 100,

      // Zero-downtime rolling reload settings
      wait_ready: false,

      // Log configuration
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',

      // Environment overrides
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
        APP_ALLOW_TEST_STARTUP: 'false',
      },
      env_staging: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
      },
    },
  ],
};
