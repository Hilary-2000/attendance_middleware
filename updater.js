/**
 * updater.js
 * ─────────────────────────────────────────────────────────────
 * Standalone GitHub Auto-Updater
 *
 * Completely independent — does NOT import anything from the
 * rest of the middleware. Safe to run at any time without
 * affecting the running application.
 *
 * What it does:
 *   1. Checks if the local code is behind GitHub
 *   2. Shows exactly which files changed
 *   3. Pulls the latest code
 *   4. Runs npm install if package.json changed
 *   5. Reports the commits that were applied
 *
 * Usage:
 *   node updater.js                 — check and update if behind
 *   node updater.js --check         — check only, do not pull
 *   node updater.js --force         — pull even if up to date
 *   node updater.js --branch main   — specify branch (default: main)
 *
 * Prerequisites:
 *   • Git installed and available in PATH
 *   • Project is a Git repo connected to a GitHub remote
 *   • No other dependencies needed — uses Node built-ins only
 * ─────────────────────────────────────────────────────────────
 */

import { execSync, spawnSync } from "child_process";
import * as fs                 from "fs";
import * as path               from "path";
import * as url                from "url";
import config                  from "./config.js";

/* ================================================================== */
/*  Project root                                                        */
/* ================================================================== */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT      = __dirname;
const PKG_PATH  = path.join(ROOT, "package.json");

/* ================================================================== */
/*  CLI flags                                                           */
/* ================================================================== */

const args       = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const FORCE      = args.includes("--force");
const branchFlag = args.indexOf("--branch");

// Branch: CLI flag > config.js (GITHUB_BRANCH in .env) > fallback "main"
const BRANCH     = branchFlag !== -1 && args[branchFlag + 1]
  ? args[branchFlag + 1]
  : (config.github?.branch ?? "main");

/* ================================================================== */
/*  Console helpers                                                     */
/* ================================================================== */

const log   = (msg) => console.log(msg);
const ok    = (msg) => console.log(`  ✔  ${msg}`);
const warn  = (msg) => console.warn(`  ⚠  ${msg}`);
const fail  = (msg) => console.error(`  ✖  ${msg}`);
const info  = (msg) => console.log(`  ${msg}`);
const step  = (msg) => console.log(`\n▶ ${msg}`);

/* ================================================================== */
/*  Shell helpers                                                       */
/* ================================================================== */

/**
 * Run a command, return trimmed stdout.
 * Throws on non-zero exit code.
 *
 * @param {string} cmd
 * @returns {string}
 */
function run(cmd) {
  return execSync(cmd, {
    cwd  : ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  }).toString().trim();
}

/**
 * Run a command with output streamed directly to the terminal.
 * Returns the exit code.
 *
 * @param {string}   cmd
 * @param {string[]} args
 * @returns {number}
 */
function runVisible(cmd, cmdArgs = []) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd  : ROOT,
    stdio: "inherit",
    shell: true,
  });
  return result.status ?? 1;
}

/* ================================================================== */
/*  Git helpers                                                         */
/* ================================================================== */

function isGitRepo() {
  try { run("git rev-parse --is-inside-work-tree"); return true; }
  catch { return false; }
}

function getLocalCommit()        { return run("git rev-parse --short HEAD"); }
function getLocalCommitFull()    { return run("git rev-parse HEAD"); }
function getCurrentBranch()      { return run("git rev-parse --abbrev-ref HEAD"); }
function getRemoteName()         {
  try { return run("git remote"); }
  catch { return "origin"; }
}

function fetchRemote(remote, branch) {
  run(`git fetch ${remote} ${branch} --quiet`);
}

function getRemoteCommit(remote, branch) {
  return run(`git rev-parse --short ${remote}/${branch}`);
}

function getCommitsBehind(remote, branch) {
  const count = run(`git rev-list HEAD..${remote}/${branch} --count`);
  return parseInt(count, 10) || 0;
}

function getChangedFiles(remote, branch) {
  const out = run(`git diff --name-only HEAD ${remote}/${branch}`);
  return out ? out.split("\n").filter(Boolean) : [];
}

function getCommitLog(fromCommit, remote, branch) {
  try {
    return run(`git log ${fromCommit}..${remote}/${branch} --oneline`);
  } catch {
    return "";
  }
}

function isPackageJsonChanged(changedFiles) {
  return changedFiles.includes("package.json");
}

function readPackageJson() {
  return fs.existsSync(PKG_PATH) ? fs.readFileSync(PKG_PATH, "utf8") : "";
}

