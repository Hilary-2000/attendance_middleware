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

    /* ── 1. Main middleware (runs every hour) ───────────────────
     * Cron format: "minute hour day month weekday"
     *   "0 * * * *"  = top of every hour  (00:00, 01:00, 02:00 …)
     *   "0 6-18 * * *" = every hour between 6AM and 6PM only
     *   "*\/30 * * * *" = every 30 minutes
     * ──────────────────────────────────────────────────────── */
    {
      name        : "hikvision-middleware",
      script      : "index.js",
      interpreter : "node",
      cron_restart: "*/5 * * * *",    // ← (post attendance information) runs every 5 minutes
      watch       : false,
      autorestart : false,          // only run on cron schedule, not on exit
      windowsHide : true,           // ← hide terminal popups on Windows
      env: {
        NODE_ENV: "production",
      },
      out_file    : "./logs/middleware-out.log",
      error_file  : "./logs/middleware-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },

    /* ── 2. Device person sync (runs every 2 hours) ────────────
     * Cron: "0 *\/2 * * *" = at minute 0 of every 2nd hour
     *   00:00, 02:00, 04:00, 06:00 … 22:00  (12 times per day)
     * ──────────────────────────────────────────────────────── */
    {
      name        : "hikvision-device-sync",
      script      : "Devicesync.js",
      interpreter : "node",
      cron_restart: "*/10 * * * *",     // (Sync gadgets with the student and staff details)run every 10 minutes
      watch       : false,
      autorestart : false,
      windowsHide : true,
      env: {
        NODE_ENV: "production",
      },
      out_file    : "./logs/device-sync-out.log",
      error_file  : "./logs/device-sync-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },

    /* ── 3. Daily updater (runs once at 09:30 every morning) ─── */
    {
      name        : "hikvision-updater",
      script      : "updater.js",
      interpreter : "node",
      cron_restart: "30 9 * * *", // updates code everyday at 9:30AM
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
