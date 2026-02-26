/**
 * attendanceProcessor.js
 * ─────────────────────────────────────────────────────────────
 * Module: Attendance Processor & Cloud Sync
 * Responsibility:
 *   • Filter out records with no student ID
 *   • Collapse multiple events per student into one record:
 *       – First event of the day           → time_in
 *       – Any event at/after TIMEOUT_HOUR  → time_out
 *   • Format times as HH:MM:SS (24-hr)
 *   • POST the processed array to the Cloud School System API
 *   • Retry on transient failures
 * ─────────────────────────────────────────────────────────────
 */

import axios from "axios";
import config from "./config.js";

/* ================================================================== */
/*  Constants                                                           */
/* ================================================================== */

/**
 * Hour (24-hr, local time) at or after which an event is treated
 * as a TIME-OUT instead of a time-in.
 * 14 = 2:00 PM.  Change via TIMEOUT_HOUR in .env if needed.
 */
const TIMEOUT_HOUR = parseInt(process.env.TIMEOUT_HOUR ?? "14", 10);

/**
 * Minute within that hour.  30 = :30, so the boundary is 14:30.
 * Change via TIMEOUT_MINUTE in .env if needed.
 */
const TIMEOUT_MINUTE = parseInt(process.env.TIMEOUT_MINUTE ?? "30", 10);

/* ================================================================== */
/*  Time helpers                                                        */
/* ================================================================== */

/**
 * Parse any ISO-8601-like string the Hikvision device returns and
 * extract hour + minute + second as numbers.
 *
 * Supported formats from DS-K1T342MFX-E1:
 *   "2024-11-20T14:35:07"
 *   "2024-11-20T14:35:07+03:00"
 *   "2024-11-20T14:35:07Z"
 *
 * We strip the timezone and use the device's local time directly
 * (the device clock should be set to your local timezone).
 *
 * @param {string} isoString
 * @returns {{ h: number, m: number, s: number, raw: string } | null}
 */
function parseDeviceTime(isoString) {
  if (!isoString) return null;

  // Strip timezone offset or Z, keep local part
  const local = isoString.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");

  // Expected: "YYYY-MM-DDTHH:MM:SS"
  const match = local.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;

  return {
    h  : parseInt(match[1], 10),
    m  : parseInt(match[2], 10),
    s  : parseInt(match[3], 10),
    raw: `${match[1]}:${match[2]}:${match[3]}`,  // "HH:MM:SS"
  };
}

/**
 * Returns true when the parsed time is at or after the configured
 * timeout boundary (default 14:30).
 *
 * @param {{ h: number, m: number }} t
 * @returns {boolean}
 */
function isTimeOut(t) {
  if (t.h > TIMEOUT_HOUR)  return true;
  if (t.h === TIMEOUT_HOUR && t.m >= TIMEOUT_MINUTE) return true;
  return false;
}

/**
 * Compare two "HH:MM:SS" strings chronologically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareTimeStrings(a, b) {
  return a.localeCompare(b); // lexicographic works for "HH:MM:SS"
}

/* ================================================================== */
/*  Core: process raw attendance records                                */
/* ================================================================== */

/**
 * Transform an array of raw AttendanceRecords from the terminal into
 * a clean array of ProcessedAttendance objects ready for the cloud API.
 *
 * Rules applied:
 *  1. Skip any record whose employeeNo is empty / null / "0".
 *  2. Per student, find the chronologically FIRST event → time_in.
 *  3. Per student, find the chronologically LAST event at or after
 *     TIMEOUT_HOUR:TIMEOUT_MINUTE → time_out (if such an event exists).
 *  4. A student who only has pre-timeout events gets time_in only.
 *
 * @param {import('./hikvisionClient.js').AttendanceRecord[]} records
 * @returns {ProcessedAttendance[]}
 */
