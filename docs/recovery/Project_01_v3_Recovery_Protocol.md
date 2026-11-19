# Project 01 — Production Deployment Readiness & Non-Destructive Recovery Protocol (v3.6 Hardened)

**Target System:** Mr. Tumi Multi-Vendor Commerce Platform (`mrtumi-main`)  
**Release Governance:** Asymmetric Ed25519 Cryptographic Release Tickets with Mandatory Out-Of-Band Trust Anchoring  
**Governance Config:** `config/release-governance.json` (verified by `scripts/ops/verify-release-approval.js`)  
**Production Baseline Commit (HEAD):** `1b3c9a1950c2e8de7b76efb0d86717b02f64f100`  
**Host Environment:** cPanel / CloudLinux (CageFS/LVE), Node.js >= 22.5.0, MariaDB 10.3+ / 10.11 InnoDB  
**Application Directory:** `$HOME/mrtumi` (`/home/mrtumico/mrtumi`)  
**Live Production Database:** `mrtumico_live`  
**Audited Modules:** `scripts/ops/recovery-protocol.js`, `scripts/ops/maintenance-guard.js`, `scripts/ops/verify-release-approval.js`, `scripts/ops/sign-release-ticket.js`, `scripts/ci/generate-test-summary.js`, `deploy.sh`

---

## 1. Architectural Summary & Vulnerability Remediation (v3.6)

| Domain | Prior Vulnerability / Finding | v3.6 Hardened Specification |
|---|---|---|
| **Restore Rehearsal Isolation & Parity** | Rehearsal only checked if DB name differed from production DB name. Did not verify host identity, credentials isolation, explicit disposable authorization, schema/row-count parity, or concurrent runs. | **Full Rehearsal Safety & Parity Suite**: Validates target host, port, DB identity, and credentials isolation against production credentials. Requires explicit disposable authorization (`authorized_disposable`). Concurrency protection via OS tmpdir lock. Post-restore validates table counts, schema parity, critical row counts, and foreign key integrity constraints. Rehearsal failure aborts deployment fail-closed before code merge. |
| **Restore Rehearsal Required by Default** | `DEPLOY_REQUIRE_REHEARSAL` defaulted to `false` in `deploy.sh`. | **Mandatory Rehearsal by Default**: `deploy.sh` enforces `DEPLOY_REQUIRE_REHEARSAL=true` by default for production deployments. Missing `REHEARSAL_DB_NAME` aborts immediately with a FATAL error. |
| **CI Summary Generator Fail-Closed** | Fragile first-match regexes could capture partial logs; `\|\| true` suppressed errors; `if-no-files-found: warn` masked missing artifacts; zero tests could pass. | **Deterministic TAP/Spec Parser**: Robust parser validates TAP / Node spec blocks; asserts `tests === passed + failed + skipped + cancelled + todo`; asserts `tests > 0` and `passed > 0`; removes `\|\| true`; sets `if-no-files-found: error`; deterministically exits code 1 on test or summary failure. |
| **Signer CLI Argument Enforcement** | Unrecognized flags were ignored without error; missing values were not caught. | **Strict Signer Argument Validation**: Rejects unknown CLI flags immediately (`validFlags` set). Validates that every flag is followed by a non-flag value. Supports both `--out` and `--out-file`. |
| **Trust Anchor File Permission & Schema** | Code did not validate POSIX permissions or strict JSON structure on trust anchor. | **Strict Permissions & Schema Guard**: On POSIX hosts, rejects trust anchor files if group-writable or world-writable (`mode & 0o022`). Strict schema check validates semantic version pattern and `expected_governance_sha256`. Symlinks remain strictly forbidden. |
| **Manifest Protocol Alignment** | Manifest version was '3.5'. | **Schema Version 3.6**: Manifest and rehearsal protocol updated to v3.6. |

---

## 2. Cryptographic Release Governance & Offline Signing

### 2.1 The Need for Independent Out-of-Band Trust Anchoring:
If trust configuration resides solely within the Git repository, an attacker with repository write access could simply add their own public key to `config/release-governance.json` and sign malicious releases.

To establish an immutable trust boundary:
1. **Repository Layer:** `config/release-governance.json` provides the public key registry, policy bounds, and historical baselines.
2. **Host Layer (Out-Of-Band Trust Anchor):** The cPanel production host maintains an independent trust anchor file at `/home/mrtumico/.mrtumi_governance_trust_anchor.json` (mode 0600, non-symlink, owned by `mrtumico`) or environment variable `GOVERNANCE_TRUST_ANCHOR_SHA256`.
3. **Integrity Enforcement:** During deployment, `verify-release-approval.js` calculates the SHA-256 hash of `config/release-governance.json` and compares it to the host-pinned anchor. If missing, deployment aborts (`TRUST_ANCHOR_REQUIRED`). If any in-repo public key or policy was modified without authorized host-level provisioning, deployment fails closed (`TRUST_ANCHOR_INTEGRITY_MISMATCH`).

