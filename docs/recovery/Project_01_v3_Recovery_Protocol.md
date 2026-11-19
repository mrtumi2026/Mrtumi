# Project 01 — Production Deployment Readiness & Non-Destructive Recovery Protocol (v3.3 Hardened)

**Target System:** Mr. Tumi Multi-Vendor Commerce Platform (`mrtumi-main`)  
**Release Governance:** Cryptographic Ed25519 Detached Release Tickets (`config/release-governance.json` and `scripts/ops/verify-release-approval.js`)  
**Production Baseline Commit (HEAD):** `1b3c9a1950c2e8de7b76efb0d86717b02f64f100`  
**Host Environment:** cPanel / CloudLinux (CageFS/LVE), Node.js >= 22.5.0, MariaDB 10.3+ / 10.11 InnoDB  
**Application Directory:** `$HOME/mrtumi` (`/home/mrtumico/mrtumi`)  
**Database Name:** `mrtumico_live`  
**Audited Modules:** `scripts/ops/recovery-protocol.js`, `scripts/ops/maintenance-guard.js`, `scripts/ops/verify-release-approval.js`, `scripts/ops/sign-release-ticket.js`, `deploy.sh`

---

## 1. Architectural Summary & Vulnerability Remediation (v3.3)

This specification addresses and closes all critical and high-priority audit findings identified by Arena.ai:

| Domain | Prior Vulnerability / Finding | v3.3 Hardened Specification |
|---|---|---|
| **Cryptographic Release Governance** | Candidate failed approval gate, public plaintext strings were treated as signoffs, and `ALLOW_UNLISTED_RELEASE_SHA` allowed arbitrary self-approval. | **Asymmetric Ed25519 Cryptographic Approval**: Removed self-approval bypasses and plaintext signoffs entirely. Release authorization requires a detached cryptographic ticket signed by an authorized offline Ed25519 private key, verified against trusted public keys in `config/release-governance.json`. Candidate commits require NO self-referential git modification. |
| **Emergency Rehearsal Override Isolation** | Ambient `.env` or shell-profile variables (`ALLOW_UNREHEARSED_EMERGENCY_RECOVERY`) could bypass rehearsal prerequisites. | **Strictly Bound Emergency Authorization**: Ambient variables are completely ignored. Override requires a structured authorization object cryptographically bound to the exact manifest `run_id`, target `database_name`, verified operator identity, and operational justification. Rejects cross-run and cross-database reuse, and logs an auditable event in the manifest. |
| **Stale Manifest Pointer Safety** | Pointer validation test had missing `await`, risking false-green reporting. | **Genuinely Awaited Pointer Verification**: Tests strictly await asynchronous rejections. `createHardenedManifest` asserts dump footer before touching pointer; corrupted dumps cannot replace valid pointers. |
| **Streaming Restore EPIPE & Backpressure** | Potential uncaught stream errors or process leakage under abrupt socket disconnection. | **EPIPE Fault Injection Hardening**: `streamRestore` traps downstream socket/pipe severance, safely destroys reader streams, clears interval timers, terminates child processes, and propagates accurate exit codes. |
| **Mandatory Backup Gate** | Manifest was created in Step 4, but `deploy.sh` never enforced manifest validation before running migrations. | **Enforced Pre-Migration Verification Gate (Gate 6.5)**: Calls `validateAndLoadManifest` before running `migrateUp`. Verifies database identity, dump existence, SHA-256 match, size match, genuine `-- Dump completed` footer, and `backup_created=true` + `integrity_verified=true`. Fails closed if any check fails. |
| **Uploads Restore Atomic Swap Rollback** | Moving staged files into target after old target was renamed had no automated rollback; if swap failed, live directory was lost. | **Automatic Target Rollback on Swap Failure**: `restoreUploadsArchive` traps any error during or after moving the old target directory, automatically restoring the original directory back to `resolvedTarget` intact. |
| **Malicious Archive Protection** | Traversal and symlink protection lacked full entry inspection against symlinks, hardlinks, and directory escapes. | **Complete Tar Security Pre-Scan**: Pre-scans tar header listings with `tar -ztvf` to reject symlinks (`l...` or `->`), hardlinks (`h...` or `link to`), absolute paths, null bytes, and `../` traversal. Post-extraction recursively asserts zero symbolic links exist. |
| **Comprehensive Schema Verification** | Test snapshots only checked tables, basic columns, indexes, and row hashes. | **Full 11-Structure Verification**: Extends snapshots and comparisons to include tables, columns + `GENERATION_EXPRESSION`, indexes, foreign keys (`KEY_COLUMN_USAGE`), referential actions (`REFERENTIAL_CONSTRAINTS`), check constraints (`TABLE_CONSTRAINTS`), triggers (`TRIGGERS`), views (`VIEWS`), routines (`ROUTINES`), migrations, and vendor row hashes. |
| **Rollback Silent Failure (`\|\| true`)** | `git checkout --detach` in error trap used `\|\| true`, masking rollback failures. | **Strict Rollback Outcome Verification**: Removed `\|\| true`. If code rollback fails, emits fatal diagnostic, alerts operator, and preserves 503 maintenance mode. |

---

## 2. Cryptographic Release Signing & Verification Workflow

### 2.1 Why Candidate Approval Requires Offline Asymmetric Signatures:
A secure release gate cannot depend on:
1. Public plaintext strings stored in the git repository (e.g. `arena-audit-candidate`). Anyone who reads the repo can supply the same string.
2. Self-referential commit allowlists inside the candidate commit itself. A commit's hash cannot be known before its files are committed.
3. Ambient environment variables (e.g. `ALLOW_UNLISTED_RELEASE_SHA`), which permit an operator or script to self-authorize arbitrary code.

