/**
 * staffAttendanceProcessor.js
 * ─────────────────────────────────────────────────────────────
 * Module: Staff Attendance Processor & Cloud Sync
 *
 * Handles biometric numbers starting with "2" (staff).
 * Student records (starting with "1") are ignored here —
 * they are handled entirely by attendanceProcessor.js.
 *
 * Logic mirrors attendanceProcessor.js:
 *   • Filter to staff biometric numbers only (prefix "2")
 *   • Skip records with no ID
 *   • Collapse multiple scans per staff member into one record
 *   • First scan of the day        → time_in
 *   • Latest scan at/after 14:30   → time_out
 *   • POST to the cloud staff attendance endpoint
 * ─────────────────────────────────────────────────────────────
 */

import axios  from "axios";
import config from "./config.js";

/* ================================================================== */
/*  Constants                                                           */
/* ================================================================== */

/** Biometric prefix that identifies a staff member */
const STAFF_PREFIX = "2";

/** Time-out boundary — same as student config */
const TIMEOUT_HOUR   = parseInt(process.env.TIMEOUT_HOUR   ?? "14", 10);
const TIMEOUT_MINUTE = parseInt(process.env.TIMEOUT_MINUTE ?? "30", 10);

/* ================================================================== */
/*  Time helpers (duplicated from attendanceProcessor for independence) */
/* ================================================================== */

/**
 * Parse ISO-8601-like device timestamp into { h, m, s, raw }.
 * Strips timezone offset — uses device local time directly.
 *
 * @param {string} isoString
 * @returns {{ h: number, m: number, s: number, raw: string } | null}
 */
function parseDeviceTime(isoString) {
  if (!isoString) return null;
  const local = isoString.replace(/Z$/, "").replace(/[+-]\d{2}:\d{2}$/, "");
  const match = local.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  return {
    h  : parseInt(match[1], 10),
    m  : parseInt(match[2], 10),
    s  : parseInt(match[3], 10),
    raw: `${match[1]}:${match[2]}:${match[3]}`,
  };
}

/**
 * Returns true when the time is at or after the timeout boundary.
 * @param {{ h: number, m: number }} t
 * @returns {boolean}
 */
function isTimeOut(t) {
  if (t.h > TIMEOUT_HOUR) return true;
  if (t.h === TIMEOUT_HOUR && t.m >= TIMEOUT_MINUTE) return true;
  return false;
}

/**
 * Compare two "HH:MM:SS" strings chronologically.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareTimeStrings(a, b) {
  return a.localeCompare(b);
}

/* ================================================================== */
/*  Core: processStaffAttendance                                        */
/* ================================================================== */

/**
 * Transform raw AttendanceRecords into clean staff attendance objects.
 *
 * Rules:
 *  1. Only process records whose employeeNo starts with "2" (staff).
 *  2. Skip records with no ID or ID of "0".
 *  3. Per staff member, first scan → time_in.
 *  4. Per staff member, latest scan at/after 14:30 → time_out.
 *
 * @param {import('./hikvisionClient.js').AttendanceRecord[]} records
 * @returns {ProcessedStaffAttendance[]}
 */