/* ================================================================== */
/*  Main                                                                */
/* ================================================================== */

async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  Middleware – GitHub Auto-Updater (Standalone)");
  log("═══════════════════════════════════════════════════════");

  /* ── 1. Verify this is a Git repo ────────────────────────────── */
  if (!isGitRepo()) {
    fail("This directory is not a Git repository.");
    info("Run:  git init");
    info("Then: git remote add origin https://github.com/yourname/yourrepo.git");
    process.exit(1);
  }

  /* ── 2. Gather repo state ────────────────────────────────────── */
  const remote       = getRemoteName().split("\n")[0].trim() || "origin";
  const localBranch  = getCurrentBranch();
  const targetBranch = BRANCH;
  const localCommit  = getLocalCommit();
  const localFull    = getLocalCommitFull();

  step("Checking for updates …");
  info(`Repository : ${ROOT}`);
  info(`Remote     : ${remote}`);
  info(`Branch     : ${localBranch}  (tracking: ${remote}/${targetBranch})`);
  info(`Local HEAD : ${localCommit}`);

  /* ── 3. Fetch from GitHub ────────────────────────────────────── */
  try {
    info(`Fetching from ${remote}/${targetBranch} …`);
    fetchRemote(remote, targetBranch);
  } catch (err) {
    fail(`Could not reach GitHub: ${err.message}`);
    info("Check your internet connection and GitHub remote URL:");
    info(`  git remote -v`);
    process.exit(1);
  }

  const remoteCommit = getRemoteCommit(remote, targetBranch);
  info(`Remote HEAD: ${remoteCommit}`);

  /* ── 4. Compare ──────────────────────────────────────────────── */
  const behind = getCommitsBehind(remote, targetBranch);

  if (behind === 0 && !FORCE) {
    log("");
    ok(`Already up to date with ${remote}/${targetBranch}`);
    log("");
    process.exit(0);
  }

  /* ── 5. Show what changed ────────────────────────────────────── */
  log("");
  info(`📦  ${behind} new commit(s) available on ${remote}/${targetBranch}`);

  const changed = getChangedFiles(remote, targetBranch);
  if (changed.length > 0) {
    log("");
    info("Files that will be updated:");
    changed.forEach((f) => info(`    • ${f}`));
  }

  // Show the incoming commit messages
  const commitLog = getCommitLog(localFull, remote, targetBranch);
  if (commitLog) {
    log("");
    info("Incoming commits:");
    commitLog.split("\n").forEach((l) => info(`    ${l}`));
  }

  /* ── 6. Stop here if --check only ────────────────────────────── */
  if (CHECK_ONLY) {
    log("");
    info("Run  node updater.js  without --check to apply the update.");
    log("");
    process.exit(0);
  }

  /* ── 7. Pull ─────────────────────────────────────────────────── */
  step(`Pulling latest code from ${remote}/${targetBranch} …`);
  log("");

  const pullCode = runVisible("git", ["pull", remote, targetBranch]);

  if (pullCode !== 0) {
    log("");
    fail(`git pull failed (exit code ${pullCode})`);
    info("Possible causes:");
    info("  • You have local uncommitted changes");
    info("    Fix: git stash  then run updater again");
    info("  • Merge conflict — resolve manually then pull again");
    process.exit(1);
  }

  log("");
  ok("Code updated successfully.");

  /* ── 8. Reinstall dependencies if package.json changed ──────── */
  const pkgChanged = isPackageJsonChanged(changed);

  if (pkgChanged) {
    step("package.json changed — reinstalling dependencies …");
    log("");

    const installCode = runVisible("npm", ["install"]);

    if (installCode !== 0) {
      log("");
      fail("npm install failed — run it manually to resolve.");
      process.exit(1);
    }

    log("");
    ok("Dependencies reinstalled.");
  }

  /* ── 9. Summary ──────────────────────────────────────────────── */
  const newCommit = getLocalCommit();

  log("");
  log("═══════════════════════════════════════════════════════");
  log("  Update Complete");
  log("═══════════════════════════════════════════════════════");
  info(`Was  : ${localCommit}`);
  info(`Now  : ${newCommit}`);
  info(`Files: ${changed.length} updated`);
  if (pkgChanged) info("Deps : reinstalled");
  log("");
  ok("Restart the middleware to apply changes:");
  info("  node index.js");
  log("");
}

main().catch((err) => {
  fail(`Unhandled error: ${err.message}`);
  process.exit(1);
});