/**
 * deviceDiscovery.js
 * ─────────────────────────────────────────────────────────────
 * Module: Hikvision Device Discovery & IP Auto-Healing
 *
 * Responsibility:
 *   1. Verify the TERMINAL_HOST in .env is still reachable.
 *   2. If unreachable → scan the local subnet for every live host.
 *   3. For each live host, attempt an ISAPI /deviceInfo probe.
 *   4. Match the responding device against TERMINAL_DEVICE_NAME.
 *   5. If a match is found → rewrite TERMINAL_HOST in .env and
 *      return the new IP so the rest of the middleware can continue
 *      without a restart.
 *
 * Why no mDNS / SADP?
 *   SADP (Hikvision's own discovery protocol) requires raw UDP
 *   sockets and elevated privileges on some OSes. This module
 *   uses pure HTTP/ISAPI so it works out of the box on any Node
 *   environment without extra system permissions.
 *
 * Dependencies (add to package.json):
 *   npm install axios dotenv
 * ─────────────────────────────────────────────────────────────
 */

import axios          from "axios";
import * as https     from "https";
import * as fs        from "fs";
import * as os        from "os";
import * as path      from "path";
import * as url       from "url";
import * as crypto    from "crypto";

/* ------------------------------------------------------------------ */
/*  Optional XML parser — install with:  npm install xml2js            */
/*  If not installed the raw XML string is still returned as-is        */
/*  so the name-match can still work on the raw text.                  */
/* ------------------------------------------------------------------ */
let parseXml = null;
try {
  const { parseStringPromise } = await import("xml2js");
  parseXml = parseStringPromise;
} catch {
  // xml2js not installed — fallback to regex extraction
}

/* ================================================================== */
/*  Locate the .env file                                                */
/* ================================================================== */

/** Resolve .env relative to this module's location. */
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ENV_PATH  = path.resolve(__dirname, ".env");

/* ================================================================== */
/*  Digest-Auth (same lightweight implementation as hikvisionClient)   */
/* ================================================================== */

function digestParam(header, key) {
  const q = header.match(new RegExp(`${key}="([^"]+)"`));
  if (q) return q[1];
  const u = header.match(new RegExp(`${key}=([^,\\s]+)`));
  return u ? u[1] : "";
}

