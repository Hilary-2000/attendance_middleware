/**
 * config.js
 * ─────────────────────────────────────────────────────────────
 * Module: Central Configuration Loader
 * Responsibility:
 *   • Load the .env file using dotenv
 *   • Validate that all required variables are present
 *   • Export a single frozen config object used by every module
 * ─────────────────────────────────────────────────────────────
 * Prerequisites:
 *   npm install dotenv
 * ─────────────────────────────────────────────────────────────
 */

import "dotenv/config";

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reads an env variable. Throws if it is required but missing.
 * @param {string}  key
 * @param {*}       [defaultValue]  – omit to make the variable required
 * @returns {string}
 */
function get(key, defaultValue) {
  const value = process.env[key];
  if (value !== undefined && value !== "") return value;
  if (defaultValue !== undefined) return String(defaultValue);
  throw new Error(`[config] Missing required environment variable: ${key}`);
}

/** Parse to integer, throw on NaN. */
function getInt(key, defaultValue) {
  const raw = get(key, defaultValue);
  const num = parseInt(raw, 10);
  if (isNaN(num)) throw new Error(`[config] ${key} must be an integer, got: "${raw}"`);
  return num;
}

/** Parse to boolean ("true" → true, anything else → false). */
function getBool(key, defaultValue) {
  const raw = get(key, defaultValue);
  return raw.toLowerCase() === "true";
}

/* ------------------------------------------------------------------ */
/*  Config object                                                       */
/* ------------------------------------------------------------------ */

const config = Object.freeze({

  /* ── 1. Hikvision Terminal ─────────────────────────────────────── */
  terminal: Object.freeze({
    host               : get    ("TERMINAL_HOST"),
    port               : getInt ("TERMINAL_PORT",                80),
    username           : get    ("TERMINAL_USERNAME"),
    password           : get    ("TERMINAL_PASSWORD"),
    useHttps           : getBool("TERMINAL_USE_HTTPS",           false),
    rejectUnauthorized : getBool("TERMINAL_REJECT_UNAUTHORIZED", false),
    pageSize           : getInt ("TERMINAL_PAGE_SIZE",           100),
    fetchAllPages      : getBool("TERMINAL_FETCH_ALL_PAGES",     true),
    deviceName         : get    ("TERMINAL_DEVICE_NAME"),
  }),

  /* ── 2. Cloud School System API ────────────────────────────────── */
  cloud: Object.freeze({
    schoolCode          : get    ("SCHOOL_CODE"),
    baseUrl             : get    ("CLOUD_API_BASE_URL"),
    apiKey              : get    ("CLOUD_API_KEY"),
    attendanceEndpoint  : get    ("CLOUD_ATTENDANCE_ENDPOINT",   "/attendance/sync"),
    timeoutMs           : getInt ("CLOUD_API_TIMEOUT_MS",        15000),
    batchSize           : getInt ("CLOUD_BATCH_SIZE",            50),
    retryAttempts       : getInt ("CLOUD_RETRY_ATTEMPTS",        3),
    retryDelayMs        : getInt ("CLOUD_RETRY_DELAY_MS",        2000),
  }),

  /* ── 3. Sync Scheduler ─────────────────────────────────────────── */
  sync: Object.freeze({
    cronSchedule    : get    ("SYNC_CRON_SCHEDULE",    "*/5 * * * *"),
    timezone        : get    ("SYNC_TIMEZONE",         "Africa/Nairobi"),
    lookbackMinutes : getInt ("SYNC_LOOKBACK_MINUTES", 10),
  }),

  /* ── 4. Local Queue / Offline Buffer ───────────────────────────── */
  queue: Object.freeze({
    filePath : get    ("QUEUE_FILE_PATH",  "./data/queue.json"),
    maxSize  : getInt ("QUEUE_MAX_SIZE",   5000),
  }),

  /* ── 5. Logging ────────────────────────────────────────────────── */
  logging: Object.freeze({
    level      : get    ("LOG_LEVEL",     "info"),
    dir        : get    ("LOG_DIR",       "./logs"),
    maxSize    : get    ("LOG_MAX_SIZE",  "10m"),
    maxFiles   : getInt ("LOG_MAX_FILES", 7),
  }),

  /* ── 6. Middleware Server ──────────────────────────────────────── */
  server: Object.freeze({
    port     : getInt ("SERVER_PORT", 3000),
    nodeEnv  : get    ("NODE_ENV",    "development"),
  }),

    /* ── 7. GitHub Auto-Updater ─────────────────────────────────────── */
  github: Object.freeze({
    repoUrl  : get    ("GITHUB_REPO_URL", ""),
    branch   : get    ("GITHUB_BRANCH",   "main"),
  }),

});

export default config;