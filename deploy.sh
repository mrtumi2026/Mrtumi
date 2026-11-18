#!/usr/bin/env bash
# ==============================================================================
# MR. TUMI MARKETPLACE — CANONICAL PRODUCTION DEPLOYMENT & GOVERNANCE PIPELINE
# ==============================================================================
# Release Target: 5285d82e7e233c50561222c419fc163d79d74c5d
# Baseline SHA:   1b3c9a1950c2e8de7b76efb0d86717b02f64f100
# Target Engine:  MariaDB 10.3+ InnoDB (CloudLinux / cPanel)
# Node.js:        >= 22.5.0
#
# GUARANTEES:
# 1. Zero destructive Git operations (NO git reset --hard, NO git clean).
# 2. Strict exact target SHA enforcement.
# 3. Complete web & worker traffic isolation (503 .htaccess + .mrtumi_maintenance.lock).
# 4. Mandatory pre-deployment database & uploads backup with cryptographic v3 manifest.
# 5. Non-destructive detached recovery upon any migration or deployment failure.
# 6. Never executes mutating E2E tests against live production database.
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APPROVED_TARGET_SHA="5285d82e7e233c50561222c419fc163d79d74c5d"
PRE_DEPLOY_BASELINE_SHA="1b3c9a1950c2e8de7b76efb0d86717b02f64f100"
BACKUP_DIR="${HOME}/db_backups"

echo "======================================================================"
echo "   🚀 MR. TUMI MARKETPLACE — PRODUCTION DEPLOYMENT PIPELINE (v3)"
echo "======================================================================"
echo "Started at: $(date -u +"%Y-%m-%d %H:%M:%SZ")"
echo "Working directory: $SCRIPT_DIR"
echo "Target Release SHA: $APPROVED_TARGET_SHA"

# ------------------------------------------------------------------------------
# STEP 1: Node.js Runtime & Virtual Environment Verification
# ------------------------------------------------------------------------------
echo ""
echo "🔍 [1/8] Verifying Node.js runtime environment..."

if [ -f "$HOME/nodevenv/mrtumi/22/bin/activate" ]; then
  # shellcheck source=/dev/null
  source "$HOME/nodevenv/mrtumi/22/bin/activate"
elif [ -n "$1" ] && [ -f "$1" ]; then
  # shellcheck source=/dev/null
  source "$1"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ FATAL: 'node' executable not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ FATAL: 'npm' executable not found in PATH." >&2
  exit 1
fi

node -e '
const clean = process.versions.node.replace(/^v/, "");
const [maj, min] = clean.split(".").map(Number);
if (isNaN(maj) || isNaN(min) || maj < 22 || (maj === 22 && min < 5)) {
  console.error(`[FATAL] Node.js >= 22.5.0 required. Active: ${process.version}`);
  process.exit(1);
}
console.log(`✔ Node.js runtime verified: ${process.version} (${process.execPath})`);
'

# ------------------------------------------------------------------------------
# STEP 2: Git Hygiene & Safe Preflight (Zero Clean / Zero Reset)
# ------------------------------------------------------------------------------
echo ""
echo "🔍 [2/8] Verifying Git working tree hygiene..."

# Verify no dirty tracked modifications
if [ -n "$(git status --porcelain -uno)" ]; then
  echo "❌ FATAL: Tracked files have uncommitted modifications! Aborting." >&2
  git status --short -uno
  exit 1
fi

# Fetch target from remote without modifying local branch
git fetch origin main

# Verify target commit exists in repository
if ! git cat-file -e "${APPROVED_TARGET_SHA}^{commit}" 2>/dev/null; then
  echo "❌ FATAL: Approved target commit $APPROVED_TARGET_SHA not found in Git object store!" >&2
  exit 1
fi

# Check for untracked path collisions with release diff
node -e '
const { execSync } = require("child_process");
const target = "'"${APPROVED_TARGET_SHA}"'";
const changed = execSync("git diff --name-only HEAD " + target, { encoding: "utf8" })
  .split("\n").map(s => s.trim()).filter(Boolean);
const untracked = execSync("git status --porcelain", { encoding: "utf8" })
  .split("\n").filter(l => l.startsWith("?? ")).map(l => l.slice(3).trim());

const changedSet = new Set(changed);
const conflicts = [];
for (const u of untracked) {
  if (changedSet.has(u)) { conflicts.push(u); continue; }
  for (const c of changed) {
    if (c.startsWith(u + "/") || u.startsWith(c + "/")) {
      conflicts.push(`${u} conflicts with ${c}`);
      break;
    }
  }
}
if (conflicts.length > 0) {
  console.error(`[FATAL] Untracked path conflict detected: ${conflicts.join(", ")}`);
  process.exit(1);
}
console.log("✔ Git preflight: 0 untracked conflicts detected. Working tree safe.");
'

# ------------------------------------------------------------------------------
# STEP 3: Maintenance & Worker Traffic Isolation
# ------------------------------------------------------------------------------
echo ""
echo "🔒 [3/8] Engaging maintenance mode & isolating worker processes..."

