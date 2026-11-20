# Project 01 — Production Deployment Readiness & Non-Destructive Recovery Protocol (v3.7 Hardened)

**Target System:** Mr. Tumi Multi-Vendor Commerce Platform (`mrtumi-main`)  
**Release Governance:** Asymmetric Ed25519 Cryptographic Release Tickets with Mandatory Out-Of-Band Trust Anchoring  
**Governance Config:** `config/release-governance.json` (verified by `scripts/ops/verify-release-approval.js`)  
**Active Registered Governance Key:** `gov-board-2026-ed25519` (owner: Mr. Tumi Release Governance Board)  
**Production Baseline Commit (HEAD):** `1b3c9a1950c2e8de7b76efb0d86717b02f64f100`  
**Host Environment:** cPanel / CloudLinux (CageFS/LVE), Node.js >= 22.5.0, MariaDB 10.3+ / 10.11 InnoDB  
**Application Directory:** `$HOME/mrtumi` (`/home/mrtumico/mrtumi`)  
**Live Production Database:** `mrtumico_live`  
**Audited Modules:** `scripts/ops/recovery-protocol.js`, `scripts/ops/maintenance-guard.js`, `scripts/ops/verify-release-approval.js`, `scripts/ops/sign-release-ticket.js`, `scripts/ci/generate-test-summary.js`, `deploy.sh`

---

## 1. Architectural Summary & Vulnerability Remediation (v3.7)

| Domain | Prior Vulnerability / Finding | v3.7 Hardened Specification |
|---|---|---|
| **Restore Rehearsal Isolation & Credentials** | `deploy.sh` previously permitted `allowSharedCredentials: true` and automatically set `REHEARSAL_AUTHORIZED="true"` without requiring separate rehearsal DB credentials or explicit human operator authorization. | **Strict Rehearsal Isolation & Disposability Gate**: Rehearsal mandates separate credentials (`REHEARSAL_DB_USER` and `REHEARSAL_DB_PASSWORD`) and rejects identical production credentials. Enforces explicit operator authorization (`REHEARSAL_DISPOSABLE_AUTHORIZED=true`) and validates target identity against `REHEARSAL_APPROVED_TARGETS`. |
| **Restore Rehearsal Parity Verification** | Parity validation could silently skip if driver was missing, or fail open. Schema or migration differences were not strictly checked. | **Mandatory Fail-Closed Parity Verification**: If `mysql2` driver is unavailable, throws `FAIL_CLOSED_PARITY_UNAVAILABLE`. Validates schema parity (table count > 0), tracking migrations table presence & row count, critical row counts, and foreign key integrity. Manifest records `rehearsal_parity_verified: true` and comprehensive parity stats. |
| **Restore Rehearsal Automated Test Coverage** | Rehearsal protocol lacked dedicated unit/integration tests for failure and edge cases. | **17-Test Rehearsal Test Suite**: Dedicated automated test suite in `tests/restore-rehearsal.test.js` validating all 11 safety invariants including real disposable DB success-path, schema/migration/row-count mismatches, driver missing, and concurrent execution locks. |
| **Developer Paths & Binary Resolution** | Local Windows scratch paths (`C:\Users\Bappi\...`, `C:\Users\sj010\...`) were present in operational scripts and test suites. | **Zero Host-Specific Paths**: Completely purged all developer paths across repository. Safe binary resolution via `resolveSafeBinary` checking configured env vars (`MYSQL_BIN`, `MYSQLDUMP_BIN`) and safe PATH scanning. |
| **Governance Key Documentation & Registry** | Documentation suggested signing with `gov-key-2026-11`, which was not registered in `config/release-governance.json`, causing verification rejection. | **Documented Key Registry & Rotation**: Explicitly documents `gov-board-2026-ed25519` as the currently registered key. Documents exact offline rotation procedure: register new public key in `config/release-governance.json`, compute SHA-256, and provision out-of-band trust anchor. |
| **Rollback Command Handler** | Recovery protocol had no active CLI execution block for `--rollback`, rendering the documented rollback command a no-op. | **Real Executable Rollback CLI**: Fully implemented CLI in `scripts/ops/recovery-protocol.js` supporting `--rollback --manifest <PATH> --confirm I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY --run-id <ID>`. |
| **Cron Suspension & Restoration Runbook** | `crontab -r 2>/dev/null \|\| true` destroyed unrelated crontab jobs, suppressed errors, and restored via wildcards (`crontab_backup_*.txt`). | **Safe Entry-Selective Cron Management**: Selectively tags and disables MRTUMI jobs with `# MRTUMI_DEPLOY_SUSPENDED`. Stores exact timestamped backup file and restores without wildcards or error suppression. |
| **Disk Quota Calculation** | Falling back to `echo 250` risked running out of disk during migration if database was larger than estimated. | **Deterministic Fail-Closed Disk Calculation**: Dynamically measures configured `$DB_NAME` and uploads. Fails closed with an explicit error if measurement fails. Enforces 1.5x DB + 2.2x uploads + 500MB safety margin. |
| **Manifest Schema Version Consistency** | Manifest schema versions were inconsistently referenced across scripts. | **Canonical Schema Version 3.7**: Established canonical `CURRENT_MANIFEST_SCHEMA_VERSION = '3.7'` with explicit backward-compatibility set `['3.5', '3.6', '3.7']`. |