function buildDigestAuth(method, uri, username, password, wwwAuth) {
  const realm  = digestParam(wwwAuth, "realm");
  const nonce  = digestParam(wwwAuth, "nonce");
  const qop    = digestParam(wwwAuth, "qop");
  const opaque = digestParam(wwwAuth, "opaque");
  const algo   = digestParam(wwwAuth, "algorithm") || "MD5";
  const md5    = (s) => crypto.createHash("md5").update(s).digest("hex");

  const ha1 = algo.toUpperCase() === "MD5-SESS"
    ? md5(`${md5(`${username}:${realm}:${password}`)}:${nonce}:`)
    : md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  let response, extras = "";
  if (qop === "auth" || qop === "auth-int") {
    const nc = "00000001", cnonce = crypto.randomBytes(8).toString("hex");
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    extras   = `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }

  return (
    `Digest username="${username}", realm="${realm}", nonce="${nonce}", ` +
    `uri="${uri}", algorithm=${algo}, response="${response}"` +
    (opaque ? `, opaque="${opaque}"` : "") + extras
  );
}

/* ================================================================== */
/*  Low-level helpers                                                   */
/* ================================================================== */

const ISAPI_DEVICE_INFO = "/ISAPI/System/deviceInfo";
const PROBE_TIMEOUT_MS  = 2_500;   // per-host timeout during subnet scan
const SCAN_CONCURRENCY  = 30;      // hosts probed simultaneously

/** Shared https agent that ignores self-signed certs. */
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Extract a named field value from an XML string using a simple regex.
 * Used as a fallback when xml2js is not installed.
 *
 * @param {string} xml
 * @param {string} tag
 * @returns {string|null}
 */
function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, "i"));
  return m ? m[1].trim() : null;
}

/**
 * Normalise a raw ISAPI response body into a flat DeviceInfo object
 * regardless of whether the device returned JSON or XML.
 *
 * Hikvision devices (especially older/embedded firmware) return XML
 * by default. Passing ?format=json or Accept: application/json
 * makes some models return JSON — but not all. This function handles
 * both transparently.
 *
 * @param {any}    data         – axios response data (string or object)
 * @param {string} contentType  – value of Content-Type header
 * @returns {Promise<object|null>}
 */
async function normaliseDeviceInfo(data, contentType) {
  const ct = (contentType ?? "").toLowerCase();

  /* ── JSON response ── */
  if (ct.includes("json") || (typeof data === "object" && data !== null)) {
    const obj = typeof data === "string" ? JSON.parse(data) : data;
    // Some firmware wraps it: { DeviceInfo: { ... } }
    // Others return the flat object directly
    const info = obj?.DeviceInfo ?? obj;
    return {
      deviceName    : info.deviceName     ?? info.DeviceName     ?? null,
      model         : info.model          ?? info.Model          ?? null,
      serialNumber  : info.serialNumber   ?? info.SerialNumber   ?? null,
      firmwareVersion: info.firmwareVersion ?? info.FirmwareVersion ?? null,
      macAddress    : info.macAddress     ?? info.MacAddress     ?? null,
      _raw          : info,
    };
  }

  /* ── XML response ── */
  const xmlStr = typeof data === "string" ? data : String(data);
  if (!xmlStr.trim().startsWith("<")) return null;

  let parsed = null;

  if (parseXml) {
    // xml2js available — proper parse
    try {
      const result = await parseXml(xmlStr, { explicitArray: false, ignoreAttrs: false });
      const info   = result?.DeviceInfo ?? result;
      parsed = {
        deviceName    : info.deviceName     ?? null,
        model         : info.model          ?? null,
        serialNumber  : info.serialNumber   ?? null,
        firmwareVersion: info.firmwareVersion ?? null,
        macAddress    : info.macAddress     ?? null,
        _raw          : info,
      };
    } catch { /* fall through to regex */ }
  }

  if (!parsed) {
    // Regex fallback — works without any extra package
    parsed = {
      deviceName    : xmlField(xmlStr, "deviceName"),
      model         : xmlField(xmlStr, "model"),
      serialNumber  : xmlField(xmlStr, "serialNumber"),
      firmwareVersion: xmlField(xmlStr, "firmwareVersion"),
      macAddress    : xmlField(xmlStr, "macAddress"),
      _raw          : xmlStr,
    };
  }

  // Return null only if every field is null (device returned junk)
  const hasData = Object.entries(parsed)
    .filter(([k]) => k !== "_raw")
    .some(([, v]) => v !== null);

  return hasData ? parsed : null;
}

/**
 * Attempt a single ISAPI /deviceInfo request against a given IP.
 * Returns a normalised DeviceInfo object on success, null on any failure.
 *
 * Tries both ?format=json and plain GET to maximise compatibility
 * across different Hikvision firmware versions.
 *
 * @param {string}  ip
 * @param {number}  port
 * @param {string}  username
 * @param {string}  password
 * @param {boolean} useHttps
 * @returns {Promise<object|null>}
 */
async function probeDevice(ip, port, username, password, useHttps = false) {
  const scheme  = useHttps ? "https" : "http";
  const baseURL = `${scheme}://${ip}:${port}`;

  const http = axios.create({
    baseURL,
    timeout       : PROBE_TIMEOUT_MS,
    httpsAgent,
    validateStatus: (s) => s < 500,
    // Keep response as text so we can decide how to parse it
    responseType  : "text",
  });

  // We try two paths: plain and ?format=json
  // Some firmware honours ?format=json, others ignore it and return XML either way.
  const attempts = [
    { path: ISAPI_DEVICE_INFO + "?format=json", accept: "application/json" },
    { path: ISAPI_DEVICE_INFO,                  accept: "text/xml, application/xml, */*" },
  ];

  for (const { path: reqPath, accept } of attempts) {
    try {
      // ── Step 1: unauthenticated probe ──
      const probe = await http.get(reqPath, {
        headers: { Accept: accept },
      });

      if (probe.status !== 401) continue;

      const wwwAuth = probe.headers["www-authenticate"];
      if (!wwwAuth) continue;

      // ── Step 2: digest-authenticated request ──
      const authHeader = buildDigestAuth("GET", reqPath, username, password, wwwAuth);
      const authed = await http.get(reqPath, {
        headers: { Authorization: authHeader, Accept: accept },
      });

      if (authed.status !== 200) continue;

      const info = await normaliseDeviceInfo(
        authed.data,
        authed.headers["content-type"]
      );

      if (info) return info;   // success — stop trying

    } catch {
      // host unreachable, refused, timeout — silently skip this attempt
    }
  }

  return null;   // all attempts exhausted
}

/* ================================================================== */
/*  Subnet detection                                                    */
/* ================================================================== */

/**
 * Known virtual/hypervisor adapter name patterns to deprioritise.
 * These are common prefixes used by VirtualBox, VMware, Hyper-V, WSL,
 * and Docker virtual network interfaces.
 */
const VIRTUAL_IFACE_PATTERNS = [
  /virtualbox/i, /vmware/i, /vmnet/i, /vethernet/i,
  /wsl/i, /docker/i, /hyper-v/i, /loopback/i,
  /^veth/i, /^virbr/i, /^lxc/i, /^tun/i, /^tap/i,
];

/**
 * Heuristic: does this interface name look like a virtual adapter?
 * @param {string} name
 * @returns {boolean}
 */
function isVirtualIface(name) {
  return VIRTUAL_IFACE_PATTERNS.some((p) => p.test(name));
}

/**
 * Collect ALL non-loopback IPv4 subnets (/24 bases) present on this
 * machine, sorted so real physical/WiFi adapters come first.
 *
 * Returns an array of objects so callers can log interface names
 * alongside the subnet for easier debugging.
 *
 * @returns {{ name: string, address: string, subnet: string }[]}
 */
function detectAllSubnets() {
  const ifaces  = os.networkInterfaces();
  const results = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const subnet = addr.address.split(".").slice(0, 3).join(".");
      results.push({ name, address: addr.address, subnet });
    }
  }

  if (results.length === 0) {
    throw new Error(
      "Could not detect any local IPv4 network interface. " +
      "Check your network connection."
    );
  }

  // Sort: real adapters (ethernet / wifi) first, virtual last
  results.sort((a, b) => {
    const aVirt = isVirtualIface(a.name) ? 1 : 0;
    const bVirt = isVirtualIface(b.name) ? 1 : 0;
    return aVirt - bVirt;
  });

  return results;
}