export function processStaffAttendance(records) {

  // ── 1. Filter: must have a valid staff biometric number ──────────
  const valid = records.filter((r) => {
    const id = (r.employeeNo ?? "").trim();
    return (
      id !== "" &&
      id !== "0" &&
      id.startsWith(STAFF_PREFIX)
    );
  });

  const skippedNoId = records.filter((r) => {
    const id = (r.employeeNo ?? "").trim();
    return id === "" || id === "0";
  }).length;

  const skippedNotStaff = records.length - skippedNoId - valid.length;

  console.log(
    `  Staff processing: ${records.length} raw event(s)  |  ` +
    `${skippedNoId} no ID  |  ` +
    `${skippedNotStaff} non-staff (prefix ≠ "${STAFF_PREFIX}")  |  ` +
    `${valid.length} staff retained.`
  );

  if (valid.length === 0) return [];

  // ── 2. Group by employeeNo ───────────────────────────────────────
  /** @type {Map<string, import('./hikvisionClient.js').AttendanceRecord[]>} */
  const byStaff = new Map();

  for (const r of valid) {
    const id = r.employeeNo.trim();
    if (!byStaff.has(id)) byStaff.set(id, []);
    byStaff.get(id).push(r);
  }

  // ── 3. Collapse each staff member's events into one record ───────
  /** @type {ProcessedStaffAttendance[]} */
  const processed = [];

  for (const [biometric_no, events] of byStaff) {
    const sorted = events
      .map((e) => ({ event: e, time: parseDeviceTime(e.eventTime) }))
      .filter((x) => x.time !== null)
      .sort((a, b) => compareTimeStrings(a.time.raw, b.time.raw));

    if (sorted.length === 0) continue;

    // Earliest scan → time_in
    const timeIn = sorted[0].time.raw;

    // Latest scan at or after threshold → time_out
    const postThreshold = sorted.filter((x) => isTimeOut(x.time));
    const timeOut = postThreshold.length > 0
      ? postThreshold[postThreshold.length - 1].time.raw
      : null;

    /** @type {ProcessedStaffAttendance} */
    const entry = {
      biometric_no,
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
 * POST processed staff attendance to the Cloud School System API.
 *
 * Payload shape:
 * {
 *   "school_code" : "SCH001",
 *   "date"        : "2026-02-26",
 *   "attendance"  : [
 *     { "biometric_no": "2000001", "time_in": "07:45:00" },
 *     { "biometric_no": "2000002", "time_in": "08:00:00", "time_out": "16:10:00" }
 *   ]
 * }
 *
 * @param {ProcessedStaffAttendance[]} attendance
 * @param {string}                     date  – "YYYY-MM-DD"
 * @returns {Promise<{ success: boolean, sent: number, response: any }>}
 */
export async function syncStaffToCloud(attendance, date) {
  if (attendance.length === 0) {
    console.log("  No staff records to sync — skipping.");
    return { success: true, sent: 0, response: null };
  }

  const url     = `${config.cloud.baseUrl}${config.cloud.staffAttendanceEndpoint}`;
  const payload = {
    school_code: config.cloud.schoolCode,
    date,
    attendance,
  };

  console.log(`\n▶ Syncing ${attendance.length} staff record(s) to cloud …`);
  console.log(`  Endpoint: POST ${url}`);

  let lastError;

  for (let attempt = 1; attempt <= config.cloud.retryAttempts; attempt++) {
    try {
      const res = await axios.post(url, payload, {
        timeout: config.cloud.timeoutMs,
        headers: {
          "Content-Type" : "application/json",
          "Authorization": `Bearer ${config.cloud.apiKey}`,
          "X-Source"     : "hikvision-middleware",
        },
      });

      console.log(`  ✔  Staff cloud sync successful (HTTP ${res.status}).`);
      return { success: true, sent: attendance.length, response: res.data };

    } catch (err) {
      lastError = err;
      const status = err.response?.status ?? "network error";
      console.warn(
        `  ⚠  Attempt ${attempt}/${config.cloud.retryAttempts} failed ` +
        `(${status}): ${err.message}`
      );

      if (err.response?.status >= 400 && err.response?.status < 500) {
        console.error("  ✖  Client error — aborting retries.");
        break;
      }

      if (attempt < config.cloud.retryAttempts) {
        console.log(`  Retrying in ${config.cloud.retryDelayMs}ms …`);
        await new Promise((res) => setTimeout(res, config.cloud.retryDelayMs));
      }
    }
  }

  console.error(`  ✖  All retry attempts failed: ${lastError?.message}`);
  return { success: false, sent: 0, response: lastError?.response?.data ?? null };
}

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/**
 * @typedef {object} ProcessedStaffAttendance
 * @property {string}           biometric_no – staff biometric number (prefix "2")
 * @property {string}           time_in      – "HH:MM:SS" first scan of the day
 * @property {string|undefined} time_out     – "HH:MM:SS" latest scan ≥ 14:30 (if any)
 */