---

## 2. Cryptographic Release Governance & Offline Signing

### 2.1 The Need for Independent Out-of-Band Trust Anchoring:
If trust configuration resides solely within the Git repository, an attacker with repository write access could simply add their own public key to `config/release-governance.json` and sign malicious releases.

To establish an immutable trust boundary:
1. **Repository Layer:** `config/release-governance.json` provides the public key registry, policy bounds, and historical baselines.
2. **Host Layer (Out-Of-Band Trust Anchor):** The cPanel production host maintains an independent trust anchor file at `/home/mrtumico/.mrtumi_governance_trust_anchor.json` (mode 0600, non-symlink, owned by `mrtumico`) or environment variable `GOVERNANCE_TRUST_ANCHOR_SHA256`.
3. **Integrity Enforcement:** During deployment, `verify-release-approval.js` calculates the SHA-256 hash of `config/release-governance.json` and compares it to the host-pinned anchor. If missing, deployment aborts (`TRUST_ANCHOR_REQUIRED`). If any in-repo public key or policy was modified without authorized host-level provisioning, deployment fails closed (`TRUST_ANCHOR_INTEGRITY_MISMATCH`).

### 2.2 Active Governance Keys & Key-Bootstrap/Rotation Runbook:

#### Currently Active Registered Key:
In `config/release-governance.json`, the active registered governance key is:
- **Key ID:** `gov-board-2026-ed25519`
- **Owner:** Mr. Tumi Release Governance Board (`governance@mrtumi.com`)
- **Role:** `production_release_approval`
- **Algorithm:** `ed25519`
- **Validity:** `2026-01-01T00:00:00Z` to `2027-01-01T00:00:00Z`
- **Current Canonical SHA-256 of `config/release-governance.json`:** `bae061c98d0ed933030aacbe8f657229664424aae0449cd57d367d014dbdb777`

#### Offline Keypair Generation (For Key Rotation or New Governor):
If generating a new or rotated keypair (NEVER generate or store private keys on cPanel, in Git, or in CI):
```bash
# Generate Ed25519 private key in PKCS#8 format on cold workstation
openssl genpkey -algorithm ed25519 -out /secure/cold/storage/gov-key-new.pem
chmod 400 /secure/cold/storage/gov-key-new.pem

# Extract corresponding public key
openssl pkey -in /secure/cold/storage/gov-key-new.pem -pubout -out /secure/cold/storage/gov-key-new.pub
```

#### Registering a New or Rotated Public Key in Repository:
1. Open `config/release-governance.json`.
2. Add the public key object to `trusted_keys` (and add any superseded key ID to `revoked_key_ids`):
   ```json
   {
     "key_id": "gov-key-new",
     "algorithm": "ed25519",
     "public_key": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
     "owner": "Mr. Tumi Primary Release Governor",
     "roles": ["production_release_approval"],
     "valid_from": "2026-11-01T00:00:00Z",
     "valid_until": "2027-11-01T00:00:00Z"
   }
   ```
3. Calculate the new SHA-256 hash of `config/release-governance.json`:
   ```bash
   sha256sum config/release-governance.json
   ```
4. Update the out-of-band trust anchor on the cPanel production host with the new SHA-256 hash.
5. Commit and push the updated `config/release-governance.json` to Git.

### 2.3 Offline Ticket Signing:
Using the active registered key `gov-board-2026-ed25519` (or an authorized rotated key):
```bash
node scripts/ops/sign-release-ticket.js \
  --commit "<CANDIDATE_SHA>" \
  --tag "v3.7.0" \
  --env "production" \
  --key-id "gov-board-2026-ed25519" \
  --key-file "/secure/cold/storage/gov-board-2026-ed25519.pem" \
  --hours 48 \
  --out "release-ticket.json"
```

