/**
 * deviceSync.js
 * ─────────────────────────────────────────────────────────────
 * Module: Person Synchronisation — Cloud System → Hikvision Terminals
 *
 * Runs every 2 hours via PM2 cron.
 * Discovers ALL Hikvision terminals on the local network, then
 * for each terminal:
 *
 *   ADD    — persons in the cloud system not yet on the device
 *   UPDATE — persons whose profile changed (name, card, etc.)
 *            + photo update ONLY when photo_update_flag = 0
 *   DELETE — persons on the device no longer in the cloud system
 *
 * Biometric prefix convention:
 *   Students : 1xxxxxx
 *   Staff    : 2xxxxxx
 *
 * Flag convention:
 *   photo_update_flag = 0 → photo pending, needs to be pushed
 *   photo_update_flag = 1 → photo up to date on all devices
 *
 * Prerequisites:
 *   npm install axios form-data
 * ─────────────────────────────────────────────────────────────
 */

import axios       from "axios";
import FormData    from "form-data";
import * as https  from "https";
import * as crypto from "crypto";
import * as os     from "os";
import * as fs     from "fs";
import * as path   from "path";
import * as url    from "url";
import sharp       from "sharp";
import config      from "./config.js";

const __dirname  = path.dirname(url.fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, "data", "device_cache.json");

/* ── Image compression settings ─────────────────────────────── */
// Hikvision DS-K1T342MFX-E1 face image requirements:
//   • Format  : JPEG
//   • Max size: 200KB
//   • Recommended resolution: 640×480 or smaller
const MAX_IMAGE_BYTES  = 200 * 1024;   // 200KB in bytes
const TARGET_WIDTH     = 640;
const TARGET_HEIGHT    = 480;
const INITIAL_QUALITY  = 85;           // start at 85% JPEG quality
const MIN_QUALITY      = 30;           // never go below 30% quality

/* ================================================================== */
/*  Constants                                                           */
/* ================================================================== */

const PROBE_TIMEOUT_MS = 500;     // 500ms is plenty for a local network
const SCAN_CONCURRENCY = 50;      // scan more hosts simultaneously
const REQUEST_TIMEOUT  = 12_000;

const ISAPI_PERSON_LIST   = "/ISAPI/AccessControl/UserInfo/Search?format=json";
const ISAPI_PERSON_ADD    = "/ISAPI/AccessControl/UserInfo/Record?format=json";
const ISAPI_PERSON_UPDATE = "/ISAPI/AccessControl/UserInfo/Modify?format=json";
const ISAPI_PERSON_DELETE = "/ISAPI/AccessControl/UserInfo/Delete?format=json";
// DS-K1T342MFX-E1 is a face recognition terminal
// Uses Intelligent/FDLib path, NOT AccessControl/FaceDataRecord
const ISAPI_FACE_UPLOAD = "/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json";

/* ================================================================== */
/*  Digest-Auth (self-contained — no external dependency)              */
/* ================================================================== */

function digestParam(header, key) {
  const q = header.match(new RegExp(`${key}="([^"]+)"`));
  if (q) return q[1];
  const u = header.match(new RegExp(`${key}=([^,\\s]+)`));
  return u ? u[1] : "";
}

function buildDigestAuth(method, uri, user, pass, wwwAuth) {
  const realm  = digestParam(wwwAuth, "realm");
  const nonce  = digestParam(wwwAuth, "nonce");
  const qop    = digestParam(wwwAuth, "qop");
  const opaque = digestParam(wwwAuth, "opaque");
  const algo   = digestParam(wwwAuth, "algorithm") || "MD5";
  const md5    = (s) => crypto.createHash("md5").update(s).digest("hex");

  const ha1 = algo.toUpperCase() === "MD5-SESS"
    ? md5(`${md5(`${user}:${realm}:${pass}`)}:${nonce}:`)
    : md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);

  let response, extras = "";
  if (qop === "auth" || qop === "auth-int") {
    const nc = "00000001", cnonce = crypto.randomBytes(8).toString("hex");
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extras   = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  return (
    `Digest username="${user}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${uri}", algorithm=${algo}, response="${response}"` +
    (opaque ? `, opaque="${opaque}"` : "") + extras
  );
}

/* ================================================================== */
/*  Per-device HTTP client with Digest Auth                             */
/* ================================================================== */

class DeviceClient {
  constructor(ip, port, username, password, useHttps = false) {
    this.ip       = ip;
    this.baseURL  = `${useHttps ? "https" : "http"}://${ip}:${port}`;
    this.username = username;
    this.password = password;

    this.http = axios.create({
      baseURL       : this.baseURL,
      timeout       : REQUEST_TIMEOUT,
      httpsAgent    : new https.Agent({ rejectUnauthorized: false }),
      validateStatus: (s) => s < 500,
      responseType  : "text",
    });
  }