/**
 * Generate all 254 host addresses for a /24 subnet.
 *
 * @param {string} base  e.g. "192.168.1"
 * @returns {string[]}
 */
function subnetHosts(base) {
  return Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
}

/* ================================================================== */
/*  .env rewriter                                                       */
/* ================================================================== */

/**
 * Rewrite the value of a single key in the .env file in-place.
 * Preserves all comments and surrounding lines.
 *
 * @param {string} key      – env variable name, e.g. "TERMINAL_HOST"
 * @param {string} newValue – new value to set
 */
function updateEnvFile(key, newValue) {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`Cannot find .env file at: ${ENV_PATH}`);
  }

  const raw     = fs.readFileSync(ENV_PATH, "utf8");
  const pattern = new RegExp(`^(${key}\\s*=).*$`, "m");

  if (!pattern.test(raw)) {
    // Key not found — append it
    const updated = raw.trimEnd() + `\n${key}=${newValue}\n`;
    fs.writeFileSync(ENV_PATH, updated, "utf8");
    return;
  }

  const updated = raw.replace(pattern, `$1${newValue}`);
  fs.writeFileSync(ENV_PATH, updated, "utf8");
}

/* ================================================================== */
/*  Name matching                                                       */
/* ================================================================== */

/**
 * Decide whether a DeviceInfo response is the target device.
 *
 * Matching is case-insensitive and checks:
 *   • deviceName, model, serialNumber, macAddress
 *   • raw XML string (fallback — searches the whole body)
 *
 * @param {object} info         – normalised DeviceInfo from probeDevice()
 * @param {string} targetName   – TERMINAL_DEVICE_NAME from .env
 * @returns {boolean}
 */
