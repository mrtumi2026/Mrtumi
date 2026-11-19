# Project 01 — Production Deployment Readiness & Non-Destructive Recovery Protocol (v3.4 Hardened)

**Target System:** Mr. Tumi Multi-Vendor Commerce Platform (`mrtumi-main`)  
**Release Governance:** Asymmetric Ed25519 Cryptographic Release Tickets with Out-Of-Band Trust Anchoring  
**Governance Config:** `config/release-governance.json` (verified by `scripts/ops/verify-release-approval.js`)  
**Production Baseline Commit (HEAD):** `1b3c9a1950c2e8de7b76efb0d86717b02f64f100`  
**Host Environment:** cPanel / CloudLinux (CageFS/LVE), Node.js >= 22.5.0, MariaDB 10.3+ / 10.11 InnoDB  
**Application Directory:** `$HOME/mrtumi` (`/home/mrtumico/mrtumi`)  
**Database Name:** `mrtumico_live`  
**Audited Modules:** `scripts/ops/recovery-protocol.js`, `scripts/ops/maintenance-guard.js`, `scripts/ops/verify-release-approval.js`, `scripts/ops/sign-release-ticket.js`, `deploy.sh`

---

## 1. Architectural Summary & Vulnerability Remediation (v3.4)

| Domain | Prior Vulnerability / Finding | v3.4 Hardened Specification |
|---|---|---|
| **Cryptographic Release Governance** | Candidate failed approval gate, public plaintext strings were treated as signoffs, and `ALLOW_UNLISTED_RELEASE_SHA` allowed arbitrary self-approval. | **Asymmetric Ed25519 Cryptographic Approval**: Removed self-approval bypasses and plaintext signoffs entirely. Release authorization requires a detached cryptographic ticket signed by an authorized offline Ed25519 private key, verified against trusted public keys in `config/release-governance.json`. Candidate commits require NO self-referential git modification. |
| **Independent Trust Anchor** | Trust store resided solely within the mutable Git repository, meaning a rogue commit could alter trusted public keys. | **Out-Of-Band Trust Anchoring**: The deployment host verifies the in-repo governance store against an independent, out-of-band trust anchor (`~/.mrtumi_governance_trust_anchor.json` or `GOVERNANCE_TRUST_ANCHOR_SHA256`). If the in-repo store is modified without updating the host trust anchor, verification fails closed (`TRUST_ANCHOR_INTEGRITY_MISMATCH`). |
| **Release Tag & Environment Enforcement** | `release_tag` pattern was not strictly validated; staging tickets could be replayed in production. | **Strict Tag & Environment Isolation**: Enforces semantic release tag pattern (`^v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$`). Staging tickets (`environment: 'staging'`) are strictly rejected for production deployments. Production tickets must explicitly identify `environment: 'production'`. |
| **Key Validity Window Enforcement** | Key expiration and active dates (`valid_from`, `valid_until`) were not actively enforced at verification time. | **Key Validity & Rotation Enforcement**: Verifier actively validates `valid_from <= now <= valid_until`. Keys that are not yet active or have expired are rejected fail-closed, alongside revoked keys. |
| **Fail-Closed Emergency Audit Logging** | If manifest path was missing, emergency override could proceed without persisting an audit record. | **Mandatory Durable Audit Persistence**: Emergency override strictly asserts manifest file presence. If the manifest path is missing or unwritable, recovery aborts immediately (`FAIL_CLOSED_AUDIT_REQUIRED` / `FAIL_CLOSED_AUDIT_PERSISTENCE_FAILED`). |
| **Stale Manifest Pointer Safety** | Pointer validation test had missing `await`, risking false-green reporting. | **Genuinely Awaited Pointer Verification**: Tests strictly await asynchronous rejections. `createHardenedManifest` asserts dump footer before touching pointer; corrupted dumps cannot replace valid pointers. |
| **Streaming Restore EPIPE & Backpressure** | Potential uncaught stream errors or process leakage under abrupt socket disconnection. | **EPIPE Fault Injection Hardening**: `streamRestore` traps downstream socket/pipe severance, safely destroys reader streams, clears interval timers, terminates child processes, and propagates accurate exit codes. |
| **Mandatory Backup Gate** | Manifest was created in Step 4, but `deploy.sh` never enforced manifest validation before running migrations. | **Enforced Pre-Migration Verification Gate (Gate 6.5)**: Calls `validateAndLoadManifest` before running `migrateUp`. Verifies database identity, dump existence, SHA-256 match, size match, genuine `-- Dump completed` footer, and `backup_created=true` + `integrity_verified=true`. Fails closed if any check fails. |
| **Uploads Restore Atomic Swap Rollback** | Moving staged files into target after old target was renamed had no automated rollback; if swap failed, live directory was lost. | **Automatic Target Rollback on Swap Failure**: `restoreUploadsArchive` traps any error during or after moving the old target directory, automatically restoring the original directory back to `resolvedTarget` intact. |
| **Malicious Archive Protection** | Traversal and symlink protection lacked full entry inspection against symlinks, hardlinks, and directory escapes. | **Complete Tar Security Pre-Scan**: Pre-scans tar header listings with `tar -ztvf` to reject symlinks (`l...` or `->`), hardlinks (`h...` or `link to`), absolute paths, null bytes, and `../` traversal. Post-extraction recursively asserts zero symbolic links exist. |
| **Comprehensive Schema Verification** | Test snapshots only checked tables, basic columns, indexes, and row hashes. | **Full 11-Structure Verification**: Extends snapshots and comparisons to include tables, columns + `GENERATION_EXPRESSION`, indexes, foreign keys (`KEY_COLUMN_USAGE`), referential actions (`REFERENTIAL_CONSTRAINTS`), check constraints (`TABLE_CONSTRAINTS`), triggers (`TRIGGERS`), views (`VIEWS`), routines (`ROUTINES`), migrations, and vendor row hashes. |
| **Rollback Silent Failure (`\|\| true`)** | `git checkout --detach` in error trap used `\|\| true`, masking rollback failures. | **Strict Rollback Outcome Verification**: Removed `\|\| true`. If code rollback fails, emits fatal diagnostic, alerts operator, and preserves 503 maintenance mode. |