  /**
   * Two-step Digest-authenticated request.
   * Supports GET, POST, PUT — returns parsed JSON or raw text.
   */
  async request(method, path, body = null, isFormData = false) {
    const METHOD  = method.toUpperCase();
    const headers = isFormData ? {} : { "Content-Type": "application/json" };

    // Step 1 — unauthenticated probe
    let probe;
    try {
      probe = await this.http.request({
        method : METHOD,
        url    : path,
        data   : body ?? undefined,
        headers,
      });
    } catch (err) {
      throw new Error(`${this.ip} unreachable: ${err.message}`);
    }

    if (probe.status !== 401) {
      return this._parse(probe.data);
    }

    const wwwAuth = probe.headers["www-authenticate"];
    if (!wwwAuth) throw new Error(`${this.ip}: 401 with no WWW-Authenticate`);

    // Step 2 — authenticated request
    const authHeader = buildDigestAuth(METHOD, path, this.username, this.password, wwwAuth);

    const authed = await this.http.request({
      method : METHOD,
      url    : path,
      data   : body ?? undefined,
      headers: { ...headers, Authorization: authHeader },
    });

    if (authed.status === 401) {
      throw new Error(`${this.ip}: Digest Auth rejected — check credentials`);
    }

    return this._parse(authed.data);
  }

  _parse(data) {
    if (typeof data === "string") {
      try { return JSON.parse(data); } catch { return data; }
    }
    return data;
  }
}

/* ================================================================== */
/*  Network scanner — find ALL Hikvision devices                        */
/* ================================================================== */

function detectAllSubnets() {
  const VIRTUAL = [
    /virtualbox/i, /vmware/i, /vmnet/i, /vethernet/i,
    /wsl/i, /docker/i, /hyper-v/i, /^veth/i, /^virbr/i,
    /^lxc/i, /^tun/i, /^tap/i,
  ];

  const results = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      results.push({
        name,
        address : addr.address,
        subnet  : addr.address.split(".").slice(0, 3).join("."),
        virtual : VIRTUAL.some((p) => p.test(name)),
      });
    }
  }
  results.sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0));
  return [...new Map(results.map((s) => [s.subnet, s])).values()];
}

async function pMap(items, concurrency, fn) {
  const results = new Array(items.length);
  let   index   = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Probe a single IP — returns { ip, info } or null.
 */
async function probeHost(ip, port, username, password, useHttps) {
  const scheme  = useHttps ? "https" : "http";
  const baseURL = `${scheme}://${ip}:${port}`;
  const PATH    = "/ISAPI/System/deviceInfo";

  const http = axios.create({
    baseURL,
    timeout       : PROBE_TIMEOUT_MS,
    httpsAgent    : new https.Agent({ rejectUnauthorized: false }),
    validateStatus: (s) => s < 500,
    responseType  : "text",
  });

  for (const accept of ["application/json", "text/xml, */*"]) {
    try {
      const probe = await http.get(PATH, { headers: { Accept: accept } });
      if (probe.status !== 401) continue;

      const wwwAuth = probe.headers["www-authenticate"];
      if (!wwwAuth) continue;

      const auth   = buildDigestAuth("GET", PATH, username, password, wwwAuth);
      const authed = await http.get(PATH, {
        headers: { Authorization: auth, Accept: accept },
      });

      if (authed.status !== 200) continue;

      // Parse XML or JSON response
      const raw  = authed.data;
      const info = {};

      if (typeof raw === "string" && raw.trim().startsWith("<")) {
        const field = (tag) => {
          const m = raw.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
          return m ? m[1].trim() : null;
        };
        info.model           = field("model");
        info.serialNumber    = field("serialNumber");
        info.deviceName      = field("deviceName");
        info.firmwareVersion = field("firmwareVersion");
      } else {
        const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
        const d   = obj?.DeviceInfo ?? obj;
        info.model           = d.model            ?? null;
        info.serialNumber    = d.serialNumber     ?? null;
        info.deviceName      = d.deviceName       ?? null;
        info.firmwareVersion = d.firmwareVersion  ?? null;
      }

      if (info.model || info.serialNumber) return { ip, info };

    } catch { /* unreachable host — silently skip */ }
  }
  return null;
}

/* ── Cache helpers ───────────────────────────────────────────── */

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch { /* corrupt cache — ignore */ }
  return [];
}

function saveCache(devices) {
  try {
    if (!fs.existsSync(path.dirname(CACHE_FILE))) {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    }
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify(devices.map((d) => ({ ip: d.ip, info: d.info })), null, 2),
      "utf8"
    );
  } catch (err) {
    console.warn(`  ⚠  Could not save device cache: ${err.message}`);
  }
}