node -e '
const mg = require("./scripts/ops/maintenance-guard");
const res = mg.engageMaintenance("Production Deployment to " + "'"${APPROVED_TARGET_SHA}"'");
console.log(`✔ Maintenance mode active: 503 .htaccess deployed & ${res.lockPath} locked.`);
'

# Error trap function for non-destructive fail-closed recovery
handle_deployment_failure() {
  echo ""
  echo "💥 ======================================================================"
  echo "💥 CRITICAL DEPLOYMENT FAILURE ENCOUNTERED! INITIATING SAFE RECOVERY..."
  echo "💥 ======================================================================"

  # Preserve maintenance mode permanently
  node -e '
    const mg = require("./scripts/ops/maintenance-guard");
    mg.persistOnFailure(new Error("Deployment aborted due to error"));
  ' || true

  # Detached recovery of code tree to pre-deploy baseline
  echo "  Realigning code tree to pre-deploy baseline (${PRE_DEPLOY_BASELINE_SHA})..."
  git checkout --detach "${PRE_DEPLOY_BASELINE_SHA}" || true

  echo "  Recycling Passenger workers to clear cached release..."
  mkdir -p tmp && touch tmp/restart.txt || true

  echo ""
  echo "❌ DEPLOYMENT HALTED. System remains in 503 Maintenance Mode for operator review."
  echo "   Inspect $BACKUP_DIR/.latest_verified_manifest to execute database restore if needed."
  exit 1
}

trap 'handle_deployment_failure' ERR

# ------------------------------------------------------------------------------
# STEP 4: Mandatory Pre-Deployment Backup & Cryptographic Manifest (v3)
# ------------------------------------------------------------------------------
echo ""
echo "📦 [4/8] Generating pre-deployment database dump & cryptographic manifest..."

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 4a. Execute verified database dump via production backup runner
node scripts/ops/production-db-audit-and-backup.js

# 4b. Authoritative UPLOAD_DIR archive & Manifest Pining
node -e '
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { env } = require("./src/config/env");
const { createHardenedManifest } = require("./scripts/ops/recovery-protocol");

