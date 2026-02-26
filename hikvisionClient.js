/**
 * hikvisionClient.js
 * ─────────────────────────────────────────────────────────────
 * Module: Hikvision Face Terminal – ISAPI Client
 * Device:  DS-K1T342MFX-E1  |  Firmware V4.39.180
 *
 * Responsibility:
 *   • Authenticate with the terminal using Digest Auth (RFC 7616)
 *   • Query the Access Control Event Log (attendance records)
 *   • Return clean, normalised attendance objects
 *
 * Dependencies:  axios only  (no cookie-jar needed)
 * ─────────────────────────────────────────────────────────────
 */

import axios from "axios";
import * as https from "https";
import * as crypto from "crypto";

/* ================================================================== */
/*  Digest-Auth helpers                                                 */
/* ================================================================== */

/**
 * Parse a single quoted or unquoted parameter from a
 * WWW-Authenticate header string.
 */
function digestParam(header, key) {
  const quoted   = header.match(new RegExp(`${key}="([^"]+)"`));
  if (quoted) return quoted[1];
  const unquoted = header.match(new RegExp(`${key}=([^,\\s]+)`));
  return unquoted ? unquoted[1] : "";
}

/**
 * Build a complete Digest Authorization header value.
 *
 * @param {string} method        – HTTP verb  (GET | POST)
 * @param {string} uri           – request path, e.g. /ISAPI/...
 * @param {string} username
 * @param {string} password
 * @param {string} wwwAuthHeader – value of the WWW-Authenticate header
 * @returns {string}
 */