---

## 3. GitHub `main` Branch Protection Runbook (Repository Owner)

Because the repository currently has no active protection rules or rulesets on `main`, the owner must enable the following settings in the GitHub Web UI (`Settings -> Branches -> Add branch ruleset` or `Add classic branch protection rule`):

1. **Target Branch Pattern:** `main` (or default branch).
2. **Restrict Deletions:** Checked (`true`).
3. **Block Force Pushes:** Checked (`true`).
4. **Require a Pull Request before Merging:**
   - Require approvals: Minimum 1 approval.
   - Dismiss stale pull request approvals when new commits are pushed: Checked.
   - Require review from Code Owners: Optional/Recommended.
5. **Require Status Checks to Pass before Merging:**
   - Require branches to be up to date before merging: Checked.
   - Status checks required (must match exact workflow job names):
     - `Verify Foundation, MySQL 8.0 Migrations & Tests (Node 22.23.4)`
     - `MariaDB 10.11 Migrations & Integration Tests (Node 22.23.4)`
     - `DEMO browser E2E — MySQL 8.0`
     - `DEMO browser E2E — MariaDB 10.11`
6. **Require Conversation Resolution before Merging:** Checked.
7. **Do not allow bypassing the above settings:**
   - Enforce for repository administrators (uncheck "Allow administrators to bypass" or configure explicitly).

---

## 4. cPanel Operator Production Readiness Runbook

### Step 1: Baseline Verification
Log in to cPanel Terminal and verify current checked-out commit:
```bash
cd /home/mrtumico/mrtumi
git rev-parse HEAD
# Must output: 1b3c9a1950c2e8de7b76efb0d86717b02f64f100 (or current approved baseline)
git status --porcelain
# Verify untracked audit scripts are intact
```

### Step 2: Out-Of-Band Trust Anchor Provisioning
Verify if an anchor exists before modifying:
```bash
ANCHOR_FILE="$HOME/.mrtumi_governance_trust_anchor.json"
if [ -f "$ANCHOR_FILE" ]; then
  echo "Existing anchor found:"
  cat "$ANCHOR_FILE"
else
  cat << 'EOF' > "$ANCHOR_FILE"
{
  "schema_version": "3.7",
  "expected_governance_sha256": "bae061c98d0ed933030aacbe8f657229664424aae0449cd57d367d014dbdb777",
  "anchor_created_at": "2026-11-19T10:00:00Z"
}
EOF
fi
chmod 600 "$ANCHOR_FILE"
```

### Step 3: Deterministic Disk Quota and Extraction Capacity Calculation
Never rely on a rough estimate or fallback echo values. Measure actual filesystem usage:
```bash
# 1. Configured database name (must be set, fail closed if not determined)
TARGET_DB_NAME="${DB_NAME:-mrtumico_live}"
TARGET_UPLOAD_DIR="${UPLOAD_DIR:-/home/mrtumico/uploads}"

# 2. Database size measurement:
if [ -d "/var/lib/mysql/${TARGET_DB_NAME}" ]; then
  DB_SIZE=$(du -sm "/var/lib/mysql/${TARGET_DB_NAME}" 2>/dev/null | cut -f1)
elif command -v mysql >/dev/null 2>&1; then
  # Query schema data length via SQL if data dir is restricted by CageFS:
  DB_SIZE=$(mysql -u "$DB_USER" -p"$DB_PASSWORD" -h "${DB_HOST:-localhost}" -e "SELECT CEILING(SUM(data_length + index_length) / 1048576) FROM information_schema.tables WHERE table_schema='${TARGET_DB_NAME}';" -s -N 2>/dev/null)
fi

if [ -z "$DB_SIZE" ] || [ "$DB_SIZE" -le 0 ]; then
  echo "FATAL: Unable to deterministically calculate database size for ${TARGET_DB_NAME}. Aborting." >&2
  exit 1
fi

# 3. Uploads directory size measurement:
if [ -d "$TARGET_UPLOAD_DIR" ]; then
  UPLOADS_SIZE=$(du -sm "$TARGET_UPLOAD_DIR" 2>/dev/null | cut -f1)
else
  UPLOADS_SIZE=0
fi

if [ -z "$UPLOADS_SIZE" ]; then
  echo "FATAL: Unable to measure uploads directory size at ${TARGET_UPLOAD_DIR}. Aborting." >&2
  exit 1
fi

# 4. Enforce strict formula:
# Required Space = (DB_SIZE * 1.5) [SQL dump] + (UPLOADS_SIZE * 1.2) [Tar archive] + (UPLOADS_SIZE * 1.0) [Staging extraction] + 500 MB [Headroom]
REQUIRED_MB=$(( (DB_SIZE * 3 / 2) + (UPLOADS_SIZE * 12 / 10) + UPLOADS_SIZE + 500 ))

echo "Itemized Storage Requirements:"
echo "  - Database (${TARGET_DB_NAME}): ${DB_SIZE} MB (Dump estimate: $((DB_SIZE * 3 / 2)) MB)"
echo "  - Uploads (${TARGET_UPLOAD_DIR}): ${UPLOADS_SIZE} MB (Backup+Staging estimate: $(( (UPLOADS_SIZE * 22) / 10 )) MB)"
echo "  - Operational Headroom: 500 MB"
echo "  - Total Required Free Space: ${REQUIRED_MB} MB"

quota -s || df -h "$HOME"
```

