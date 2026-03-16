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
 *            + photo update ONLY when photo_update_flag = 1
 *   DELETE — persons on the device no longer in the cloud system
 *
 * Biometric prefix convention:
 *   Students : 1xxxxxx
 *   Staff    : 2xxxxxx
 *
 * Prerequisites:
 *   npm install axios form-data
 * ─────────────────────────────────────────────────────────────
 */

import axios      from "axios";
import FormData   from "form-data";
import * as https from "https";
import * as crypto from "crypto";
import * as os    from "os";
import config     from "./config.js";

/* ================================================================== */
/*  Constants                                                           */
/* ================================================================== */

const PROBE_TIMEOUT_MS  = 2_500;
const SCAN_CONCURRENCY  = 30;
const REQUEST_TIMEOUT   = 12_000;

const ISAPI_PERSON_LIST   = "/ISAPI/AccessControl/UserInfo/Search?format=json";
const ISAPI_PERSON_ADD    = "/ISAPI/AccessControl/UserInfo/Record?format=json";
const ISAPI_PERSON_UPDATE = "/ISAPI/AccessControl/UserInfo/Modify?format=json";
const ISAPI_PERSON_DELETE = "/ISAPI/AccessControl/UserInfo/Delete?format=json";
const ISAPI_FACE_UPLOAD   = (employeeNo) =>
  `/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json&employeeNo=${employeeNo}`;

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
  const realm = digestParam(wwwAuth, "realm");
  const nonce = digestParam(wwwAuth, "nonce");
  const qop   = digestParam(wwwAuth, "qop");
  const opaque= digestParam(wwwAuth, "opaque");
  const algo  = digestParam(wwwAuth, "algorithm") || "MD5";
  const md5   = (s) => crypto.createHash("md5").update(s).digest("hex");

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
/*  Per-device HTTP client with Digest Auth                            */
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
    const METHOD = method.toUpperCase();
    const headers = isFormData
      ? {}
      : { "Content-Type": "application/json" };

    // Step 1 — probe
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

    // Step 2 — authenticated
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
/*  Network scanner — find ALL Hikvision devices                       */
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
 * Probe a single IP — returns DeviceInfo or null.
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

      // Parse XML or JSON
      const raw = authed.data;
      const info = {};

      if (typeof raw === "string" && raw.trim().startsWith("<")) {
        const field = (tag) => {
          const m = raw.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
          return m ? m[1].trim() : null;
        };
        info.model         = field("model");
        info.serialNumber  = field("serialNumber");
        info.deviceName    = field("deviceName");
        info.firmwareVersion = field("firmwareVersion");
      } else {
        const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
        const d   = obj?.DeviceInfo ?? obj;
        info.model            = d.model         ?? null;
        info.serialNumber     = d.serialNumber  ?? null;
        info.deviceName       = d.deviceName    ?? null;
        info.firmwareVersion  = d.firmwareVersion ?? null;
      }

      // Any Hikvision device has a model or serial — if we got here it's valid
      if (info.model || info.serialNumber) return { ip, info };

    } catch { /* unreachable host */ }
  }
  return null;
}

/**
 * Scan the entire local network and return all Hikvision devices found.
 * @returns {Promise<Array<{ ip: string, info: object, client: DeviceClient }>>}
 */
export async function discoverAllDevices() {
  const { terminal: t } = config;
  const subnets = detectAllSubnets();

  console.log("\n▶ Discovering Hikvision devices on local network …");
  subnets.forEach((s) =>
    console.log(`  Scanning ${s.subnet}.0/24  [${s.name}]${s.virtual ? " (virtual)" : ""}`)
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
        devices.push({
          ip    : ip,
          info  : result.info,
          client: new DeviceClient(ip, t.port, t.username, t.password, t.useHttps),
        });
      }
    });

    // Stop early if we already found at least one device and scanned a
    // real (non-virtual) subnet — avoids scanning virtual subnets needlessly
    if (devices.length > 0 && !subnets.find((s) => s.subnet === subnet)?.virtual) break;
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
 *
 * @param {DeviceClient} client
 * @returns {Promise<Map<string, object>>}
 */
