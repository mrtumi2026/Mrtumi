# Project 01 — Production Deployment Readiness & Non-Destructive Recovery Protocol (v3.5 Hardened)

**Target System:** Mr. Tumi Multi-Vendor Commerce Platform (`mrtumi-main`)  
**Release Governance:** Asymmetric Ed25519 Cryptographic Release Tickets with Mandatory Out-Of-Band Trust Anchoring  
**Governance Config:** `config/release-governance.json` (verified by `scripts/ops/verify-release-approval.js`)  
**Production Baseline Commit (HEAD):** `1b3c9a1950c2e8de7b76efb0d86717b02f64f100`  
**Host Environment:** cPanel / CloudLinux (CageFS/LVE), Node.js >= 22.5.0, MariaDB 10.3+ / 10.11 InnoDB  
**Application Directory:** `$HOME/mrtumi` (`/home/mrtumico/mrtumi`)  
**Database Name:** `mrtumico_live`  
**Audited Modules:** `scripts/ops/recovery-protocol.js`, `scripts/ops/maintenance-guard.js`, `scripts/ops/verify-release-approval.js`, `scripts/ops/sign-release-ticket.js`, `deploy.sh`

---

## 1. Architectural Summary & Vulnerability Remediation (v3.5)

| Domain | Prior Vulnerability / Finding | v3.5 Hardened Specification |
|---|---|---|
| **Mandatory Out-Of-Band Trust Anchor** | In v3.4, trust anchor was optional in code when neither anchor file nor environment SHA was provided (falling back to in-repo store). | **Strictly Mandatory & Fail-Closed**: Verification aborts immediately (`TRUST_ANCHOR_REQUIRED`) if neither independent anchor file (`~/.mrtumi_governance_trust_anchor.json` / `GOVERNANCE_TRUST_ANCHOR_PATH`) nor `GOVERNANCE_TRUST_ANCHOR_SHA256` is provisioned. Symbolic links are strictly rejected (`TRUST_ANCHOR_SYMLINK_FORBIDDEN`), empty/malformed files rejected, and conflict between file and environment SHA fails closed (`TRUST_ANCHOR_CONFLICT`). |
| **Mandatory Expected Release Tag** | `DEPLOY_RELEASE_TAG` was not wired into `deploy.sh`, so only regex was verified on production deploy path. | **Strict Expected Tag Matching**: `deploy.sh` requires `EXPECTED_RELEASE_TAG` for production deployments. Verifier asserts that `payload.release_tag` matches `expectedTag` exactly. Missing expected tag in production aborts immediately (`MISSING_EXPECTED_TAG`). |
| **Mandatory Cryptographic Signer Arguments** | `sign-release-ticket.js` silently defaulted `--tag` to `v1.0.0` and `--env` to `production` when omitted. | **Zero Silent Defaults**: All of `--commit`, `--tag`, `--env`, `--key-id`, and `--key-file` are strictly mandatory. Missing or malformed parameters fail immediately with clear errors. |
| **Policy Flags Enforcement** | Policy flags (`require_cryptographic_signature`, `allow_ambient_signoffs`, `allowed_signature_algorithms`) were unenforced. | **Active Policy Enforcement**: Only Ed25519 signatures are permitted (`UNSUPPORTED_SIGNATURE_ALGORITHM`), key algorithm must match ticket algorithm, ambient sign-offs and unlisted SHA bypass variables are strictly rejected (`SECURITY_POLICY_VIOLATION`). |
| **Key Rotation Workflow** | Rotation procedure was documented but lacked executable validation. | **Tested Key Rotation**: Validated end-to-end: new Ed25519 key added to `trusted_keys`, compromised/old key added to `revoked_key_ids`, trust anchor updated. Verifier rejects old key tickets and accepts new key tickets. |
| **Deploy Failure Trap Hidden Suppression** | `mg.persistOnFailure(...) \|\| true` in `deploy.sh` masked maintenance persistence errors. | **Explicit Fatal Failure Diagnostic**: Removed `\|\| true`. Failure to persist maintenance lock emits an explicit FATAL alert with emergency operator instructions. |
| **Pre-Migration Restore Rehearsal Wiring** | `rehearseDatabaseRestore()` existed in library code but was not invoked in `deploy.sh`. | **Wired Rehearsal Gate**: `deploy.sh` supports pre-migration restore rehearsal into an isolated disposable schema (`REHEARSAL_DB_NAME`). Rehearsal target cannot match production database. Manifest updates `database_restore_rehearsed: true` upon success. Gate 6.5 enforces rehearsal when `DEPLOY_REQUIRE_REHEARSAL=true`. |
| **Cross-Platform Tar Archive Security** | Entry path parsing in uploads restore relied on tokenizing GNU `tar -ztvf` output text columns. | **Structured Path Listing**: Employs `tar -ztf` for clean, un-tokenized cross-platform entry inspection (GNU, BSD, and BusyBox tar safe), alongside `tar -ztvf` link inspection to reject symlinks, hardlinks, absolute paths, and traversal. |
| **Memory Overhead Reporting** | Streaming memory claim needed empirical accuracy. | **Accurate Empirical Bounds**: Node.js streaming RSS overhead measured at ~5.2 MB under test workloads (not a universal memory guarantee across arbitrarily large schema/blobs). |
| **Manifest Protocol Alignment** | Manifest version was legacy '3.2'. | **Schema Version 3.5**: Manifest and governance schema aligned to v3.5. |