/**
 * Scan the local network and return all Hikvision devices found.
 * Uses a local cache to skip the full subnet scan on repeat runs.
 *
 * @returns {Promise<Array<{ ip: string, info: object, client: DeviceClient }>>}
 */
export async function discoverAllDevices() {
  const { terminal: t } = config;
  const makeClient = (ip) => new DeviceClient(ip, t.port, t.username, t.password, t.useHttps);

  /* ── Step 1: Try cached IPs first ──────────────────────────── */
  const cached = loadCache();
  if (cached.length > 0) {
    console.log(`\n▶ Trying ${cached.length} cached device(s) before scanning …`);
    const verified = [];

    await pMap(cached, cached.length, async ({ ip, info }) => {
      const result = await probeHost(ip, t.port, t.username, t.password, t.useHttps);
      if (result) {
        console.log(`  ✔  Cache hit : ${ip}  [${result.info.model ?? info.model ?? "?"}]`);
        verified.push({ ip, info: result.info, client: makeClient(ip) });
      } else {
        console.log(`  ✖  Cache miss: ${ip} — no longer reachable`);
      }
    });

    if (verified.length === cached.length) {
      console.log(`  All ${verified.length} cached device(s) still reachable — skipping subnet scan.\n`);
      return verified;
    }

    console.log(`  Some devices moved — running full scan to find new IPs …\n`);
  }

  /* ── Step 2: Full subnet scan (only when cache misses) ──────── */
  const subnets = detectAllSubnets();

  console.log("▶ Scanning local network for Hikvision devices …");
  subnets.forEach((s) =>
    console.log(`  ${s.subnet}.0/24  [${s.name}]${s.virtual ? " (virtual)" : ""}`)
  );

  const devices = [];

  for (const { subnet } of subnets) {
    const hosts = Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);

    await pMap(hosts, SCAN_CONCURRENCY, async (ip) => {
      const result = await probeHost(ip, t.port, t.username, t.password, t.useHttps);
      if (result) {
        console.log(
          `  📡 Found: ${ip}  model: ${result.info.model ?? "?"}  ` +
          `serial: ${result.info.serialNumber ?? "?"}  ` +
          `name: ${result.info.deviceName ?? "?"}`
        );
        devices.push({ ip, info: result.info, client: makeClient(ip) });
      }
    });

    // Stop after first real subnet that has devices
    if (devices.length > 0 && !subnets.find((s) => s.subnet === subnet)?.virtual) break;
  }

  if (devices.length > 0) {
    saveCache(devices);
    console.log(`  Cache updated with ${devices.length} device(s).`);
  }

  console.log(`\n  Found ${devices.length} Hikvision device(s) total.\n`);
  return devices;
}

/* ================================================================== */
/*  ISAPI Person operations                                             */
/* ================================================================== */

/**
 * Fetch all persons currently enrolled on a terminal.
 * Returns a Map keyed by employeeNo for O(1) lookup.
 */
async function getDevicePersons(client) {
  const payload = {
    UserInfoSearchCond: {
      searchID            : "1",
      searchResultPosition: 0,
      maxResults          : 30,   // firmware hard cap is 30 per page
    },
  };

  const persons = new Map();
  let   offset  = 0;
  let   total   = null;

  do {
    payload.UserInfoSearchCond.searchResultPosition = offset;

    const data = await client.request("POST", ISAPI_PERSON_LIST, JSON.stringify(payload));
    const list = data?.UserInfoSearch?.InfoList ?? [];

    if (total === null) {
      total = data?.UserInfoSearch?.totalMatches ?? list.length;
    }

    for (const p of list) {
      persons.set(String(p.employeeNo), p);
    }

    offset += list.length;
    if (list.length === 0) break;

  } while (offset < total);

  return persons;
}

/**
 * Add a new person to the terminal.
 */
async function addPerson(client, person) {
  const payload = {
    UserInfo: {
      employeeNo : String(person.biometric_number),
      name       : person.name,
      userType   : "normal",
      Valid      : {
        enable   : true,
        beginTime: "2000-01-01T00:00:00",
        endTime  : "2037-12-31T23:59:59",
      },
      doorRight  : "1",
      RightPlan  : [{ doorNo: 1, planTemplateNo: "1" }],
    },
  };

  return await client.request("POST", ISAPI_PERSON_ADD, JSON.stringify(payload));
}

/**
 * Update an existing person's details on the terminal.
 */
async function updatePerson(client, person) {
  const payload = {
    UserInfo: {
      employeeNo: String(person.biometric_number),
      name      : person.name,
    },
  };

  return await client.request("PUT", ISAPI_PERSON_UPDATE, JSON.stringify(payload));
}

/**
 * Delete a person from the terminal by employeeNo.
 */
