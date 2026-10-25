# BESTWEBHOSTBD HOSTING & cPANEL COMPATIBILITY SPECIFICATION
**Project:** Mr. Tumi Grocery & Gift  
**Hosting Provider:** BestWebHostBD  
**Last Updated:** 2026-10-25 (`Asia/Dhaka`)  

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

None of the items below have been assumed or fabricated. Our Phase 02 architecture (`docs/ARCHITECTURE.md`) and MySQL migration plan (`docs/MYSQL_MIGRATION_PLAN.md`) are engineered defensively so they remain compatible across common cPanel/CloudLinux variations until verified:

| # | Capability / Parameter | Why It Matters | Current Status | Safe Engineering Mitigation & Verification Action |
|---|---|---|---|---|
| **U-01** | **Exact Node.js Runtime Version(s)** (`18.x`, `20.x`, or `22.x`) | Prototype `src/db/database.js` uses `node:sqlite` (`Node >= 22.5.0`). If the server provides Node `18` or `20`, top-level `require('node:sqlite')` would fail at startup. | **`UNVERIFIED`** | **Mitigation:** Phase 03 decouples production boot from `node:sqlite` by using pure-JS `mysql2/promise` (supports Node `>= 18.18 LTS`, `20 LTS`, and `22 LTS`) and only lazy-loading `node:sqlite` in local Node 22 test runs.<br>**Owner/SSH Check:** Run `node -v` and check available versions in cPanel **Setup Node.js App** (or `ls /opt/alt/alt-nodejs*/root/usr/bin/node`). |
| **U-02** | **Exact MySQL / MariaDB Server Version** (`MySQL 5.7` vs `MySQL 8.0+` vs `MariaDB 10.3–10.11`) | Expression defaults (`DEFAULT (CURRENT_DATE)`), enforced `CHECK` constraints, `JSON` defaults, and `CTE`/window features differ across MySQL `5.7`, MySQL `8.0`, and MariaDB `10.x`. | **`UNVERIFIED`** | **Mitigation:** `docs/MYSQL_MIGRATION_PLAN.md` uses portable `InnoDB` + `utf8mb4_unicode_ci` DDL (`BIGINT`, `VARCHAR`, `LONGTEXT`, `DATETIME DEFAULT CURRENT_TIMESTAMP`) compatible with **MySQL 5.7+, MySQL 8.0+, and MariaDB 10.3+**.<br>**Owner/SSH Check:** Run `mysql --version` or `SELECT VERSION();` in phpMyAdmin/MySQL CLI. |
| **U-03** | **Application Process Manager & Startup Mechanism** | Shared CloudLinux cPanel typically uses **Phusion Passenger / LiteSpeed `lsnode`** (`Setup Node.js App` + `app.js`), which manages port binding automatically and kills unauthorized background daemons (`pm2`/`nohup`). | **`UNVERIFIED`** | **Mitigation:** Repository includes both `app.js` (Passenger/`lsnode` entry) and `server.js` (standalone HTTP entry honoring `process.env.PORT`).<br>**Owner Check:** Confirm whether cPanel **Software → Setup Node.js App** manages the app lifecycle. |
| **U-04** | **Persistent Upload Directory & Symlink Rules** | Uploaded product/banner/complaint files inside an app release folder can be overwritten during clean deployments if not stored in a persistent path outside the release directory. | **`UNVERIFIED`** | **Mitigation:** `UPLOAD_DIR` is environment-configurable (`src/config/env.js`), allowing storage in `/home/<user>/mrtumi_storage/uploads` symlinked or served safely.<br>**Owner/SSH Check:** Verify symlink & read/write permissions inside the cPanel home directory prior to Phase 05/06 media rollout. |
| **U-05** | **Cron Job Availability & Minimum Frequency** | Passenger suspends idle Node.js web processes when traffic is quiet, pausing in-memory `setInterval` timers (affecting SMS retries, OTP expiry cleanup, and courier status sync). | **`UNVERIFIED`** | **Mitigation:** Design scheduled tasks as idempotent CLI jobs (`scripts/cron-runner.js`) triggered by **cPanel → Cron Jobs** rather than relying on in-memory timers.<br>**Owner Check:** Confirm **Cron Jobs** icon in cPanel and minimum allowed interval (e.g., `*/5 * * * *`). |
| **U-06** | **CloudLinux LVE Resource & Inode Quotas** | RAM (`1–4 GB`), Entry Processes (`20–50`), Max Processes (`NPROC 100–150`), I/O, and Inode caps (`100k–500k`) govern MySQL connection pool size and npm install behavior. | **`UNVERIFIED`** | **Mitigation:** Keep dependencies lean (avoid bloated frontend build trees) and default `DB_CONNECTION_LIMIT=10` so MySQL `max_user_connections` is never exhausted.<br>**Owner Check:** Inspect cPanel right-hand **Statistics** panel (RAM, Entry Processes, NPROC, Inodes). |
| **U-07** | **Outbound API Egress & SMTP Ports** | Server must make outbound HTTPS (`443`) requests to Steadfast, Pathao, RedX, bKash, ShurjoPay, UddoktaPay, BDCourier, BulkSMSBD, and Meta CAPI, plus SMTP (`465`/`587`). | **`UNVERIFIED`** | **Mitigation:** Phase 10–13 & 18 include admin connectivity self-tests that report exact HTTP/TLS/port failures honestly.<br>**Owner/SSH Check:** Test `curl -I https://portal.packzy.com` via SSH during staging setup. |
| **U-08** | **Host Backup Schedule & MySQL Point-in-Time Recovery** | Provider-level weekly/daily backups may not match e-commerce RPO requirements for orders and financial ledgers. | **`UNVERIFIED`** | **Mitigation:** Implement our own scheduled `mysqldump` + uploads archive script (`scripts/backup.sh` in Phase 20) alongside cPanel backups. |

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