function isTargetDevice(info, targetName) {
  if (!info || !targetName) return false;
  const target = targetName.toLowerCase().trim();

  const candidates = [
    info.deviceName,
    info.model,
    info.serialNumber,
    info.macAddress,
  ].filter(Boolean).map((v) => String(v).toLowerCase().trim());

  const fieldMatch = candidates.some(
    (c) => c === target || c.includes(target) || target.includes(c)
  );
  if (fieldMatch) return true;

  // Last resort: search the entire raw XML/JSON string
  if (info._raw) {
    const rawStr = (typeof info._raw === "string"
      ? info._raw
      : JSON.stringify(info._raw)
    ).toLowerCase();
    return rawStr.includes(target);
  }

  return false;
}

/* ================================================================== */
/*  Concurrency helper                                                  */
/* ================================================================== */

/**
 * Run an async task over an array with a concurrency cap.
 *
 * @template T, R
 * @param {T[]}                items
 * @param {number}             concurrency
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function pMap(items, concurrency, fn) {
  const results = [];
  let   index   = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker
  );
  await Promise.all(workers);
  return results;
}

/* ================================================================== */
/*  Main export: ensureDeviceReachable                                  */
/* ================================================================== */

/**
 * Verify the configured terminal IP is reachable.
 * If not, scan the local subnet, find the matching Hikvision device
 * by name, update .env, and return the new IP.
 *
 * @param {object} cfg
 * @param {string}  cfg.host           – current TERMINAL_HOST from config
 * @param {number}  cfg.port           – TERMINAL_PORT
 * @param {string}  cfg.username       – TERMINAL_USERNAME
 * @param {string}  cfg.password       – TERMINAL_PASSWORD
 * @param {boolean} cfg.useHttps       – TERMINAL_USE_HTTPS
 * @param {string}  cfg.deviceName     – TERMINAL_DEVICE_NAME (used to match device)
 *
 * @returns {Promise<DiscoveryResult>}
 */