async function deletePerson(client, employeeNo) {
  const payload = {
    UserInfoDelCond: {
      EmployeeNoList: [{ employeeNo: String(employeeNo) }],
    },
  };

  return await client.request("PUT", ISAPI_PERSON_DELETE, JSON.stringify(payload));
}

/**
 * Upload a face image for a person on the terminal.
 * Image must be a JPEG Buffer.
 */
async function uploadFaceImage(client, employeeNo, imageBuffer) {
  // DS-K1T342MFX-E1 correct face upload endpoint
  const reqPath = ISAPI_FACE_UPLOAD;
  const METHOD  = "POST";

  // Build the JSON metadata for Intelligent/FDLib endpoint
  // FDID = face library ID (1 = default library)
  // FPID = face person ID (must match the employeeNo registered on device)
  const faceRecord = JSON.stringify({
    faceLibType : "blackFD",
    FDID        : "1",
    FPID        : String(employeeNo),
  });

  // Helper — build a fresh FormData each time (streams can only be read once)
  const buildForm = () => {
    const f = new FormData();
    f.append("FaceDataRecord", faceRecord, {
      contentType: "application/json; charset=UTF-8",
      filename   : "FaceDataRecord",
    });
    f.append("FaceImage", imageBuffer, {
      contentType: "image/jpeg",
      filename   : `${employeeNo}.jpg`,
    });
    return f;
  };

  // Step 1 — probe for Digest challenge
  let probe;
  try {
    const form = buildForm();
    probe = await client.http.request({
      method : METHOD,
      url    : reqPath,
      data   : form,
      headers: form.getHeaders(),
      timeout: REQUEST_TIMEOUT,
    });
  } catch (err) {
    throw new Error(`Face upload probe failed: ${err.message}`);
  }

  if (probe.status !== 401) {
    const result = client._parse(probe.data);
    if (probe.status >= 400) {
      throw new Error(`Face upload rejected (HTTP ${probe.status}): ${JSON.stringify(result)}`);
    }
    return result;
  }

  const wwwAuth = probe.headers["www-authenticate"];
  if (!wwwAuth) throw new Error(`Face upload 401 — no WWW-Authenticate header`);

  // Step 2 — authenticated upload with fresh form
  const authHeader = buildDigestAuth(METHOD, reqPath, client.username, client.password, wwwAuth);
  const form2      = buildForm();

  let authed;
  try {
    authed = await client.http.request({
      method : METHOD,
      url    : reqPath,
      data   : form2,
      headers: { ...form2.getHeaders(), Authorization: authHeader },
      timeout: REQUEST_TIMEOUT,
    });
  } catch (err) {
    throw new Error(`Face upload failed: ${err.message}`);
  }

  const result = client._parse(authed.data);

  if (authed.status >= 400) {
    throw new Error(`Face upload rejected (HTTP ${authed.status}): ${JSON.stringify(result)}`);
  }

  return result;
}


/* ================================================================== */
/*  Fetch persons from Cloud School System                              */
/* ================================================================== */

/**
 * Expected response shape (any ONE of these envelopes is accepted):
 * {
 *   "persons": [ … ],          // or "data" / "result" / "rows" / bare array
 *   "total"  : 842              // optional; if present it is cross-checked
 * }
 *
 * Each person (field names are matched loosely — see normalisePerson):
 *   {
 *     "biometric_number"  : "1000001",
 *     "name"              : "JANE DOE",
 *     "photo_update_flag" : 0,          // 0 = needs push, 1 = up to date
 *     "photo_url"         : "https://yourdomain.com/images/students/photo.jpg",
 *     "type"              : "student"   // or "staff"
 *   }
 */