---

## 2. Cryptographic Release Governance & Trust Anchoring

### 2.1 The Need for Independent Out-of-Band Trust Anchoring:
If trust configuration resides solely within the Git repository, an attacker who compromises repository write access could simply add their own public key to `config/release-governance.json` and sign malicious releases.

To establish an immutable trust boundary:
1. **Repository Layer:** `config/release-governance.json` provides the public key registry, policy bounds, and historical baselines.
2. **Host Layer (Out-Of-Band Trust Anchor):** The cPanel production host maintains an independent trust anchor file at `/home/mrtumico/.mrtumi_governance_trust_anchor.json` (mode 0600, non-symlink) or environment variable `GOVERNANCE_TRUST_ANCHOR_SHA256`.
3. **Integrity Enforcement:** During deployment, `verify-release-approval.js` calculates the SHA-256 hash of `config/release-governance.json` and compares it to the host-pinned anchor. If missing, deployment aborts (`TRUST_ANCHOR_REQUIRED`). If any in-repo public key or policy was modified without authorized host-level provisioning, deployment fails closed (`TRUST_ANCHOR_INTEGRITY_MISMATCH`).

### 2.2 Offline Signing Workflow (Release Governor):
1. Release governor reviews candidate commit `X` on branch `main`.
2. Governor executes `scripts/ops/sign-release-ticket.js` on an isolated workstation holding their private Ed25519 key (stored on hardware security token, **never** in Git):
   ```bash
   node scripts/ops/sign-release-ticket.js \
     --commit "<CANDIDATE_SHA>" \
     --tag "v3.5.0" \
     --env "production" \
     --key-id "gov-board-2026-ed25519" \
     --key-file "/path/to/offline/gov-board-2026-ed25519.pem" \
     --hours 48 \
     --out "release-ticket.json"
   ```
3. The generated ticket contains a canonical JSON payload, Ed25519 algorithm identifier, and a base64 digital signature.

### 2.3 Verification on Deployment Server (`deploy.sh`):
1. Deployment runner receives the target commit SHA, ticket, and expected tag:
   ```bash
   ./deploy.sh "<TARGET_SHA>" "release-ticket.json" "v3.5.0"
   ```
2. `deploy.sh` asserts host trust-anchor provisioning before running any step.
3. `verify-release-approval.js`:
   - Validates that the target commit SHA is a valid 40-character hexadecimal string.
   - Asserts out-of-band trust anchor presence, non-symlink status, and hash integrity.
   - Enforces security policy flags: disallows ambient sign-offs and unlisted bypasses.
   - Verifies target commit existence in the local git repository.
   - If the SHA is in `historical_baseline_allowlist`, it is approved as an immutable pre-v3 baseline.
   - Asserts `payload.release_tag` matches semantic pattern and matches `expectedTag` exactly.
   - Asserts `payload.environment === 'production'`.
   - Asserts signature algorithm is permitted (`ed25519`).
   - Checks `ticket.key_id` against `trusted_keys` and asserts it is not in `revoked_key_ids`.
   - Asserts key validity window: `valid_from <= now <= valid_until`.
   - Asserts ticket expiration window: `issued_at <= now <= expires_at`.
   - Reconstructs canonical JSON and cryptographically verifies `crypto.verify(null, canonicalBytes, publicKey, signature)`.
   - Rejects fail-closed if any check fails.

---

## 3. Local Engineering Readiness vs. Production Deployment Readiness

### Distinction Between Approval and Production Deployment Permission:
- **Release Approval (Cryptographic Verification)**: Proves that the code candidate has been vetted, reviewed, and cryptographically authorized by the Release Governance Board.
- **Production Deployment Permission (Operational Sign-off)**: Requires that the live production environment meets all physical prerequisites (cPanel disk quota, memory headroom, crontab backup, and passenger health).

### Why Local Engineering PASS Does Not Mean Production GO:
While local tests prove code correctness, schema parity, and error handling, they cannot guarantee:
1. That `/home/mrtumico` on cPanel has sufficient free disk space to write the full SQL dump and uploads tarball.
2. That live CloudLinux LVE limits will not throttle I/O during mysqldump.
3. That live cPanel crontab permissions will allow uninterrupted suspension.
4. That the authorized release governor has performed the external offline signing ritual for production.

Therefore, local testing produces a verdict of **ENGINEERING CANDIDATE READY**, while production deployment remains **CONDITIONAL ON LIVE PREFLIGHT SIGN-OFF AND OFFLINE SIGNING**.
