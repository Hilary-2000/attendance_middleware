/**
 * index.js
 * ─────────────────────────────────────────────────────────────
 * Middleware Entry Point
 * Architecture:  Hikvision Terminal → Middleware → Cloud School System
 *
 * Flow each run:
 *   1. Connect to the Hikvision face terminal (health-check)
 *   2. Pull today's raw attendance events via ISAPI
 *   3. Process: filter no-ID records, deduplicate, classify time_in / time_out
 *   4. POST the clean array to the Cloud School System API
 * ─────────────────────────────────────────────────────────────
 * Prerequisites:
 *   npm install axios dotenv
 *   "type": "module"  in package.json
 * ─────────────────────────────────────────────────────────────
 */

import { HikvisionClient }                  from "./hikvisionClient.js";
import { ensureDeviceReachable }            from "./deviceDiscovery.js";
import { processAttendance, syncToCloud }         from "./attendanceProcessor.js";
import { processStaffAttendance, syncStaffToCloud } from "./Staffattendanceprocessor.js";
import config                               from "./config.js";

/* ================================================================== */
/*  Helpers                                                             */
/* ================================================================== */

/**
 * Returns ISO-8601 date strings for the full current day plus the
 * "YYYY-MM-DD" string used as the sync payload date.
 *
 * "Today" is resolved in the configured site timezone
 * (config.sync.timezone / SYNC_TIMEZONE), NOT the host clock's own
 * timezone — so the device query window and the cloud attendance date
 * stay correct even if the server's OS timezone is wrong or drifts.
 * If the configured zone is invalid, falls back to host-local time.
 *
 * @param {string} [timeZone] – IANA zone name, e.g. "Africa/Nairobi"
 * @returns {{ startTime: string, endTime: string, dateStr: string }}
 */
function getTodayRange(timeZone = config.sync.timezone) {
  let yyyy, mm, dd;

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year : "numeric",
      month: "2-digit",
      day  : "2-digit",
    }).formatToParts(new Date());

    const part = (type) => parts.find((p) => p.type === type)?.value;
    yyyy = part("year");
    mm   = part("month");
    dd   = part("day");
  } catch {
    console.warn(`  ⚠  Invalid SYNC_TIMEZONE "${timeZone}" — using host local time instead.`);
  }

  if (!yyyy || !mm || !dd) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    yyyy = now.getFullYear();
    mm   = pad(now.getMonth() + 1);
    dd   = pad(now.getDate());
  }

  return {
    startTime: `${yyyy}-${mm}-${dd}T00:00:00`,
    endTime  : `${yyyy}-${mm}-${dd}T23:59:59`,
    dateStr  : `${yyyy}-${mm}-${dd}`,
  };
}

/**
 * Print a single processed attendance record to the console.
 *
 * @param {import('./attendanceProcessor.js').ProcessedAttendance} rec
 */
function printRecord(rec) {
  const out = rec.time_out ? `  time_out: ${rec.time_out}` : "  (no time_out yet)";
  console.log(`  • adm_no: ${rec.adm_no}  |  time_in: ${rec.time_in}${rec.time_out ? `  |  time_out: ${rec.time_out}` : ""}`);
}