/** Pull the person array out of whatever envelope the endpoint used. */
function extractPersonList(body) {
  if (Array.isArray(body)) return body;
  for (const key of ["persons", "data", "result", "results", "rows", "items"]) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

/** Pull a declared total/count out of the envelope, if the endpoint sends one. */
function extractDeclaredTotal(body) {
  for (const key of ["total", "totalMatches", "total_count", "totalRecords", "count"]) {
    const v = body?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  }
  return null;
}

/**
 * Normalise one raw person record into the exact shape the rest of this
 * module expects: { biometric_number, name, photo_update_flag, photo_url, type }.
 * Field names are matched loosely so a harmless cloud-side rename does not
 * turn into a mass delete.
 */
function normalisePerson(p) {
  const biometric_number = String(
    p.biometric_number ?? p.biometric_no ?? p.bio_number ?? p.bio_no ??
    p.employeeNo ?? p.employee_no ?? p.employeeNoString ?? ""
  ).trim();

  const rawFlag = p.photo_update_flag ?? p.photo_flag ?? p.photoUpdateFlag ?? 1;

  return {
    biometric_number,
    name             : String(p.name ?? p.full_name ?? p.fullname ?? p.person_name ?? "").trim(),
    photo_update_flag: Number(rawFlag),
    photo_url        : p.photo_url ?? p.photo ?? p.image_url ?? p.image ?? p.picture ?? null,
    type             : p.type ?? p.person_type ?? p.category ?? null,
    _raw             : p,
  };
}

function isUsableBiometric(n) {
  return !!n && n !== "undefined" && n !== "null" && n !== "0";
}

/**
 * Fetch the full person list (students + staff) from the cloud API.
 *
 * Pages through the endpoint until it runs out of rows, and — if the
 * endpoint declares a total — verifies the collected count matches it.
 * Throws (aborting the whole sync) rather than returning a roster that
 * looks truncated, because a short roster deletes valid enrolments.
 */
async function fetchCloudPersons() {
  const endpoint = `${config.cloud.baseUrl}${config.cloud.personSyncEndpoint}`;
  const { pageSize, maxPages } = config.cloud.personSync;

  const byId       = new Map();   // biometric_number -> normalised person
  let   declared   = null;
  let   prevSig    = null;
  let   shapeShown = false;
  let   page       = 1;

  for (; page <= maxPages; page++) {
    const res = await axios.get(endpoint, {
      timeout     : config.cloud.timeoutMs,
      maxRedirects: 5,
      httpsAgent  : new https.Agent({ rejectUnauthorized: false }),
      params      : { page, per_page: pageSize, page_size: pageSize, limit: pageSize, offset: (page - 1) * pageSize },
      headers     : { "X-School-Code": config.cloud.schoolCode },
    });

    const body = res.data;

    // A 200 that isn't a JSON object/array (HTML error page, login redirect,
    // maintenance notice, PHP warning text …) must NOT be read as "0 persons".
    if (body === null || (typeof body !== "object")) {
      throw new Error(
        `Person-sync endpoint returned a non-JSON 200 response (${typeof body}). ` +
        `First 200 chars: ${String(body).slice(0, 200)}`
      );
    }

    const list  = extractPersonList(body);
    const total = extractDeclaredTotal(body);
    if (total !== null && declared === null) declared = total;

    if (!shapeShown) {
      const envKeys = Array.isArray(body) ? "(bare array)" : `[${Object.keys(body).join(", ")}]`;
      console.log(`  Person-sync response: envelope keys ${envKeys}, ${list.length} row(s) on page 1` +
                  (total !== null ? `, declared total ${total}` : `, no total field`));
      if (list[0]) console.log(`  Sample row keys: [${Object.keys(list[0]).join(", ")}]`);
      shapeShown = true;
    }

    if (list.length === 0) break;

    // Detect an endpoint that ignores paging params and returns the same
    // list every call — otherwise the loop would run for maxPages.
    const idOf = (x) => String(x?.biometric_number ?? x?.biometric_no ?? x?.employeeNo ?? "");
    const sig  = `${list.length}|${idOf(list[0])}|${idOf(list[list.length - 1])}`;
    if (sig === prevSig) {
      console.log(`  Page ${page} identical to page ${page - 1} — endpoint is not paginating; stopping.`);
      break;
    }
    prevSig = sig;

    let fresh = 0;
    for (const raw of list) {
      const person = normalisePerson(raw);
      if (!byId.has(person.biometric_number)) fresh++;
      byId.set(person.biometric_number, person);
    }

    if (fresh === 0)            break;   // full page, nothing new — wrapped around
    if (list.length < pageSize) break;   // short page — last page
  }

  if (page > maxPages) {
    throw new Error(
      `Person-sync exceeded CLOUD_PERSON_MAX_PAGES (${maxPages}) without finishing. ` +
      `Aborting rather than syncing a possibly-truncated roster.`
    );
  }

  const persons = [...byId.values()];

  if (declared !== null && persons.length < declared) {
    throw new Error(
      `Person-sync collected ${persons.length} person(s) but the endpoint declared ` +
      `a total of ${declared}. Roster is incomplete — aborting to avoid deleting ` +
      `valid enrolments. (Check the endpoint's pagination / CLOUD_PERSON_PAGE_SIZE.)`
    );
  }

  return persons;
}

/**
 * Guard the roster before it is allowed to drive ADD/UPDATE/DELETE.
 * Throws on anything that smells like an empty or malformed response.
 */
function assertRosterSane(persons) {
  const { minRosterCount, maxInvalidRatio } = config.cloud.personSync;

  if (persons.length < minRosterCount) {
    throw new Error(
      `Cloud roster has only ${persons.length} person(s) (minimum expected: ${minRosterCount}). ` +
      `Refusing to sync — an empty or tiny list would delete most/all enrolments from the ` +
      `terminal(s). Check SCHOOL_CODE, CLOUD_API_KEY and the endpoint's health.`
    );
  }

  const invalid = persons.filter((p) => !isUsableBiometric(p.biometric_number)).length;
  const ratio   = invalid / persons.length;

  if (ratio > maxInvalidRatio) {
    throw new Error(
      `${invalid}/${persons.length} cloud person record(s) (${(ratio * 100).toFixed(0)}%) have no ` +
      `usable biometric number — likely a response-shape / field-name mismatch (expected a ` +
      `"biometric_number" field). Refusing to sync.`
    );
  }

  if (invalid > 0) {
    console.warn(`  ⚠  ${invalid} cloud record(s) have no biometric number — they will be ignored.`);
  }
}

/**
 * Download a photo from a URL and return it as a Buffer.
 * Returns null if the URL is empty or the download fails.
 */
async function fetchPhoto(photoUrl) {
  if (!photoUrl) return null;
  try {
    const res = await axios.get(photoUrl, {
      responseType: "arraybuffer",
      timeout     : 15_000,
      maxRedirects: 5,
      httpsAgent  : new https.Agent({ rejectUnauthorized: false }),
    });

    // Verify we actually got image data back
    const contentType = res.headers["content-type"] ?? "";
    if (!contentType.includes("image")) {
      console.warn(`  ⚠  Photo URL did not return an image (${contentType}): ${photoUrl}`);
      return null;
    }

    return Buffer.from(res.data);
  } catch (err) {
    console.warn(`  ⚠  Photo download failed:`);
    console.warn(`       URL    : ${photoUrl}`);
    console.warn(`       Reason : ${err.message}`);
    console.warn(`       Status : ${err.response?.status   ?? "no response"}`);
    console.warn(`       Code   : ${err.code               ?? "no error code"}`);
    return null;
  }
}

/**
 * Compress an image buffer to meet Hikvision's 200KB limit.
 *
 * Strategy:
 *   1. Resize to max 640×480 (maintains aspect ratio, never upscales)
 *   2. Convert to JPEG at INITIAL_QUALITY (85%)
 *   3. If still over 200KB → reduce quality in steps of 10 until under limit
 *   4. If MIN_QUALITY reached and still too big → resize smaller and retry
 *
 * @param {Buffer} imageBuffer  – raw downloaded image (any format)
 * @param {string} [label]      – person ID for logging
 * @returns {Promise<Buffer|null>}
 */
async function compressImage(imageBuffer, label = "") {
  try {
    const originalKB = Math.round(imageBuffer.length / 1024);

    // If already under limit — still convert to JPEG for compatibility
    // but skip heavy compression
    if (imageBuffer.length <= MAX_IMAGE_BYTES) {
      const converted = await sharp(imageBuffer)
        .resize(TARGET_WIDTH, TARGET_HEIGHT, {
          fit           : "inside",   // maintain aspect ratio
          withoutEnlargement: true,   // never upscale
        })
        .jpeg({ quality: INITIAL_QUALITY })
        .toBuffer();
      return converted;
    }

    console.log(
      `       🗜  Compressing image for ${label} ` +
      `(original: ${originalKB}KB, target: <${MAX_IMAGE_BYTES / 1024}KB) …`
    );

    let quality = INITIAL_QUALITY;
    let width   = TARGET_WIDTH;
    let height  = TARGET_HEIGHT;
    let result  = null;

    // ── Phase 1: reduce quality at target resolution ─────────────
    while (quality >= MIN_QUALITY) {
      result = await sharp(imageBuffer)
        .resize(width, height, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();

      if (result.length <= MAX_IMAGE_BYTES) {
        const finalKB = Math.round(result.length / 1024);
        console.log(
          `       ✔  Compressed to ${finalKB}KB ` +
          `at ${quality}% quality, ${width}×${height}`
        );
        return result;
      }

      quality -= 10;
    }

    // ── Phase 2: also reduce resolution if quality alone wasn't enough ──
    const resizeSteps = [
      [480, 360],
      [320, 240],
      [240, 180],
    ];

    for (const [w, h] of resizeSteps) {
      result = await sharp(imageBuffer)
        .resize(w, h, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: MIN_QUALITY })
        .toBuffer();

      if (result.length <= MAX_IMAGE_BYTES) {
        const finalKB = Math.round(result.length / 1024);
        console.log(
          `       ✔  Compressed to ${finalKB}KB ` +
          `at ${MIN_QUALITY}% quality, ${w}×${h}`
        );
        return result;
      }
    }

    // Return smallest result even if still slightly over — better than nothing
    const finalKB = Math.round(result.length / 1024);
    console.warn(`       ⚠  Could not compress below 200KB — uploading at ${finalKB}KB`);
    return result;

  } catch (err) {
    console.warn(`       ⚠  Image compression failed for ${label}: ${err.message}`);
    return null;
  }
}

/**
 * Clear photo_update_flag on the cloud after a successful device upload.
 * Sets flag to 1 (up to date).
 */
async function clearPhotoFlag(biometricNumber, type) {
  const endpoint = `${config.cloud.baseUrl}${config.cloud.personFlagEndpoint}`;
  await axios.post(endpoint, { biometric_number: biometricNumber, type }, {
    timeout: config.cloud.timeoutMs,
    headers: {
      "X-School-Code": config.cloud.schoolCode,
      "Content-Type" : "application/json",
    },
  });
}

/* ================================================================== */
/*  Core sync logic — runs per device                                   */
/* ================================================================== */

/**
 * Sync all persons to a single terminal.
 * ADD new → UPDATE changed → PUSH photos → DELETE removed.
 */
async function syncDevice(client, cloudPersons) {
  const result = {
    ip            : client.ip,
    added         : 0,
    updated       : 0,
    deleted       : 0,
    deletesSkipped: 0,
    photos        : 0,
    skipped       : 0,
    errors        : [],
  };

  console.log(`\n  ── Syncing to device: ${client.ip} ──`);

  // ── 1. Get current persons on the device ─────────────────────────
  let devicePersons;
  try {
    devicePersons = await getDevicePersons(client);
    console.log(`     Device has ${devicePersons.size} enrolled person(s).`);
  } catch (err) {
    result.errors.push(`Failed to read device persons: ${err.message}`);
    return result;
  }

  // ── 2. Build Set of cloud biometric numbers for quick lookup ──────
  const cloudNumbers = new Set(
    cloudPersons.map((p) => String(p.biometric_number))
  );

  // ── 3. ADD — persons in cloud not yet on device ───────────────────
  for (const person of cloudPersons) {
    const empNo = String(person.biometric_number);

    if (!devicePersons.has(empNo)) {
      // ── Add person ─────────────────────────────────────────────
      let personAdded = false;
      try {
        await addPerson(client, person);
        result.added++;
        personAdded = true;
        console.log(`     + Added  : ${empNo}  ${person.name}`);
      } catch (err) {
        result.errors.push(`ADD ${empNo}: ${err.message}`);
      }

      // ── Upload photo only if person was added successfully ──────
      if (personAdded && person.photo_update_flag === 0 && person.photo_url) {
        try {
          const raw = await fetchPhoto(person.photo_url);
          if (raw) {
            const img = await compressImage(raw, empNo);
            if (img) {
              await uploadFaceImage(client, empNo, img);
              result.photos++;
              console.log(`       📷 Photo uploaded for ${empNo} (${Math.round(img.length / 1024)}KB)`);
              await clearPhotoFlag(empNo, person.type).catch(() => {});
            }
          }
        } catch (err) {
          console.warn(`       ⚠  Photo upload failed for ${empNo}: ${err.message}`);
        }
      }
    }
  }

  // ── 4. UPDATE — persons on both sides ─────────────────────────────
  for (const person of cloudPersons) {
    const empNo = String(person.biometric_number);

    if (devicePersons.has(empNo)) {
      const devicePerson = devicePersons.get(empNo);
      const nameChanged  = devicePerson.name !== person.name;

      // ── Update name if changed ───────────────────────────────
      if (nameChanged) {
        try {
          await updatePerson(client, person);
          result.updated++;
          console.log(`     ↺ Updated: ${empNo}  ${person.name}`);
        } catch (err) {
          result.errors.push(`UPDATE ${empNo}: ${err.message}`);
        }
      }

      // ── Push photo when flag = 0 (separate try) ──────────────
      if (person.photo_update_flag === 0 && person.photo_url) {
        try {
          const raw = await fetchPhoto(person.photo_url);
          if (raw) {
            const img = await compressImage(raw, empNo);
            if (img) {
              await uploadFaceImage(client, empNo, img);
              result.photos++;
              console.log(`       📷 Photo updated for ${empNo} (${Math.round(img.length / 1024)}KB)`);
              await clearPhotoFlag(empNo, person.type).catch(() => {});
            }
          }
        } catch (err) {
          console.warn(`       ⚠  Photo upload failed for ${empNo}: ${err.message}`);
        }
      }
    }
  }

  // ── 5. DELETE — persons on device not in cloud ────────────────────
  const deleteCandidates = [...devicePersons.keys()].filter((e) => !cloudNumbers.has(e));

  const { deleteMaxAbs, deleteMaxRatio } = config.cloud.personSync;
  const deleteAllowed = Math.max(deleteMaxAbs, Math.ceil(deleteMaxRatio * devicePersons.size));

  if (deleteCandidates.length > deleteAllowed) {
    // Too many at once — almost always a bad cloud response, not a real
    // exodus. Skip ALL deletes for this device and shout about it.
    result.deletesSkipped = deleteCandidates.length;
    const msg =
      `DELETE ceiling hit on ${client.ip}: ${deleteCandidates.length} enrolled person(s) ` +
      `are absent from the cloud roster, over the safety limit of ${deleteAllowed} ` +
      `(max(${deleteMaxAbs}, ${Math.round(deleteMaxRatio * 100)}% of ${devicePersons.size})). ` +
      `NO deletions performed. If this many people genuinely left, raise ` +
      `CLOUD_PERSON_DELETE_MAX_ABS / CLOUD_PERSON_DELETE_MAX_RATIO, or remove them on the device manually.`;
    result.errors.push(msg);
    console.warn(`     ⚠  ${msg}`);
  } else {
    for (const empNo of deleteCandidates) {
      try {
        await deletePerson(client, empNo);
        result.deleted++;
        console.log(`     ✗ Deleted: ${empNo}`);
      } catch (err) {
        result.errors.push(`DELETE ${empNo}: ${err.message}`);
      }
    }
  }

  console.log(
    `     Summary → added: ${result.added}  updated: ${result.updated}  ` +
    `deleted: ${result.deleted}  deletes-skipped: ${result.deletesSkipped}  ` +
    `photos: ${result.photos}  errors: ${result.errors.length}`
  );

  return result;
}

/* ================================================================== */
/*  Main: runDeviceSync                                                 */
/* ================================================================== */

export async function runDeviceSync() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Device Person Sync  —  Hikvision ↔ Cloud School");
  console.log(`  Started : ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════");

  // ── 1. Discover all Hikvision devices ────────────────────────────
  let devices;
  try {
    devices = await discoverAllDevices();
  } catch (err) {
    console.error("✖  Device discovery failed:", err.message);
    process.exit(1);
  }

  if (devices.length === 0) {
    console.log("  No Hikvision devices found — nothing to sync.\n");
    return;
  }

  // ── 2. Fetch authoritative person list from cloud ─────────────────
  console.log("▶ Fetching person list from Cloud School System …");
  let cloudPersons;
  try {
    cloudPersons = await fetchCloudPersons();
    assertRosterSane(cloudPersons);
    // Drop any records with no usable biometric number so they cannot
    // pollute the "keep" set (which would make everyone else a delete).
    cloudPersons = cloudPersons.filter((p) => isUsableBiometric(p.biometric_number));
    console.log(`  Cloud roster: ${cloudPersons.length} valid person(s).\n`);
  } catch (err) {
    console.error("✖  Could not fetch / validate cloud persons:");
    console.error("   Message :", err.message);
    console.error("   URL     :", `${config.cloud.baseUrl}${config.cloud.personSyncEndpoint}`);
    console.error("   Status  :", err.response?.status ?? "no response");
    console.error("   Detail  :", err.response?.data   ?? "no response body");
    console.error("   Code    :", err.code              ?? "no error code");
    process.exit(1);
  }

  // ── 3. Sync each discovered device ───────────────────────────────
  const results = [];
  for (const device of devices) {
    try {
      const r = await syncDevice(device.client, cloudPersons);
      results.push(r);
    } catch (err) {
      console.error(`✖  Sync failed for ${device.ip}: ${err.message}`);
      results.push({ ip: device.ip, errors: [err.message] });
    }
  }

  // ── 4. Final summary ──────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Sync Complete");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of results) {
    const errs = r.errors?.length ?? 0;
    console.log(
      `  ${r.ip.padEnd(16)} ` +
      `added:${String(r.added   ?? 0).padStart(4)}  ` +
      `updated:${String(r.updated ?? 0).padStart(4)}  ` +
      `deleted:${String(r.deleted ?? 0).padStart(4)}  ` +
      `del-skip:${String(r.deletesSkipped ?? 0).padStart(4)}  ` +
      `photos:${String(r.photos  ?? 0).padStart(4)}  ` +
      `errors:${String(errs).padStart(3)}`
    );
    if (errs > 0) r.errors.forEach((e) => console.error(`    ⚠  ${e}`));
  }
  console.log(`\n  Finished: ${new Date().toISOString()}\n`);
}

/* ================================================================== */
/*  Standalone entry point                                              */
/* ================================================================== */

runDeviceSync().catch((err) => {
  console.error("✖  Unhandled error:", err.message);
  process.exit(1);
});

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/**
 * @typedef {object} PersonRecord
 * @property {string}       biometric_number  – device employeeNo
 * @property {string}       name              – full name
 * @property {0|1}          photo_update_flag – 0=pending push, 1=up to date
 * @property {string|null}  photo_url         – URL to download photo from
 * @property {"student"|"staff"} type
 */

/**
 * @typedef {object} SyncResult
 * @property {string}   ip
 * @property {number}   added
 * @property {number}   updated
 * @property {number}   deleted
 * @property {number}   photos
 * @property {number}   skipped
 * @property {string[]} errors
 */