export async function ensureDeviceReachable(cfg) {
  const { host, port, username, password, useHttps, deviceName } = cfg;

  /* ── 1. Try the configured IP first ─────────────────────────── */
  console.log(`▶ Verifying terminal at ${host}:${port} …`);
  const currentInfo = await probeDevice(host, port, username, password, useHttps);

  if (currentInfo) {
    console.log(`  ✔  Terminal reachable at ${host}`);
    console.log(`     Model  : ${currentInfo.model        ?? "N/A"}`);
    console.log(`     Serial : ${currentInfo.serialNumber ?? "N/A"}`);
    console.log(`     Name   : ${currentInfo.deviceName   ?? "N/A"}`);
    return { ip: host, changed: false, info: currentInfo };
  }

  /* ── 2. Configured IP failed — begin subnet scan ────────────── */
  console.warn(`  ⚠  Cannot reach ${host}. Starting subnet discovery …\n`);

  let subnets;
  try {
    subnets = detectAllSubnets();
  } catch (err) {
    throw new Error(`Subnet detection failed: ${err.message}`);
  }

  // Log every detected interface so the user can see what was found
  console.log("  Detected network interfaces:");
  for (const s of subnets) {
    const tag = isVirtualIface(s.name) ? " (virtual — lower priority)" : " ✔ (physical)";
    console.log(`    ${s.name.padEnd(30)} ${s.address}  →  scanning ${s.subnet}.0/24${tag}`);
  }
  console.log("");

  // Deduplicate subnets (a machine may have multiple IPs on the same /24)
  const uniqueSubnets = [...new Map(subnets.map((s) => [s.subnet, s])).values()];

  const found = [];   // { ip, info }

  for (const { name: ifaceName, subnet } of uniqueSubnets) {
    const allHosts = subnetHosts(subnet);
    console.log(
      `  Scanning ${allHosts.length} hosts on ${subnet}.0/24` +
      `  [interface: ${ifaceName}]`
    );
    console.log(`  Concurrency: ${SCAN_CONCURRENCY}, timeout per host: ${PROBE_TIMEOUT_MS}ms`);

    await pMap(allHosts, SCAN_CONCURRENCY, async (ip) => {
      const info = await probeDevice(ip, port, username, password, useHttps);
      if (info) {
        const name   = info.deviceName   ?? "";
        const model  = info.model        ?? "";
        const serial = info.serialNumber ?? "";
        console.log(
          `  📡 Hikvision found: ${ip}  ` +
          `[${model || "unknown model"}]  \nserial: ${serial}  \nname: "${name}"`
        );
        found.push({ ip, info });
      }
    });

    console.log(`  Done scanning ${subnet}.0/24\n`);

    // Stop early if we already matched the target device
    if (deviceName && found.some(({ info }) => isTargetDevice(info, deviceName))) {
      console.log("  ✔  Target device already found — skipping remaining subnets.\n");
      break;
    }
  }

  console.log(`  Scan complete. ${found.length} Hikvision device(s) found across all subnets.\n`);

  if (found.length === 0) {
    const scannedSubnets = uniqueSubnets.map((s) => `${s.subnet}.0/24`).join(", ");
    throw new Error(
      `No Hikvision devices responded on: ${scannedSubnets}\n` +
      `  • Ensure the terminal is powered on and connected to the same network.\n` +
      `  • Confirm the admin credentials in .env are correct.\n` +
      `  • Check that HTTP port ${port} is not firewalled.\n` +
      `  • If on a different subnet, set TERMINAL_HOST manually in .env.`
    );
  }

  /* ── 3. Match by device name ────────────────────────────────── */
  if (!deviceName) {
    throw new Error(
      `TERMINAL_DEVICE_NAME is not set in .env.\n` +
      `  Set it to the device name, model, or serial shown above so\n` +
      `  the middleware knows which device to connect to.`
    );
  }

  const match = found.find(({ info }) => isTargetDevice(info, deviceName));

  if (!match) {
    // Print all found devices to help the user configure the name
    console.error(`  ✖  No device matched TERMINAL_DEVICE_NAME="${deviceName}"\n`);
    console.error("  Devices found on the network:\n");
    found.forEach(({ ip, info }) => {
      console.error(`    IP: ${ip}`);
      console.error(`      deviceName   : ${info.deviceName   ?? "—"}`);
      console.error(`      model        : ${info.model        ?? "—"}`);
      console.error(`      serialNumber : ${info.serialNumber ?? "—"}`);
      console.error(`      macAddress   : ${info.macAddress   ?? "—"}\n`);
    });
    console.error(
      `  Set TERMINAL_DEVICE_NAME in .env to one of the values above\n` +
      `  (deviceName, model, or serialNumber all work).`
    );
    throw new Error(`Device matching "${deviceName}" not found on the network.`);
  }

  /* ── 4. Match found — update .env ───────────────────────────── */
  const newIp = match.ip;
  console.log(`  ✔  Matched device "${deviceName}" → new IP: ${newIp}`);
  console.log(`     Updating TERMINAL_HOST in .env …`);

  try {
    updateEnvFile("TERMINAL_HOST", newIp);
    // Also patch process.env so the running process uses the new IP
    // immediately without needing a restart.
    process.env.TERMINAL_HOST = newIp;
    console.log(`  ✔  .env updated. TERMINAL_HOST is now ${newIp}\n`);
  } catch (err) {
    console.warn(`  ⚠  Could not write .env: ${err.message}`);
    console.warn(`     Continuing with discovered IP ${newIp} for this session.\n`);
  }

  return { ip: newIp, changed: true, info: match.info };
}

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/**
 * @typedef {object} DiscoveryResult
 * @property {string}  ip      – the IP address of the reachable terminal
 * @property {boolean} changed – true if the IP was different from .env
 * @property {object}  info    – raw DeviceInfo returned by the terminal
 */