// ecosystem.config.cjs
// ─────────────────────────────────────────────────────────────
// PM2 Ecosystem Configuration
// Manages both the main middleware and the daily updater.
//
// Commands:
//   pm2 start ecosystem.config.cjs     — start everything
//   pm2 stop all                        — stop everything
//   pm2 restart all                     — restart everything
//   pm2 logs                            — view live logs
//   pm2 status                          — check running status
//   pm2 save                            — save process list
//   pm2 startup                         — auto-start on Windows boot
// ─────────────────────────────────────────────────────────────

module.exports = {
  apps: [

    /* ── 1. Main middleware (runs continuously) ──────────────── */
    {
      name        : "hikvision-middleware",
      script      : "index.js",
      interpreter : "node",
      // Cron expression: minute hour day month weekday
      // "every day every hour from 6AM TO 8PM"
      cron_restart: "0 6-20 * * *",
      watch       : false,          // set true to auto-restart on file change
      autorestart : false,           // do not auto-restart
      windowsHide : true,           // ← hide terminal popups on Windows
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
      },
      // Log files
      out_file    : "./logs/middleware-out.log",
      error_file  : "./logs/middleware-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },

    /* ── 2. Daily updater (runs once at 09:30 every morning) ─── */
    {
      name        : "hikvision-updater",
      script      : "updater.js",
      interpreter : "node",
      // Cron expression: minute hour day month weekday
      // "30 9 * * *" = every day at 09:30 AM
      cron_restart: "30 9 * * *",
      watch       : false,
      autorestart : false,          // don't auto-restart — only run on schedule
      windowsHide : true,           // ← hide terminal popups on Windows
      env: {
        NODE_ENV: "production",
      },
      out_file    : "./logs/updater-out.log",
      error_file  : "./logs/updater-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },

  ],
};