---

## 2. Cryptographic Release Governance & Trust Anchoring

### 2.1 The Need for Independent Out-of-Band Trust Anchoring:
If trust configuration resides solely within the Git repository, an attacker who compromises repository write access could simply add their own public key to `config/release-governance.json` and sign malicious releases.

To establish an immutable trust boundary:
1. **Repository Layer:** `config/release-governance.json` provides the public key registry, policy bounds, and historical baselines.
2. **Host Layer (Out-Of-Band Trust Anchor):** The cPanel production host maintains an independent trust anchor file at `/home/mrtumico/.mrtumi_governance_trust_anchor.json` (or environment variable `GOVERNANCE_TRUST_ANCHOR_SHA256`).
3. **Integrity Enforcement:** During deployment, `verify-release-approval.js` calculates the SHA-256 hash of `config/release-governance.json` and compares it to the host-pinned anchor. If any in-repo public key or policy was modified without authorized host-level provisioning, deployment fails closed.

### 2.2 Offline Signing Workflow (Release Governor):
1. Release governor reviews candidate commit `X` on branch `main`.
2. Governor executes `scripts/ops/sign-release-ticket.js` on an isolated workstation holding their private Ed25519 key (stored on hardware security token, **never** in Git):
   ```bash
   node scripts/ops/sign-release-ticket.js \
     --commit "<CANDIDATE_SHA>" \
     --tag "v3.4.0" \
     --env "production" \
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
       "release_tag": "v3.4.0",
       "environment": "production",
       "issued_at": "2026-11-19T07:00:00.000Z",
       "expires_at": "2026-11-21T07:00:00.000Z",
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
   (Alternatively, passed via environment variable `RELEASE_APPROVAL_TICKET='{...}'`).
2. `verify-release-approval.js`:
   - Validates that the target commit SHA format is a valid 40-character hexadecimal string.
   - Verifies target commit existence in the local git repository (or shallow clone object store).
   - If the SHA is in `historical_baseline_allowlist`, it is approved as an immutable pre-v3 baseline.
   - Verifies in-repo governance store against the out-of-band trust anchor.
   - Asserts `payload.release_tag` matches semantic tag pattern (`^v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$`).
   - Asserts `payload.environment === 'production'`.
   - Checks `ticket.key_id` against `trusted_keys` and asserts it is not in `revoked_key_ids`.
   - Asserts key validity window: `valid_from <= now <= valid_until`.
   - Asserts ticket expiration window: `issued_at <= now <= expires_at`.
   - Reconstructs canonical JSON and cryptographically verifies `crypto.verify(null, canonicalBytes, publicKey, signature)`.
   - Rejects fail-closed if any check fails.

### 2.4 Key Rotation and Revocation Policy:
- **Key Rotation**: When a signing key nears its expiration date (`valid_until`), a new Ed25519 keypair is generated. The new public key is added to `trusted_keys` in `config/release-governance.json` with an updated `valid_from` date. The host trust anchor is updated out-of-band by the Lead Infrastructure Architect.
- **Key Revocation**: If a private signing key is suspected of compromise, its `key_id` is immediately added to `revoked_key_ids`. Any ticket signed with that key—regardless of timestamp—is rejected immediately.

---

## 3. Fail-Closed Emergency Restore Rehearsal Override Policy

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
3. **Mandatory Durable Audit Persistence**: Manifest file presence is strictly asserted. If `manifestPath` is missing or unwritable, recovery aborts immediately (`FAIL_CLOSED_AUDIT_REQUIRED` / `FAIL_CLOSED_AUDIT_PERSISTENCE_FAILED`). Override never succeeds without an immutable audit record.

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
4. That the authorized release governor has performed the external offline signing ritual for production.

Therefore, local testing produces a verdict of **ENGINEERING CANDIDATE READY**, while production deployment remains **CONDITIONAL ON LIVE PREFLIGHT SIGN-OFF AND OFFLINE SIGNING**.