export function processAttendance(records) {
  // ── 1. Filter: must have a valid student ID ─────────────────────
  const valid = records.filter((r) => {
    const id = (r.employeeNo ?? "").trim();
    return id !== "" && id !== "0";
  });

  console.log(
    `  Processing: ${records.length} raw event(s), ` +
    `${records.length - valid.length} skipped (no ID), ` +
    `${valid.length} retained.`
  );

  // ── 2. Group by employeeNo ──────────────────────────────────────
  /** @type {Map<string, import('./hikvisionClient.js').AttendanceRecord[]>} */
  const byStudent = new Map();

  for (const r of valid) {
    const id = r.employeeNo.trim();
    if (!byStudent.has(id)) byStudent.set(id, []);
    byStudent.get(id).push(r);
  }

  // ── 3. Collapse each student's events into one record ───────────
  /** @type {ProcessedAttendance[]} */
  const processed = [];

  for (const [adm_no, events] of byStudent) {
    // Sort all events chronologically
    const sorted = events
      .map((e) => ({ event: e, time: parseDeviceTime(e.eventTime) }))
      .filter((x) => x.time !== null)
      .sort((a, b) => compareTimeStrings(a.time.raw, b.time.raw));

    if (sorted.length === 0) continue;

    // Earliest event → time_in
    const timeIn = sorted[0].time.raw;

    // Filter to scans at or after the threshold, take the LAST one → time_out
    const postThreshold = sorted.filter((x) => isTimeOut(x.time));
    const timeOut = postThreshold.length > 0
      ? postThreshold[postThreshold.length - 1].time.raw
      : null;

    /** @type {ProcessedAttendance} */
    const entry = {
      adm_no,
      time_in: timeIn,
      ...(timeOut !== null && { time_out: timeOut }),
    };

    processed.push(entry);
  }

  return processed;
}

/* ================================================================== */
/*  Cloud sync                                                          */
/* ================================================================== */

/**
 * POST the processed attendance array to the Cloud School System API.
 *
 * Endpoint (from config):  CLOUD_API_BASE_URL + CLOUD_ATTENDANCE_ENDPOINT
 * Payload shape:
 * {
 *   "date"      : "2024-11-20",
 *   "attendance": [
 *     { "adm_no": "HYP001", "time_in": "07:45:00" },
 *     { "adm_no": "HYP002", "time_in": "08:10:22", "time_out": "14:35:07" }
 *   ]
 * }
 *
 * @param {ProcessedAttendance[]} attendance – output of processAttendance()
 * @param {string}                date       – "YYYY-MM-DD"
 * @returns {Promise<{ success: boolean, sent: number, response: any }>}
 */
export async function syncToCloud(attendance, date) {
  if (attendance.length === 0) {
    console.log("  No processed records to sync — skipping cloud POST.");
    return { success: true, sent: 0, response: null };
  }

  const url     = `${config.cloud.baseUrl}${config.cloud.attendanceEndpoint}`;
  const payload = {
    school_code: config.cloud.schoolCode,
    date,
    attendance,
  };

  console.log(`\n▶ Syncing ${attendance.length} record(s) to cloud …`);
  console.log(`  Endpoint: POST ${url}`);

  let lastError;

  // ── Retry loop ──────────────────────────────────────────────────
  for (let attempt = 1; attempt <= config.cloud.retryAttempts; attempt++) {
    try {
      const res = await axios.post(url, payload, {
        timeout: config.cloud.timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.cloud.apiKey}`,
          "X-Source"     : "hikvision-middleware",
        },
      });

      console.log(`  ✔  Cloud sync successful (HTTP ${res.status}).`);
      return { success: true, sent: attendance.length, response: res.data };

    } catch (err) {
      lastError = err;
      const status = err.response?.status ?? "network error";
      console.warn(
        `  ⚠  Attempt ${attempt}/${config.cloud.retryAttempts} failed ` +
        `(${status}): ${err.message}`
      );

      // Don't retry on client errors (4xx) — they won't self-correct
      if (err.response?.status >= 400 && err.response?.status < 500) {
        console.error("  ✖  Client error — aborting retries.");
        break;
      }

      if (attempt < config.cloud.retryAttempts) {
        console.log(`  Retrying in ${config.cloud.retryDelayMs}ms …`);
        await sleep(config.cloud.retryDelayMs);
      }
    }
  }

  console.error(`  ✖  All retry attempts failed: ${lastError?.message}`);
  return { success: false, sent: 0, response: lastError?.response?.data ?? null };
}

/* ================================================================== */
/*  Utility                                                             */
/* ================================================================== */

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/**
 * @typedef {object} ProcessedAttendance
 * @property {string}           adm_no    – student admission number
 * @property {string}           time_in   – "HH:MM:SS" first event of the day
 * @property {string|undefined} time_out  – "HH:MM:SS" latest event ≥ 14:30 (if any)
 */