function buildDigestAuth(method, uri, username, password, wwwAuthHeader) {
  const realm  = digestParam(wwwAuthHeader, "realm");
  const nonce  = digestParam(wwwAuthHeader, "nonce");
  const qop    = digestParam(wwwAuthHeader, "qop");
  const opaque = digestParam(wwwAuthHeader, "opaque");
  const algo   = digestParam(wwwAuthHeader, "algorithm") || "MD5";

  const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

  const ha1 = algo.toUpperCase() === "MD5-SESS"
    ? md5(`${md5(`${username}:${realm}:${password}`)}:${nonce}:`)
    : md5(`${username}:${realm}:${password}`);

  const ha2 = md5(`${method.toUpperCase()}:${uri}`);

  let response;
  let extras = "";

  if (qop === "auth" || qop === "auth-int") {
    const nc     = "00000001";
    const cnonce = crypto.randomBytes(8).toString("hex");
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extras   = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  return (
    `Digest username="${username}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${uri}", algorithm=${algo}, response="${response}"` +
    (opaque ? `, opaque="${opaque}"` : "") +
    extras
  );
}

/* ================================================================== */
/*  HikvisionClient                                                     */
/* ================================================================== */

export class HikvisionClient {
  /**
   * @param {object}  cfg
   * @param {string}  cfg.host                      – terminal IP / hostname
   * @param {number}  [cfg.port=80]                 – 80 (HTTP) or 443 (HTTPS)
   * @param {string}  cfg.username
   * @param {string}  cfg.password
   * @param {boolean} [cfg.useHttps=false]
   * @param {boolean} [cfg.rejectUnauthorized=false] – false for self-signed certs
   * @param {number}  [cfg.timeout=10000]            – ms
   */
  constructor(cfg = {}) {
    this.host     = cfg.host;
    this.port     = cfg.port ?? (cfg.useHttps ? 443 : 80);
    this.username = cfg.username;
    this.password = cfg.password;
    this.useHttps = cfg.useHttps ?? false;
    this.timeout  = cfg.timeout  ?? 10_000;

    this.baseURL = `${this.useHttps ? "https" : "http"}://${this.host}:${this.port}`;

    // Plain axios instance — no cookie jar, no extra wrappers
    this.http = axios.create({
      baseURL   : this.baseURL,
      timeout   : this.timeout,
      httpsAgent: new https.Agent({ rejectUnauthorized: cfg.rejectUnauthorized ?? false }),
      // Do NOT throw on 401 — we handle it ourselves for Digest Auth
      validateStatus: (status) => status < 500,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Core: two-step Digest-authenticated request                      */
  /* ---------------------------------------------------------------- */

  /**
   * Perform a Digest-authenticated ISAPI request.
   *
   * Step 1 – Send without credentials  →  device returns 401 + WWW-Authenticate
   * Step 2 – Compute digest, resend    →  device returns 200 + data
   *
   * @param {string}  method   – "GET" | "POST"
   * @param {string}  path     – ISAPI path
   * @param {object}  [body]   – JSON body for POST
   * @param {object}  [params] – URL query-string params
   * @returns {Promise<any>}   – parsed JSON response body
   */
  async request(method, path, body = null, params = {}) {
    const METHOD = method.toUpperCase();

    // ── Step 1: unauthenticated probe ──────────────────────────────
    let probe;
    try {
      probe = await this.http.request({
        method : METHOD,
        url    : path,
        params,
        data   : body ?? undefined,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      // Network-level error (ECONNREFUSED, ETIMEDOUT, etc.)
      throw new Error(
        `Cannot reach terminal at ${this.baseURL}${path}\n` +
        `  → ${err.message}\n` +
        `  Ensure the terminal IP/port is correct and reachable on the local network.`
      );
    }

    // Device responded without a challenge — auth may be disabled or
    // the request succeeded immediately (rare but handled gracefully).
    if (probe.status !== 401) {
      return probe.data;
    }

    const wwwAuth = probe.headers["www-authenticate"];
    if (!wwwAuth) {
      throw new Error(
        `Terminal returned 401 but no WWW-Authenticate header.\n` +
        `  Check device credentials and enable ISAPI in the device web portal.`
      );
    }

    // ── Step 2: authenticated request ──────────────────────────────
    const authHeader = buildDigestAuth(
      METHOD, path, this.username, this.password, wwwAuth
    );

    let authed;
    try {
      authed = await this.http.request({
        method : METHOD,
        url    : path,
        params,
        data   : body ?? undefined,
        headers: {
          "Content-Type" : "application/json",
          "Authorization": authHeader,
        },
      });
    } catch (err) {
      throw new Error(`Authenticated request failed: ${err.message}`);
    }

    if (authed.status === 401) {
      throw new Error(
        `Digest Auth rejected (still 401).\n` +
        `  Double-check TERMINAL_USERNAME and TERMINAL_PASSWORD in your .env`
      );
    }

    if (authed.status >= 400) {
      throw new Error(
        `ISAPI error: HTTP ${authed.status}\n` +
        `  Body: ${JSON.stringify(authed.data).slice(0, 300)}`
      );
    }

    return authed.data;
  }

  /* ---------------------------------------------------------------- */
  /*  Public: Device information                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Fetch basic device info (model, firmware, serial number).
   * Use this as a connectivity health-check on startup.
   *
   * @returns {Promise<object>}
   */
  async getDeviceInfo() {
    const data = await this.request("GET", "/ISAPI/System/deviceInfo");
    return data?.DeviceInfo ?? data;
  }

  /* ---------------------------------------------------------------- */
  /*  Public: Attendance / access-control events                       */
  /* ---------------------------------------------------------------- */

  /**
   * Retrieve access-control event logs from the terminal.
   *
   * ISAPI endpoint:
   *   POST /ISAPI/AccessControl/AcsEvent?format=json
   *
   * @param {object}  opts
   * @param {string}  opts.startTime        – "YYYY-MM-DDTHH:mm:ss"
   * @param {string}  opts.endTime          – "YYYY-MM-DDTHH:mm:ss"
   * @param {number}  [opts.maxResults=100] – per-page limit (ISAPI max 100)
   * @param {boolean} [opts.allPages=true]  – auto-paginate through all results
   * @returns {Promise<AttendanceRecord[]>}
   */
  async getAttendanceEvents(opts = {}) {
    const {
      startTime,
      endTime,
      maxResults = 100,
      allPages   = true,
    } = opts;

    if (!startTime || !endTime) {
      throw new Error("`startTime` and `endTime` are required (YYYY-MM-DDTHH:mm:ss).");
    }

    const buildPayload = (searchResultPosition) => ({
      AcsEventCond: {
        searchID            : "1",
        searchResultPosition,
        maxResults,
        major               : 0,   // 0 = all major categories
        minor               : 0,   // 0 = all minor types
        startTime           : this.#stripTz(startTime),
        endTime             : this.#stripTz(endTime),
      },
    });

    // ── First page ─────────────────────────────────────────────────
    const first  = await this.request(
      "POST",
      "/ISAPI/AccessControl/AcsEvent?format=json",
      buildPayload(0)
    );

    const total  = first?.AcsEvent?.totalMatches ?? 0;
    let   events = first?.AcsEvent?.InfoList     ?? [];

    console.log(`  Terminal reports ${total} total event(s) in range.`);
    console.log(`  First page returned ${events.length} event(s).`);

    // ── Remaining pages ────────────────────────────────────────────
    // NOTE: Hikvision firmware may return fewer records than maxResults
    // per page (e.g. hard cap of 30 regardless of maxResults value).
    // We keep paginating as long as we haven't collected all events,
    // using events.length as the running offset — not a fixed page size.
    if (allPages && total > events.length) {
      while (events.length < total) {
        const offset = events.length;   // always resume from where we stopped
        console.log(`  Fetching page at offset ${offset} / ${total} …`);
        const page  = await this.request(
          "POST",
          "/ISAPI/AccessControl/AcsEvent?format=json",
          buildPayload(offset)
        );
        const batch = page?.AcsEvent?.InfoList ?? [];
        if (batch.length === 0) break;   // device has no more — stop
        events = events.concat(batch);
        console.log(`  Collected ${events.length} / ${total} event(s) so far.`);
      }
    }

    return events.map((e) => this.#normalise(e));
  }

  /* ---------------------------------------------------------------- */
  /*  Private: normalise raw ISAPI event → AttendanceRecord            */
  /* ---------------------------------------------------------------- */

  #normalise(raw) {
    return {
      // Identity
      employeeNo   : raw.employeeNoString ?? String(raw.employeeNo ?? ""),
      name         : raw.name             ?? null,
      cardNo       : raw.cardNo           ?? null,

      // Event classification
      eventType    : raw.minor            ?? null,
      eventTypeName: raw.minorDesc        ?? null,
      direction    : raw.inOutStatus      ?? null,  // "entrance" | "exit"

      // Timestamps
      eventTime    : raw.time             ?? null,  // device ISO timestamp
      capturedAt   : new Date().toISOString(),      // middleware UTC timestamp

      // Device context
      doorNo       : raw.doorNo           ?? null,
      deviceSerial : raw.serialNo         ?? null,

      // Raw object retained for debugging / extended mapping
      _raw: raw,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Utility                                                           */
  /* ---------------------------------------------------------------- */

  /** Remove timezone suffix and sub-seconds — device expects local time only. */
  #stripTz(dt) {
    return dt.replace(/Z$/, "").replace(/\+\d{2}:\d{2}$/, "").split(".")[0];
  }
}

/**
 * @typedef {object} AttendanceRecord
 * @property {string}      employeeNo    – student / staff ID on the terminal
 * @property {string|null} name          – full name stored on terminal
 * @property {string|null} cardNo        – card / badge number (if used)
 * @property {number|null} eventType     – ISAPI minor event code
 * @property {string|null} eventTypeName – human-readable event label
 * @property {string|null} direction     – "entrance" | "exit" | null
 * @property {string|null} eventTime     – ISO timestamp from the device
 * @property {string}      capturedAt    – ISO timestamp added by middleware (UTC)
 * @property {number|null} doorNo        – door/lane number on the terminal
 * @property {string|null} deviceSerial  – terminal serial number
 * @property {object}      _raw          – original ISAPI response object
 */