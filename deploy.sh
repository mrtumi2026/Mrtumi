#!/usr/bin/env bash
# ==============================================================================
# MR. TUMI MARKETPLACE — CANONICAL PRODUCTION DEPLOYMENT & GOVERNANCE PIPELINE
# ==============================================================================
# Verifiable Release Target Mechanism:
# Usage:
#   ./deploy.sh <TARGET_COMMIT_SHA>
#   OR: APPROVED_RELEASE_SHA=<TARGET_COMMIT_SHA> ./deploy.sh
#
# GUARANTEES:
# 1. Zero destructive Git operations (NO git reset --hard, NO git clean).
# 2. Reversible .htaccess preservation (never wipes pre-existing rules).
# 3. Complete web & worker traffic isolation (503 .htaccess + .mrtumi_maintenance.lock).
# 4. Mandatory pre-deployment database & uploads backup with cryptographic v3 manifest.
# 5. Non-destructive fail-closed recovery (NEVER automatically drops tables).
# 6. Never executes mutating E2E tests against live production database.
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ------------------------------------------------------------------------------
# STEP 0: Release Target Verification (Non-Self-Referential Pin)
# ------------------------------------------------------------------------------
TARGET_COMMIT_SHA="${1:-${APPROVED_RELEASE_SHA:-}}"
TICKET_FILE="${2:-${RELEASE_APPROVAL_TICKET_FILE:-}}"
EXPECTED_RELEASE_TAG="${3:-${DEPLOY_RELEASE_TAG:-}}"

if [ -z "$TARGET_COMMIT_SHA" ]; then
  echo "❌ FATAL: Missing required release target commit SHA." >&2
  echo "   Usage: ./deploy.sh <TARGET_COMMIT_SHA> [TICKET_FILE] <EXPECTED_RELEASE_TAG>" >&2
  echo "   Or:    APPROVED_RELEASE_SHA=<TARGET_COMMIT_SHA> DEPLOY_RELEASE_TAG=<TAG> ./deploy.sh" >&2
  exit 1
fi