### Step 4: Disposable Rehearsal Database & Credential Setup
Ensure an isolated disposable database exists in cPanel MySQL with separate, dedicated credentials:
- **Target Name:** `mrtumico_rehearsal`
- **Isolation Requirement:** Must NOT be the live production database (`mrtumico_live`).
- **Dedicated User:** `mrtumico_rehearsal_usr` (different from production `DB_USER`).
- **Approved Target Allowlist:** Added to `REHEARSAL_APPROVED_TARGETS` (`mrtumico_rehearsal,mrtumico_rehearsal_test`).
- **Explicit Operator Authorization:** Requires `REHEARSAL_DISPOSABLE_AUTHORIZED="true"` exported in the deployment session.

### Step 5: Pre-Deployment Operational Suspension (Safe Entry-Selective)
Before running deployment:
```bash
# 1. Back up current crontab to exact timestamped file:
CRON_BACKUP="$HOME/crontab_backup_$(date +%Y%m%d_%H%M%S).txt"
crontab -l > "$CRON_BACKUP"

# 2. Safely suspend ONLY mrtumi cron jobs (do NOT use crontab -r):
crontab -l | sed -E 's/(.*\/mrtumi\/.*)/# MRTUMI_DEPLOY_SUSPENDED: \1/' | crontab -

# 3. Preserve .htaccess rules:
cp /home/mrtumico/mrtumi/public/.htaccess "$HOME/.htaccess_backup_predeploy"
```

### Step 6: Deployment Execution
Upload the signed `release-ticket.json` to the server, export mandatory isolated rehearsal variables, and execute:
```bash
export GOVERNANCE_TRUST_ANCHOR_PATH="$HOME/.mrtumi_governance_trust_anchor.json"
export REHEARSAL_DB_NAME="mrtumico_rehearsal"
export REHEARSAL_DB_USER="mrtumico_rehearsal_usr"
export REHEARSAL_DB_PASSWORD="<REHEARSAL_USER_PASSWORD>"
export REHEARSAL_APPROVED_TARGETS="mrtumico_rehearsal,mrtumico_rehearsal_test"
export REHEARSAL_DISPOSABLE_AUTHORIZED="true"
export DEPLOY_REQUIRE_REHEARSAL="true"

./deploy.sh "<APPROVED_TARGET_SHA>" "release-ticket.json" "v3.7.0"
```

### Step 7: Post-Deployment Verification
```bash
# 1. Restart Passenger:
mkdir -p /home/mrtumico/mrtumi/tmp
touch /home/mrtumico/mrtumi/tmp/restart.txt

# 2. Restore crontab from the exact backup file:
crontab "$CRON_BACKUP"

# 3. Verify HTTP response & maintenance lock removal:
curl -Iv https://mrtumi.com/api/health
```

### Step 8: Safe Canonical Rollback Procedure (If Migration Fails)
If recovery is needed after a failed migration:
```bash
# Locate latest verified manifest:
MANIFEST_FILE=$(ls -t /home/mrtumico/mrtumi/storage/recovery/manifests/manifest_*.json 2>/dev/null | head -1)

# Execute safe canonical non-destructive rollback CLI:
node scripts/ops/recovery-protocol.js --rollback \
  --manifest "$MANIFEST_FILE" \
  --confirm I_CONFIRM_DESTRUCTIVE_DATABASE_RECOVERY
```
