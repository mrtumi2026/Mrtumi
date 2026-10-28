# BESTWEBHOSTBD HOSTING & cPANEL COMPATIBILITY SPECIFICATION
**Project:** Mr. Tumi Grocery & Gift
**Hosting Provider:** BestWebHostBD
**Last Updated:** 2026-10-28 (`Asia/Dhaka`)

---

## 1. Confirmed vs. Unverified Hosting Capabilities

Per engineering governance rules, capabilities confirmed by BestWebHostBD support through the owner are strictly separated from runtime, database-version, and operational details that have **not yet been independently verified** on the target server.

### 1.1 Confirmed Capabilities (Owner-Confirmed via BestWebHostBD Support)

| # | Capability | Evidence Source | Status | Architectural Impact |
|---|---|---|---|---|
| **C-01** | **Node.js Application Support** | Owner confirmation from BestWebHostBD support | **`CONFIRMED` (Owner-Provided)** | Existing **Node.js + Express + EJS modular monolith** is retained; no PHP/Laravel framework rewrite is needed. |
| **C-02** | **SSH Terminal Access** | Owner confirmation from BestWebHostBD support | **`CONFIRMED` (Owner-Provided)** | Enables Git-based release pulls, CLI dependency installation (`npm ci --omit=dev`), non-interactive database migrations, and diagnostic health checks. |
| **C-03** | **MySQL Is the Only Supported Database** | Owner confirmation from BestWebHostBD support | **`CONFIRMED` (Owner-Provided)** | **MySQL (`InnoDB`, `utf8mb4`) is locked as the mandatory production database.** PostgreSQL is ruled out, and **SQLite must NOT be used in production**. |

---

### 1.2 Still-Unverified Hosting Details (`UNVERIFIED` Until Checked on Server)

None of the items below have been assumed or fabricated. The documents distinguish project-source behavior from account capabilities. MySQL 8.0 is the CI-verified database; compatibility with other MySQL releases, MariaDB, or a particular cPanel/CloudLinux configuration is not certified until tested against that exact target.

| # | Capability / Parameter | Why It Matters | Current Status | Safe Engineering Mitigation & Verification Action |
|---|---|---|---|---|
| **U-01** | **Exact Node.js Runtime Version** | `package.json` currently declares `node >=22.5.0`; `src/db/database.js` lazily loads `node:sqlite` on the local SQLite path. Do not infer support for Node 18/20 from `mysql2` alone because the application package contract is stricter. | **`UNVERIFIED`** | **Mitigation:** select a maintained host runtime satisfying `>=22.5.0`, then verify startup, migration CLI, runtime health and full tests on staging. Any lowering of the engine floor requires a separate source/dependency/runtime compatibility change and tests. **Owner/SSH Check:** run `node -v`, `npm -v` and confirm cPanel/VPS process uses that same Node binary. |
| **U-02** | **Exact MySQL / MariaDB Server Version** | MySQL 8.0 is the CI-tested dialect. MySQL 5.7 and MariaDB may differ on migration syntax, constraints, JSON behavior and transaction details; no compatibility certification is inferred. | **`UNVERIFIED`** | **Mitigation:** treat MySQL 8.0 as the currently verified target. If the account offers MariaDB or another MySQL release, record its exact version and run the full migration lifecycle and application integration tests against that exact server before accepting it. **Owner/SSH Check:** `SELECT VERSION();` and verify InnoDB, charset/collation, SQL mode and limits. |
| **U-03** | **Application Process Manager & Startup Mechanism** | The actual account's cPanel/CloudLinux build, Node app interface, Passenger/LiteSpeed integration, port/socket injection and restart behavior have not been inspected. Do not assume that an interface exists or that it assigns `PORT`. | **`UNVERIFIED`** | **Mitigation:** Source has `app.js` as deployment wrapper and `server.js` as Express/app listener; `app.js` reads the configured `HOST`/`PORT` through `server.js`. This is project evidence only, not proof of host launch compatibility. **Owner Check:** Provide exact cPanel version/interface details and confirm startup-file, process, port, environment, restart and log contract before selecting settings. |
| **U-04** | **Persistent Upload Directory & URL Mapping** | A durable writable path, public URL mapping, quotas and backup coverage are unknown. Release-local uploads can be lost on redeploy. | **`UNVERIFIED`** | **Mitigation:** `UPLOAD_DIR` is configurable; production validation requires an absolute path outside the app root, and `/uploads/custom/` has a dedicated static fallback. **Owner/SSH Check:** confirm actual path permissions, persistence, web exposure policy, quota and backup coverage; do not assume symlinks are allowed. |
| **U-05** | **Cron Job Availability & Minimum Frequency** | Host cron availability, minimum interval, run-as account, CLI environment and logs are unverified. `scripts/cron-runner.js` is absent; reservation expiry is a separate one-shot CLI and no job has been scheduled. | **`UNVERIFIED`** | **Mitigation:** Do not configure a nonexistent runner or use in-memory timers. Implement and test any required idempotent CLI job first; then confirm the actual panel's Cron Jobs feature, minimum interval, absolute Node path, working directory, service account, locking and failure monitoring. |
| **U-06** | **CloudLinux resource and inode quotas** | RAM, process/entry-process, I/O, inode, storage and MySQL connection limits are account-specific and unknown. | **`UNVERIFIED`** | **Mitigation:** pool default is 10 and bounded by application code, but this does not guarantee it fits host limits. Select a value only after reading the account's actual quotas and MySQL cap. **Owner Check:** record the panel's measured limits for the target plan. |
| **U-07** | **Outbound API egress & SMTP** | Any provider-specific outbound HTTPS/SMTP access, DNS, firewall rules and provider policies are unknown. No live provider action is part of this assessment. | **`UNVERIFIED`** | **Mitigation:** keep integrations disabled/fail-closed until specifications, credentials and owner approvals exist. Verify only approved staging endpoints with safe non-mutating requests; do not assume connectivity tests or provider operations are implemented. |
| **U-08** | **Host backup schedule, restore and MySQL recovery** | Provider backup coverage, schedule, retention, restore access, RPO/RTO and point-in-time recovery are unverified. `scripts/backup.sh` is absent. | **`UNVERIFIED`** | **Mitigation:** no backup command is ready to configure. Define owner-approved recovery objectives, implement reviewed tooling, and rehearse restore only into isolated disposable targets. Confirm cPanel/provider tools and coverage before a release plan. |

---

## 2. Non-Destructive Read-Only SSH Discovery Commands (For Owner Reference)

Because **SSH access is confirmed**, you can verify `U-01` through `U-07` in under 30 seconds by running the following **read-only** command in your BestWebHostBD SSH terminal (**never paste passwords or secret keys into chat**):

```bash
echo "=== OS & Kernel ===" && uname -a
echo "=== Default Node & NPM ===" && (node -v 2>/dev/null || echo "not in default PATH") && (npm -v 2>/dev/null || true)
echo "=== CloudLinux Node Selector Versions ===" && ls -d /opt/alt/alt-nodejs* 2>/dev/null || echo "no /opt/alt/alt-nodejs found"
echo "=== MySQL / MariaDB Client Version ===" && mysql --version 2>/dev/null || echo "mysql client not in PATH"
echo "=== Cron Crontab Check ===" && (crontab -l 2>/dev/null | wc -l) || echo "crontab restricted"
echo "=== Disk & Inode Quota ===" && quota -s 2>/dev/null || df -h ~
```

Sharing only that non-sensitive version output before or during Phase 03 will let us lock the exact Node selector path and MySQL dialect version with 100% precision.