(async () => {
  const backupDir = "'"${BACKUP_DIR}"'";
  const appDir = process.cwd();

  // 1. Verify UPLOAD_DIR
  if (!env.uploadDir || !fs.existsSync(env.uploadDir)) {
    throw new Error(`FAIL_CLOSED: UPLOAD_DIR "${env.uploadDir}" does not exist on disk!`);
  }

  // 2. Archive Uploads
  const runId = require("crypto").randomUUID().slice(0, 8);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const upArchive = path.join(backupDir, `uploads_pre_deploy_${timestamp}_${runId}.tar.gz`);

  console.log(`   Archiving uploads from ${env.uploadDir}...`);
  const tarRes = spawnSync("tar", [
    "-czf", upArchive,
    "-C", path.dirname(env.uploadDir),
    path.basename(env.uploadDir)
  ]);
  if (tarRes.status !== 0) {
    throw new Error(`FAIL_CLOSED: Failed to archive uploads: ${tarRes.stderr}`);
  }
  fs.chmodSync(upArchive, 0o600);

  // 3. Find latest SQL dump
  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith("mrtumi_full_database_") && f.endsWith(".sql"))
    .map(f => path.join(backupDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (files.length === 0) {
    throw new Error("FAIL_CLOSED: No SQL dump found in backup directory!");
  }
  const latestDump = files[0];

  // 4. Create & Pin Hardened Manifest
  const manifest = await createHardenedManifest(
    backupDir,
    env.db,
    latestDump,
    upArchive,
    {
      pre_deploy_head: "'"${PRE_DEPLOY_BASELINE_SHA}"'",
      target_commit: "'"${APPROVED_TARGET_SHA}"'"
    }
  );

  console.log(`✔ Cryptographic manifest pinned: ${manifest.manifestPath}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
'

# ------------------------------------------------------------------------------
# STEP 5: Fast-Forward Code Update to Approved Target SHA
# ------------------------------------------------------------------------------
echo ""
echo "📥 [5/8] Updating repository to approved release commit..."

# Safe fast-forward merge without hard reset
git merge --ff-only "$APPROVED_TARGET_SHA"

CURRENT_COMMIT="$(git rev-parse HEAD)"
if [ "$CURRENT_COMMIT" != "$APPROVED_TARGET_SHA" ]; then
  echo "❌ FATAL: HEAD commit mismatch! Expected $APPROVED_TARGET_SHA, got $CURRENT_COMMIT" >&2
  exit 1
fi

echo "✔ Repository cleanly aligned to commit: $CURRENT_COMMIT"

# ------------------------------------------------------------------------------
# STEP 6: Install Production Dependencies (Clean & Non-Destructive)
# ------------------------------------------------------------------------------
echo ""
echo "📦 [6/8] Installing production dependencies via npm ci..."

npm ci --only=production

echo "✔ Production dependencies installed."

# ------------------------------------------------------------------------------
# STEP 7: Database Migration Execution (Target: 0038)
# ------------------------------------------------------------------------------
echo ""
echo "🗄️  [7/8] Executing database migrations up to 0038..."

export CONFIRM_PRODUCTION_MIGRATION=true

node -e '
const path = require("path");
const { env } = require("./src/config/env");
const { createPoolFromConfig, closePool } = require("./src/db/mysqlPool");
const { loadMigrationPairs, migrateUp } = require("./src/db/migrator");

(async () => {
  const pool = createPoolFromConfig(env.db);
  try {
    const migDir = path.join(process.cwd(), "src/db/migrations");
    const pairs = loadMigrationPairs(migDir);
    const [rows] = await pool.query("SELECT version FROM schema_migrations");
    const appliedSet = new Set(rows.map(r => r.version));

    const pending = pairs.filter(p => !appliedSet.has(p.version) && p.version <= "0038");
    if (pending.length === 0) {
      console.log("✔ Migrations up to 0038 already applied (0 pending).");
    } else {
      console.log(`Executing ${pending.length} pending migration(s): ${pending.map(p => p.version).join(", ")}`);
      const applied = await migrateUp(pool, { targetVersion: "0038" });
      console.log(`✔ Successfully applied ${applied.length} migration(s).`);
    }
  } finally {
    await closePool(pool);
  }
})().catch(err => {
  console.error(`[FATAL] Migration execution failed: ${err.message}`);
  process.exit(1);
});
'

# ------------------------------------------------------------------------------
# STEP 8: Post-Migration Integrity Gates & Health Verification
# ------------------------------------------------------------------------------
echo ""
echo "🧪 [8/8] Verifying post-migration schema, constraints & platform health..."

# 8a. Verify schema objects and zero-null/empty slugs
node -e '
const { getPool, closePool } = require("./src/db/mysqlPool");

(async () => {
  const pool = getPool();
  try {
    // 1. Check migrations recorded
    const [migs] = await pool.query(
      "SELECT version FROM schema_migrations WHERE version IN (?, ?) ORDER BY version ASC",
      ["0037", "0038"]
    );
    if (migs.length !== 2) throw new Error("Migrations 0037 and 0038 not both recorded in schema_migrations!");

    // 2. Check 0037 branding columns
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      ["vendors"]
    );
    const colSet = new Set(cols.map(c => c.COLUMN_NAME.toLowerCase()));
    for (const req of ["slug", "logo_url", "banner_url", "tagline", "description", "store_status"]) {
      if (!colSet.has(req)) throw new Error(`Missing expected column in vendors table: ${req}`);
    }

    // 3. Check unique index
    const [idxs] = await pool.query(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
      ["vendors", "uq_vendors_slug"]
    );
    if (idxs.length === 0) throw new Error("Unique index uq_vendors_slug missing on vendors table!");

    // 4. Check 0038 tables
    const [tbls] = await pool.query(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)",
      ["vendor_courier_booking_requests", "vendor_courier_booking_audit_logs"]
    );
    if (tbls.length !== 2) throw new Error("0038 courier booking tables missing!");

    // 5. Check slug integrity
    const [slugRows] = await pool.query(
      "SELECT COUNT(*) AS total, COUNT(slug) AS withSlug FROM vendors"
    );
    if (slugRows[0].total !== slugRows[0].withSlug) {
      throw new Error(`Slug mismatch: ${slugRows[0].total} vendors, ${slugRows[0].withSlug} with slugs.`);
    }

    const [invalidSlugs] = await pool.query(
      "SELECT COUNT(*) AS c FROM vendors WHERE slug IS NULL OR slug = \"\""
    );
    if (invalidSlugs[0].c > 0) throw new Error("Found vendors with NULL or empty slug!");

    console.log("✔ Post-migration schema and data integrity gates verified (0 violations).");
  } finally {
    await closePool(pool);
  }
})().catch(err => {
  console.error(`[FATAL] Post-migration integrity verification failed: ${err.message}`);
  process.exit(1);
});
'

# 8b. Recycle Passenger workers
echo "  Triggering graceful Passenger worker restart..."
mkdir -p tmp
touch tmp/restart.txt
chmod 666 tmp/restart.txt 2>/dev/null || true

# 8c. Run read-only health check
echo "  Running read-only application health check..."
node scripts/health-check.js

# 8d. Disengage maintenance mode cleanly
echo "  Disengaging maintenance mode & resuming worker traffic..."
node -e '
const mg = require("./scripts/ops/maintenance-guard");
mg.disengageMaintenance();
console.log("✔ Maintenance mode lifted successfully.");
'

trap - ERR

echo ""
echo "======================================================================"
echo "   ✅ DEPLOYMENT FINISHED SUCCESSFULLY!"
echo "======================================================================"
echo "Commit deployed:  $APPROVED_TARGET_SHA"
echo "Completed at:     $(date -u +"%Y-%m-%d %H:%M:%SZ")"
echo "Status:           100% Production Ready & Audited"
echo "======================================================================"
exit 0