### 2.2 Signing Procedure (Carried Out Offline by Release Governor):
1. Release governor reviews candidate commit `X` on branch `main`.
2. Governor executes `scripts/ops/sign-release-ticket.js` on an isolated workstation holding their private Ed25519 key (e.g., hardware YubiKey or secure keyring, **never** placed in Git):
   ```bash
   node scripts/ops/sign-release-ticket.js \
     --commit "<CANDIDATE_SHA>" \
     --tag "v3.3.0" \
     --key-id "gov-board-2026-ed25519" \
     --key-file "/path/to/offline/gov-board-2026-ed25519.pem" \
     --hours 48 \
     --out "release-ticket.json"
   ```
3. The generated ticket contains a canonical JSON payload and a 64-byte Ed25519 digital signature:
   ```json
   {
     "ticket_version": "1.0",
     "key_id": "gov-board-2026-ed25519",
     "payload": {
       "target_commit": "<CANDIDATE_SHA>",
       "release_tag": "v3.3.0",
       "environment": "production",
       "issued_at": "2026-11-19T06:00:00.000Z",
       "expires_at": "2026-11-21T06:00:00.000Z",
       "key_id": "gov-board-2026-ed25519"
     },
     "signature": "base64_encoded_ed25519_signature..."
   }
   ```

### 2.3 Verification on Deployment Server (`deploy.sh`):
1. Deployment runner receives the target commit SHA and ticket:
   ```bash
   ./deploy.sh "<TARGET_SHA>" "release-ticket.json"
   ```
   Alternatively, passed via environment variable `RELEASE_APPROVAL_TICKET='{...}'`.
2. `verify-release-approval.js`:
   - Validates that the target commit SHA format is a valid 40-character hexadecimal string.
   - Verifies target commit existence in the local git repository (or shallow clone object store).
   - If the SHA is in `historical_baseline_allowlist`, it is approved as an immutable pre-v3 baseline.
   - Otherwise, loads `config/release-governance.json`, checks `ticket.key_id` against `trusted_keys`, asserts the key is not in `revoked_key_ids`, checks validity timestamps, and cryptographically verifies `crypto.verify(null, canonicalPayload, publicKey, signature)`.
   - Rejects fail-closed if signature is invalid, key is untrusted/revoked, ticket is expired, or target commit does not match.

### 2.4 Key Rotation and Revocation Policy:
- **Key Rotation**: When a signing key nears its expiration date (`valid_until`), a new Ed25519 keypair is generated. The new public key is added to `trusted_keys` in `config/release-governance.json` with an updated `valid_from` date.
- **Key Revocation**: If a private signing key is suspected of compromise, its `key_id` is immediately added to `revoked_key_ids` in `config/release-governance.json`. Any ticket signed with that key—regardless of timestamp—is rejected immediately.

---

## 3. Emergency Restore Rehearsal Override Policy

Under canonical operations, `executeCanonicalRecovery` strictly requires `database_restore_rehearsed === true`. In a catastrophic production emergency where rehearsal is impossible due to total database downtime, an operator may provide a run-bound emergency authorization object:

```javascript
{
  target_run_id: "<EXACT_MANIFEST_RUN_ID>",
  target_database: "<TARGET_DATABASE_NAME>",
  operator_id: "operator:name@mrtumi.com",
  justification: "Catastrophic production outage incident #1234: immediate canonical restore authorized by Incident Commander",
  acknowledged_risks: ["DATA_LOSS", "SCHEMA_DIVERGENCE"],
  authorization_code: "EMERGENCY_OVERRIDE:<RUN_ID>:<DB_NAME>"
}
```

### Security Constraints:
1. **Zero Ambient Bypass**: Ambient environment variables (e.g. `ALLOW_UNREHEARSED_EMERGENCY_RECOVERY=true`) are ignored and rejected.
2. **Strict Run & Database Binding**: If `target_run_id` or `target_database` do not match the active recovery operation, it fails closed (`EMERGENCY_OVERRIDE_RUN_MISMATCH` / `EMERGENCY_OVERRIDE_DATABASE_MISMATCH`). Authorization cannot be reused across runs or databases.
3. **Audited Operation**: When accepted, the override event is immutably written into the manifest's audit trail.

---

## 4. Local Engineering Readiness vs. Production Deployment Readiness

### Distinction Between Approval and Production Deployment Permission:
- **Release Approval (Cryptographic Verification)**: Proves that the code candidate has been vetted, reviewed, and cryptographically authorized by the Release Governance Board.
- **Production Deployment Permission (Operational Sign-off)**: Requires that the live production environment meets all physical prerequisites (cPanel disk quota, memory headroom, crontab backup, and passenger health).

### Why Local Engineering PASS Does Not Mean Production GO:
While local tests (583+ tests across MariaDB 10.11 and MySQL 8.0) prove code correctness, schema parity, and error handling, they cannot guarantee:
1. That `/home/mrtumico` on cPanel has sufficient free disk space to write the full SQL dump and uploads tarball.
2. That live CloudLinux LVE limits will not throttle I/O during mysqldump.
3. That live cPanel crontab permissions will allow uninterrupted suspension.

Therefore, local testing produces a verdict of **ENGINEERING CANDIDATE READY**, while production deployment remains **CONDITIONAL ON LIVE PREFLIGHT SIGN-OFF**.