# Validate 40-character hex SHA format
if [[ ! "$TARGET_COMMIT_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "❌ FATAL: Target release commit '$TARGET_COMMIT_SHA' is not a valid 40-character hexadecimal Git SHA." >&2
  exit 1
fi

# Enforce mandatory expected release tag for production deployment
if [ -z "$EXPECTED_RELEASE_TAG" ]; then
  echo "❌ FATAL: Expected release tag is mandatory for production deployment." >&2
  echo "   Usage: ./deploy.sh <TARGET_COMMIT_SHA> [TICKET_FILE] <EXPECTED_RELEASE_TAG>" >&2
  echo "   Example: ./deploy.sh 5285d82e... /path/to/release-ticket.json v3.5.0" >&2
  exit 1
fi

# Preflight: Mandatory independent out-of-band trust anchor verification
TRUST_ANCHOR_FILE="${GOVERNANCE_TRUST_ANCHOR_PATH:-$HOME/.mrtumi_governance_trust_anchor.json}"
if [ -z "${GOVERNANCE_TRUST_ANCHOR_SHA256:-}" ] && [ ! -f "$TRUST_ANCHOR_FILE" ]; then
  echo "❌ FATAL: Mandatory independent out-of-band trust anchor is missing!" >&2
  echo "   Release policy requires an independent trust anchor to prevent in-repository tampering." >&2
  echo "   Provision either:" >&2
  echo "     1. Anchor file: $TRUST_ANCHOR_FILE (mode 0600, non-symlink, containing expected_governance_sha256)" >&2
  echo "     2. Environment SHA: export GOVERNANCE_TRUST_ANCHOR_SHA256=<sha256_of_release-governance.json>" >&2
  exit 1
fi

PRE_DEPLOY_BASELINE_SHA="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
BACKUP_DIR="${HOME}/db_backups"
DEPLOYMENT_STAGE="INITIALIZATION"

echo "======================================================================"
echo "   🚀 MR. TUMI MARKETPLACE — PRODUCTION DEPLOYMENT PIPELINE (v3.1)"
echo "======================================================================"
echo "Started at:         $(date -u +"%Y-%m-%d %H:%M:%SZ")"
echo "Working directory:  $SCRIPT_DIR"
echo "Pre-Deploy HEAD:    $PRE_DEPLOY_BASELINE_SHA"
echo "Target Release SHA: $TARGET_COMMIT_SHA"

# ------------------------------------------------------------------------------
# STEP 1: Node.js Runtime & Virtual Environment Verification
# ------------------------------------------------------------------------------
echo ""
echo "🔍 [1/8] Verifying Node.js runtime environment..."

if [ -f "$HOME/nodevenv/mrtumi/22/bin/activate" ]; then
  # shellcheck source=/dev/null
  source "$HOME/nodevenv/mrtumi/22/bin/activate"
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
if ! git cat-file -e "${TARGET_COMMIT_SHA}^{commit}" 2>/dev/null; then
  echo "❌ FATAL: Approved target commit $TARGET_COMMIT_SHA not found in Git object store!" >&2
  exit 1
fi

# Verify release target approval under Project 01 Cryptographic Release Governance Policy
DEPLOY_ENVIRONMENT="production" DEPLOY_RELEASE_TAG="$EXPECTED_RELEASE_TAG" node scripts/ops/verify-release-approval.js "$TARGET_COMMIT_SHA" "${TICKET_FILE:-}" "$EXPECTED_RELEASE_TAG"

# Check for untracked path collisions with release diff
node -e '
const { execSync } = require("child_process");
const target = "'"${TARGET_COMMIT_SHA}"'";
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
# STEP 3: Maintenance & Worker Traffic Isolation (Reversible)
# ------------------------------------------------------------------------------
echo ""
echo "🔒 [3/8] Engaging maintenance mode & isolating worker processes..."

node -e '
const mg = require("./scripts/ops/maintenance-guard");
const res = mg.engageMaintenance("Production Deployment to " + "'"${TARGET_COMMIT_SHA}"'");
console.log(`✔ Maintenance mode active: 503 rules deployed (original .htaccess preserved) & lock active.`);
'

DEPLOYMENT_STAGE="PRE_MIGRATION"

# Error trap function for fail-closed non-destructive recovery
handle_deployment_failure() {
  echo ""
  echo "💥 ======================================================================"
  echo "💥 CRITICAL DEPLOYMENT FAILURE ENCOUNTERED!"
  echo "💥 Deployment Stage Reached: $DEPLOYMENT_STAGE"
  echo "💥 ======================================================================"

  # Preserve maintenance mode permanently (Fail-closed: explicit error if state persistence fails)
  if ! node -e '
    const mg = require("./scripts/ops/maintenance-guard");
    mg.persistOnFailure(new Error("Deployment aborted in stage: '"${DEPLOYMENT_STAGE}"'"));
  '; then
    echo "💥 FATAL: Failed to persist maintenance mode failure state!" >&2
    echo "   EMERGENCY OPERATOR ACTION REQUIRED: Verify that .htaccess contains 503 rules and maintenance-lock.json exists." >&2
    echo "   Do NOT restart Passenger or release maintenance until manual investigation is complete." >&2
  fi

  if [ "$DEPLOYMENT_STAGE" = "PRE_MIGRATION" ]; then
    echo "  Stage was PRE_MIGRATION: Safely realigning code tree to baseline ($PRE_DEPLOY_BASELINE_SHA)..."
    if ! git checkout --detach "${PRE_DEPLOY_BASELINE_SHA}"; then
      echo "💥 FATAL: Code rollback checkout to baseline ${PRE_DEPLOY_BASELINE_SHA} FAILED!" >&2
      echo "   Working tree is in an inconsistent state. Maintenance mode MUST remain engaged." >&2
    else
      echo "✔ Code tree successfully realigned to pre-deployment baseline: ${PRE_DEPLOY_BASELINE_SHA}"
      mkdir -p tmp && touch tmp/restart.txt
    fi
  else
    echo "  Stage was POST_MIGRATION: Code rollback is HELD to prevent code/schema divergence!"
    echo "  Database may contain newer or partial migrations. DO NOT automatically rollback code."
  fi

  echo ""
  echo "❌ DEPLOYMENT HALTED. System remains in 503 Maintenance Mode for operator investigation."
  echo "   To review pinned manifest: cat $BACKUP_DIR/.latest_verified_manifest"
  echo "   To perform verified DB recovery (if approved by operator):"
  echo "     CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY=I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY node -e '...'"
  exit 1
}

trap 'handle_deployment_failure' ERR

# ------------------------------------------------------------------------------
# STEP 4: Mandatory Pre-Deployment Backup & Cryptographic Manifest (v3.1)
# ------------------------------------------------------------------------------
echo ""
echo "📦 [4/8] Generating pre-deployment database dump & cryptographic manifest..."

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# 4a. Execute verified database dump via production backup runner
node scripts/ops/production-db-audit-and-backup.js

# 4b. Authoritative UPLOAD_DIR archive & Manifest Pinning
node -e '
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { env } = require("./src/config/env");
const { createHardenedManifest } = require("./scripts/ops/recovery-protocol");

(async () => {
  const backupDir = "'"${BACKUP_DIR}"'";

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
      target_commit: "'"${TARGET_COMMIT_SHA}"'"
    }
  );

  console.log(`✔ Cryptographic manifest pinned: ${manifest.manifestPath}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
'

# 4c. Pre-Migration Restore Rehearsal on Isolated Schema (Finding H6)
if [ -n "${REHEARSAL_DB_NAME:-}" ]; then
  echo ""
  echo "🧪 [4c/8] Rehearsing database restore on isolated disposable schema: $REHEARSAL_DB_NAME..."
  REHEARSAL_DB_NAME="$REHEARSAL_DB_NAME" node -e '
  const path = require("path");
  const fs = require("fs");
  const { env } = require("./src/config/env");
  const { rehearseDatabaseRestore } = require("./scripts/ops/recovery-protocol");

  (async () => {
    const backupDir = "'"${BACKUP_DIR}"'";
    const pointerPath = path.join(backupDir, ".latest_verified_manifest");
    const manifestFilename = fs.readFileSync(pointerPath, "utf8").trim();
    const manifestPath = path.join(backupDir, manifestFilename);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const dumpFile = manifest.artifacts.database_dump.canonical_path;

    const rehearsalDbName = process.env.REHEARSAL_DB_NAME.trim();
    if (rehearsalDbName.toLowerCase() === env.db.database.toLowerCase()) {
      throw new Error(`CRITICAL_SAFETY_VIOLATION: REHEARSAL_DB_NAME cannot match production database (${env.db.database})!`);
    }

    const disposableConfig = { ...env.db, database: rehearsalDbName };
    console.log(`   Executing restore rehearsal into disposable database: ${rehearsalDbName}...`);
    await rehearseDatabaseRestore(dumpFile, disposableConfig, manifestPath, {
      productionDatabase: env.db.database
    });
    console.log("✔ Pre-migration restore rehearsal PASSED on isolated schema. Manifest updated: database_restore_rehearsed=true.");
  })().catch(err => {
    console.error(`💥 [RESTORE_REHEARSAL_FAILED]: ${err.message}`);
    process.exit(1);
  });
  '
elif [ "${DEPLOY_REQUIRE_REHEARSAL:-false}" = "true" ]; then
  echo "❌ FATAL: DEPLOY_REQUIRE_REHEARSAL is true, but no REHEARSAL_DB_NAME was provided." >&2
  echo "   Provide REHEARSAL_DB_NAME=<disposable_database> to perform automated pre-migration rehearsal." >&2
  exit 1
fi

# ------------------------------------------------------------------------------
# STEP 5: Fast-Forward Code Update to Approved Target SHA
# ------------------------------------------------------------------------------
echo ""
echo "📥 [5/8] Updating repository to approved release commit..."

# Safe fast-forward merge without hard reset
git merge --ff-only "$TARGET_COMMIT_SHA"

CURRENT_COMMIT="$(git rev-parse HEAD)"
if [ "$CURRENT_COMMIT" != "$TARGET_COMMIT_SHA" ]; then
  echo "❌ FATAL: HEAD commit mismatch! Expected $TARGET_COMMIT_SHA, got $CURRENT_COMMIT" >&2
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
# STEP 6.5: Mandatory Pre-Migration Backup Manifest & Dump Verification Gate
# ------------------------------------------------------------------------------
echo ""
echo "🔍 [6.5/8] Enforcing mandatory pre-migration backup manifest & dump verification gate..."

node -e '
const path = require("path");
const fs = require("fs");
const { env } = require("./src/config/env");
const { validateAndLoadManifest } = require("./scripts/ops/recovery-protocol");

(async () => {
  const backupDir = "'"${BACKUP_DIR}"'";
  const pointerPath = path.join(backupDir, ".latest_verified_manifest");
  if (!fs.existsSync(pointerPath)) {
    throw new Error("FAIL_CLOSED: Missing backup manifest pointer (.latest_verified_manifest)!");
  }
  const manifestFilename = fs.readFileSync(pointerPath, "utf8").trim();
  const manifestPath = path.join(backupDir, manifestFilename);

  console.log(`   Validating cryptographic manifest: ${manifestPath}`);
  const loaded = await validateAndLoadManifest(manifestPath, env.db, backupDir);

  if (loaded.manifest.status.backup_created !== true || loaded.manifest.status.integrity_verified !== true) {
    throw new Error("FAIL_CLOSED: Backup status does not have backup_created=true and integrity_verified=true!");
  }

  if (process.env.DEPLOY_REQUIRE_REHEARSAL === "true" && loaded.manifest.status.database_restore_rehearsed !== true) {
    throw new Error("FAIL_CLOSED: DEPLOY_REQUIRE_REHEARSAL is true, but database_restore_rehearsed is false in manifest!");
  }

  console.log("✔ Mandatory pre-migration backup verification gate PASSED (database identity, dump integrity & footer verified).");
})().catch(err => {
  console.error(`💥 [MANDATORY_BACKUP_GATE_FAILED]: ${err.message}`);
  console.error("   Deployment CANNOT proceed without a verified baseline backup. Aborting!");
  process.exit(1);
});
'

# ------------------------------------------------------------------------------
# STEP 7: Database Migration Execution (Target: 0038)
# ------------------------------------------------------------------------------
echo ""
echo "🗄️  [7/8] Executing database migrations up to 0038..."

DEPLOYMENT_STAGE="MIGRATION_IN_PROGRESS"
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

DEPLOYMENT_STAGE="POST_MIGRATION"

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

# 8d. Disengage maintenance mode cleanly (restoring original .htaccess byte-for-byte)
echo "  Disengaging maintenance mode & resuming worker traffic..."
node -e '
const mg = require("./scripts/ops/maintenance-guard");
mg.disengageMaintenance();
console.log("✔ Maintenance mode lifted successfully (original .htaccess restored).");
'

trap - ERR

echo ""
echo "======================================================================"
echo "   ✅ DEPLOYMENT FINISHED SUCCESSFULLY!"
echo "======================================================================"
echo "Commit deployed:  $TARGET_COMMIT_SHA"
echo "Completed at:     $(date -u +"%Y-%m-%d %H:%M:%SZ")"
echo "Status:           100% Production Ready & Audited"
echo "======================================================================"
exit 0