### 2.2 Secure Offline Key-Bootstrap & Rotation Runbook:

#### Initial Offline Keypair Generation (Cold Workstation):
The repository owner must generate their Ed25519 keypair on an air-gapped or secure developer workstation (NEVER in Git, cPanel, or CI):
```bash
# Generate Ed25519 private key in PKCS#8 format
openssl genpkey -algorithm ed25519 -out /secure/cold/storage/gov-key-2026-11.pem
chmod 400 /secure/cold/storage/gov-key-2026-11.pem

# Extract corresponding public key
openssl pkey -in /secure/cold/storage/gov-key-2026-11.pem -pubout -out /secure/cold/storage/gov-key-2026-11.pub
```

#### Registering the Public Key in Repository:
1. Open `config/release-governance.json`.
2. Add the public key object to `trusted_keys`:
   ```json
   {
     "key_id": "gov-key-2026-11",
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
4. Commit the updated `config/release-governance.json` to Git.

#### Key Rotation & Revocation Procedure:
If a key expires or is compromised:
1. Generate a new keypair (`gov-key-2027-01`).
2. Add the old key ID (`gov-key-2026-11`) to `revoked_key_ids` in `config/release-governance.json`.
3. Add the new key to `trusted_keys`.
4. Calculate the new SHA-256 and update the out-of-band trust anchor on the cPanel host.

### 2.3 Offline Ticket Signing:
```bash
node scripts/ops/sign-release-ticket.js \
  --commit "<CANDIDATE_SHA>" \
  --tag "v3.6.0" \
  --env "production" \
  --key-id "gov-key-2026-11" \
  --key-file "/secure/cold/storage/gov-key-2026-11.pem" \
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
  "schema_version": "3.6",
  "expected_governance_sha256": "bae061c98d0ed933030aacbe8f657229664424aae0449cd57d367d014dbdb777",
  "anchor_created_at": "2026-11-19T10:00:00Z"
}
EOF
fi
chmod 600 "$ANCHOR_FILE"
```

### Step 3: Disk Quota and Extraction Capacity Calculation
Never rely on a rough estimate. Calculate exact requirements:
```bash
# 1. Database size:
DB_SIZE=$(du -sm /var/lib/mysql/mrtumico_live 2>/dev/null | cut -f1 || echo "250")
# 2. Uploads directory size:
UPLOADS_SIZE=$(du -sm /home/mrtumico/uploads 2>/dev/null | cut -f1 || echo "500")
# 3. Calculation formula:
# Required Space = (DB_SIZE * 1.5) [SQL dump] + (UPLOADS_SIZE * 1.2) [Tar archive] + (UPLOADS_SIZE * 1.0) [Staging extraction] + 500 MB [Headroom]
REQUIRED_MB=$(( (DB_SIZE * 3 / 2) + (UPLOADS_SIZE * 12 / 10) + UPLOADS_SIZE + 500 ))

echo "Estimated required free disk space: ${REQUIRED_MB} MB"
quota -s || df -h "$HOME"
```

### Step 4: Disposable Rehearsal Database Setup
Ensure an isolated disposable database exists in cPanel MySQL:
- Target Name: `mrtumico_rehearsal`
- Confirm that `mrtumico_rehearsal` does NOT contain production tables and is granted to the deployment user.

### Step 5: Pre-Deployment Operational Suspension
Before running deployment:
```bash
# 1. Back up current crontab:
crontab -l > "$HOME/crontab_backup_$(date +%Y%m%d_%H%M%S).txt"
# 2. Suspend worker cron jobs:
crontab -r 2>/dev/null || true
# 3. Preserve .htaccess rules:
cp /home/mrtumico/mrtumi/public/.htaccess "$HOME/.htaccess_backup_predeploy"
```

### Step 6: Deployment Execution
Upload the signed `release-ticket.json` to the server, then execute:
```bash
export GOVERNANCE_TRUST_ANCHOR_PATH="$HOME/.mrtumi_governance_trust_anchor.json"
export REHEARSAL_DB_NAME="mrtumico_rehearsal"
export DEPLOY_REQUIRE_REHEARSAL="true"

./deploy.sh "<APPROVED_TARGET_SHA>" "release-ticket.json" "v3.6.0"
```

### Step 7: Post-Deployment Verification
```bash
# 1. Restart Passenger:
mkdir -p /home/mrtumico/mrtumi/tmp
touch /home/mrtumico/mrtumi/tmp/restart.txt

# 2. Restore crontab:
crontab "$HOME/crontab_backup_*.txt"

# 3. Verify HTTP response & maintenance lock removal:
curl -Iv https://mrtumi.com/api/health
```

### Step 8: Rollback Procedure (If Migration Fails)
If recovery is needed:
```bash
# Execute non-destructive canonical recovery using latest verified manifest:
node scripts/ops/recovery-protocol.js --rollback
```