async function getDevicePersons(client) {
  const payload = {
    UserInfoSearchCond: {
      searchID            : "1",
      searchResultPosition: 0,
      maxResults          : 100,
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
 *
 * @param {DeviceClient} client
 * @param {PersonRecord} person
 */
async function addPerson(client, person) {
  const payload = {
    UserInfo: {
      employeeNo  : String(person.biometric_number),
      name        : person.name,
      userType    : "normal",
      Valid       : { enable: true, beginTime: "2000-01-01T00:00:00", endTime: "2037-12-31T23:59:59" },
      doorRight   : "1",
      RightPlan   : [{ doorNo: 1, planTemplateNo: "1" }],
    },
  };

  const res = await client.request("POST", ISAPI_PERSON_ADD, JSON.stringify(payload));
  return res;
}

/**
 * Update an existing person's details on the terminal.
 *
 * @param {DeviceClient} client
 * @param {PersonRecord} person
 */
async function updatePerson(client, person) {
  const payload = {
    UserInfo: {
      employeeNo: String(person.biometric_number),
      name      : person.name,
    },
  };

  const res = await client.request("PUT", ISAPI_PERSON_UPDATE, JSON.stringify(payload));
  return res;
}

/**
 * Delete a person from the terminal by employeeNo.
 *
 * @param {DeviceClient} client
 * @param {string} employeeNo
 */
async function deletePerson(client, employeeNo) {
  const payload = {
    UserInfoDelCond: {
      EmployeeNoList: [{ employeeNo: String(employeeNo) }],
    },
  };

  const res = await client.request("PUT", ISAPI_PERSON_DELETE, JSON.stringify(payload));
  return res;
}

/**
 * Upload a face image for a person on the terminal.
 * The image must be a JPEG Buffer or base64 string.
 *
 * @param {DeviceClient} client
 * @param {string}       employeeNo
 * @param {Buffer}       imageBuffer  – JPEG image data
 */
async function uploadFaceImage(client, employeeNo, imageBuffer) {
  // Hikvision ISAPI expects a multipart/form-data upload for face images
  const form = new FormData();

  form.append("FaceDataRecord", JSON.stringify({
    faceLibType  : "blackFD",
    FDID         : "1",
    FPID         : String(employeeNo),
  }), { contentType: "application/json" });

  form.append("FaceImage", imageBuffer, {
    filename    : `${employeeNo}.jpg`,
    contentType : "image/jpeg",
  });

  // For FormData we need a two-step manual digest request
  const path = ISAPI_FACE_UPLOAD(employeeNo);
  const METHOD = "POST";

  const probe = await client.http.request({
    method : METHOD,
    url    : path,
    data   : form,
    headers: form.getHeaders(),
  });

  if (probe.status !== 401) return client._parse(probe.data);

  const wwwAuth = probe.headers["www-authenticate"];
  if (!wwwAuth) throw new Error(`Face upload 401 — no WWW-Authenticate`);

  const authHeader = buildDigestAuth(METHOD, path, client.username, client.password, wwwAuth);
  const authed = await client.http.request({
    method : METHOD,
    url    : path,
    data   : form,
    headers: { ...form.getHeaders(), Authorization: authHeader },
  });

  return client._parse(authed.data);
}

/* ================================================================== */
/*  Fetch persons from Cloud School System                              */
/* ================================================================== */

/**
 * Fetch the full person list (students + staff) from the cloud API.
 * The cloud endpoint returns persons with photo_update_flag and
 * sync_delete_flag already evaluated server-side.
 *
 * Expected response shape:
 * {
 *   "persons": [
 *     {
 *       "biometric_number": "1000001",
 *       "name"            : "JANE DOE",
 *       "photo_update_flag": 0 | 1,
 *       "photo_url"       : "https://..../photo.jpg" | null,
 *       "type"            : "student" | "staff"
 *     },
 *     ...
 *   ]
 * }
 *
 * @returns {Promise<PersonRecord[]>}
 */
async function fetchCloudPersons() {
  const url = `${config.cloud.baseUrl}${config.cloud.personSyncEndpoint}`;

  const res = await axios.get(url, {
    timeout: config.cloud.timeoutMs,
    headers: {
      "X-School-Code": config.cloud.schoolCode,
    },
  });

  return res.data?.persons ?? [];
}

/**
 * Fetch a photo from a URL and return it as a Buffer.
 * Returns null if the URL is empty or the download fails.
 *
 * @param {string} photoUrl
 * @returns {Promise<Buffer|null>}
 */
async function fetchPhoto(photoUrl) {
  if (!photoUrl) return null;
  try {
    const res = await axios.get(photoUrl, {
      responseType: "arraybuffer",
      timeout     : 15_000,
    });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

/**
 * Notify the cloud API that photo_update_flag should be cleared
 * for a person after their photo has been successfully pushed.
 *
 * @param {string} biometricNumber
 * @param {string} type  – "student" | "staff"
 */
async function clearPhotoFlag(biometricNumber, type) {
  const url = `${config.cloud.baseUrl}${config.cloud.personFlagEndpoint}`;
  await axios.post(url, { biometric_number: biometricNumber, type }, {
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
 *
 * @param {DeviceClient}  client
 * @param {PersonRecord[]} cloudPersons  – authoritative list from cloud
 * @returns {Promise<SyncResult>}
 */
async function syncDevice(client, cloudPersons) {
  const result = {
    ip     : client.ip,
    added  : 0,
    updated: 0,
    deleted: 0,
    photos : 0,
    skipped: 0,
    errors : [],
  };

  console.log(`\n  ── Syncing to device: ${client.ip} ──`);

  // ── 1. Get current persons on the device ──────────────────────────
  let devicePersons;
  try {
    devicePersons = await getDevicePersons(client);
    console.log(`     Device has ${devicePersons.size} enrolled person(s).`);
  } catch (err) {
    result.errors.push(`Failed to read device persons: ${err.message}`);
    return result;
  }

  // ── 2. Build a set of cloud biometric numbers for quick lookup ────
  const cloudNumbers = new Set(
    cloudPersons.map((p) => String(p.biometric_number))
  );

  // ── 3. ADD — persons in cloud not on device ───────────────────────
  for (const person of cloudPersons) {
    const empNo = String(person.biometric_number);

    if (!devicePersons.has(empNo)) {
      try {
        await addPerson(client, person);
        result.added++;
        console.log(`     + Added  : ${empNo}  ${person.name}`);

        // Upload photo if flag is set
        if (person.photo_update_flag === 1 && person.photo_url) {
          const img = await fetchPhoto(person.photo_url);
          if (img) {
            await uploadFaceImage(client, empNo, img);
            result.photos++;
            console.log(`       📷 Photo uploaded for ${empNo}`);
            // Clear the flag on cloud after successful upload
            await clearPhotoFlag(empNo, person.type).catch(() => {});
          }
        }
      } catch (err) {
        result.errors.push(`ADD ${empNo}: ${err.message}`);
      }
    }
  }

  // ── 4. UPDATE — persons on both sides ────────────────────────────
  for (const person of cloudPersons) {
    const empNo = String(person.biometric_number);

    if (devicePersons.has(empNo)) {
      const devicePerson = devicePersons.get(empNo);
      const nameChanged  = devicePerson.name !== person.name;

      try {
        // Only call update if something changed
        if (nameChanged) {
          await updatePerson(client, person);
          result.updated++;
          console.log(`     ↺ Updated: ${empNo}  ${person.name}`);
        }

        // Update photo only when photo_update_flag = 1
        if (person.photo_update_flag === 1 && person.photo_url) {
          const img = await fetchPhoto(person.photo_url);
          if (img) {
            await uploadFaceImage(client, empNo, img);
            result.photos++;
            console.log(`       📷 Photo updated for ${empNo}`);
            await clearPhotoFlag(empNo, person.type).catch(() => {});
          }
        }
      } catch (err) {
        result.errors.push(`UPDATE ${empNo}: ${err.message}`);
      }
    }
  }

  // ── 5. DELETE — persons on device not in cloud ────────────────────
  for (const [empNo] of devicePersons) {
    if (!cloudNumbers.has(empNo)) {
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
    `deleted: ${result.deleted}  photos: ${result.photos}  ` +
    `errors: ${result.errors.length}`
  );

  return result;
}

/* ================================================================== */
/*  Main export: runDeviceSync                                          */
/* ================================================================== */

/**
 * Entry point — discovers all devices and syncs persons to each.
 * Called by the PM2 cron every 2 hours.
 *
 * @returns {Promise<void>}
 */
export async function runDeviceSync() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Device Person Sync  —  Hikvision ↔ Cloud School");
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log("═══════════════════════════════════════════════════════");

  // ── 1. Discover all Hikvision devices on the network ────────────
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

  // ── 2. Fetch authoritative person list from cloud ────────────────
  console.log("▶ Fetching person list from Cloud School System …");
  let cloudPersons;
  try {
    cloudPersons = await fetchCloudPersons();
    console.log(`  Cloud returned ${cloudPersons.length} person(s).\n`);
  } catch (err) {
    console.error("✖  Could not fetch cloud persons:", err.message);
    process.exit(1);
  }

  // ── 3. Sync each discovered device ──────────────────────────────
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

  // ── 4. Final summary ─────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Sync Complete");
  console.log("═══════════════════════════════════════════════════════");
  for (const r of results) {
    const errs = r.errors?.length ?? 0;
    console.log(
      `  ${r.ip.padEnd(16)} ` +
      `added:${String(r.added ?? 0).padStart(4)}  ` +
      `updated:${String(r.updated ?? 0).padStart(4)}  ` +
      `deleted:${String(r.deleted ?? 0).padStart(4)}  ` +
      `photos:${String(r.photos ?? 0).padStart(4)}  ` +
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
 * @property {string}  biometric_number  – device employeeNo
 * @property {string}  name              – full name
 * @property {0|1}     photo_update_flag – 1 = photo needs uploading
 * @property {string|null} photo_url     – URL to fetch the photo from
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