/* ================================================================== */
/*  Main                                                                */
/* ================================================================== */

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Middleware – Hikvision DS-K1T342MFX-E1 ↔ Cloud School");
  console.log("═══════════════════════════════════════════════════════\n");

  // ── 1. Instantiate the terminal client ───────────────────────────
  let terminal = new HikvisionClient({
    host               : config.terminal.host,
    port               : config.terminal.port,
    username           : config.terminal.username,
    password           : config.terminal.password,
    useHttps           : config.terminal.useHttps,
    rejectUnauthorized : config.terminal.rejectUnauthorized,
  });

  // ── 2. Discover / verify terminal IP (auto-heals DHCP changes) ──
  let activeHost = config.terminal.host;
  try {
    const discovery = await ensureDeviceReachable({
      host      : config.terminal.host,
      port      : config.terminal.port,
      username  : config.terminal.username,
      password  : config.terminal.password,
      useHttps  : config.terminal.useHttps,
      deviceName: config.terminal.deviceName,
    });

    activeHost = discovery.ip;

    // If the IP changed, rebuild the terminal client with the new IP
    if (discovery.changed) {
      console.log(`  ↺  Reconnecting terminal client to new IP: ${activeHost}
`);
      terminal = new HikvisionClient({
        host               : activeHost,
        port               : config.terminal.port,
        username           : config.terminal.username,
        password           : config.terminal.password,
        useHttps           : config.terminal.useHttps,
        rejectUnauthorized : config.terminal.rejectUnauthorized,
      });
    }

    const info = discovery.info;
    console.log("  Model    :", info?.model            ?? "DS-K1T342MFX-E1");
    console.log("  Firmware :", info?.firmwareVersion  ?? "V4.39.180");
    console.log("  Serial   :", info?.serialNumber     ?? "GL0274831");
    console.log("");
  } catch (err) {
    console.error("✖  Terminal discovery failed:", err.message);
    process.exit(1);
  }

  // ── 3. Assert the terminal clock ────────────────────────────────
  // Every attendance timestamp comes from the device clock. This model
  // runs in manual time mode with no NTP, so it drifts; if it drifts
  // past a day boundary the daily query silently returns nothing.
  // Push the middleware host's (correct) time before we trust the logs.
  try {
    const clock = await terminal.syncClock({ ianaZone: config.sync.timezone });
    if (clock.changed) {
      console.log(
        `▶ Terminal clock corrected: was ${clock.deviceLocal} ` +
        `(${clock.driftSeconds}s off) → set to ${clock.setTo} ${config.sync.timezone}\n`
      );
    } else {
      console.log(`▶ Terminal clock OK (${clock.driftSeconds}s drift): ${clock.deviceLocal}\n`);
    }
  } catch (err) {
    console.warn(`⚠  Could not verify/set terminal clock: ${err.message}\n`);
  }

  // ── 4. Pull today's raw events ───────────────────────────────────
  const { startTime, endTime, dateStr } = getTodayRange();
  console.log("▶ Fetching attendance events …");
  console.log(`  Date  : ${dateStr}  (${config.sync.timezone})`);
  console.log(`  Range : ${startTime}  →  ${endTime}\n`);

  let rawRecords;
  try {
    rawRecords = await terminal.getAttendanceEvents({
      startTime,
      endTime,
      maxResults: config.terminal.pageSize,
      allPages  : config.terminal.fetchAllPages,
    });
  } catch (err) {
    console.error("✖  Failed to fetch events from terminal:", err.message);
    process.exit(1);
  }

  if (rawRecords.length === 0) {
    console.log("  No attendance events recorded today — nothing to sync.\n");
    return;
  }

  console.log(`  Pulled ${rawRecords.length} raw event(s) from terminal.\n`);

  // ── 5. Split records by biometric prefix ────────────────────────
  //   Prefix "1" → students  → attendanceProcessor.js
  //   Prefix "2" → staff     → staffAttendanceProcessor.js
  //   Anything else           → ignored
  const studentRaw = rawRecords.filter((r) =>
    (r.employeeNo ?? "").trim().startsWith("1")
  );
  const staffRaw = rawRecords.filter((r) =>
    (r.employeeNo ?? "").trim().startsWith("2")
  );

  console.log(`  ${studentRaw.length} student event(s)  |  ${staffRaw.length} staff event(s)\n`);

  // ── 6. Process students ───────────────────────────────────────────
  console.log("▶ Processing student attendance …");
  const processedStudents = processAttendance(studentRaw);

  if (processedStudents.length > 0) {
    console.log(`\n  ${processedStudents.length} student record(s):\n`);
    processedStudents.forEach(printRecord);
  } else {
    console.log("  No valid student records after processing.\n");
  }

  // ── 7. Process staff ──────────────────────────────────────────────
  console.log("▶ Processing staff attendance …");
  const processedStaff = processStaffAttendance(staffRaw);

  if (processedStaff.length > 0) {
    console.log(`\n  ${processedStaff.length} staff record(s):\n`);
    processedStaff.forEach((r) =>
      console.log(`  • biometric_no: ${r.biometric_no}  |  time_in: ${r.time_in}${r.time_out ? `  |  time_out: ${r.time_out}` : ""}`)
    );
  } else {
    console.log("  No valid staff records after processing.\n");
  }

  // ── 8. Sync students to cloud ─────────────────────────────────────
  if (processedStudents.length > 0) {
    const { success, sent, response } = await syncToCloud(processedStudents, dateStr);
    if (success) {
      console.log(`\n✔  Students: ${sent} record(s) sent to cloud.`);
      if (response) console.log("  Cloud response:", JSON.stringify(response, null, 2));
    } else {
      console.error("\n✖  Student sync failed.");
    }
  }

  // ── 9. Sync staff to cloud ────────────────────────────────────────
  if (processedStaff.length > 0) {
    const { success, sent, response } = await syncStaffToCloud(processedStaff, dateStr);
    if (success) {
      console.log(`\n✔  Staff: ${sent} record(s) sent to cloud.`);
      if (response) console.log("  Cloud response:", JSON.stringify(response, null, 2));
    } else {
      console.error("\n✖  Staff sync failed.");
    }
  }

  if (processedStudents.length === 0 && processedStaff.length === 0) {
    console.log("  No valid records to sync — nothing sent to cloud.\n");
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────
main().catch((err) => {
  console.error("\n✖  Unhandled error:", err.message);
  process.exit(1);
});