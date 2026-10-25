# DEPLOYMENT & HOSTING PREREQUISITES — Mr. Tumi Grocery & Gift

**Hosting Provider:** BestWebHostBD  
**Confirmed Hosting Capabilities (Owner-Provided):** `Node.js Supported` | `SSH Available` | `MySQL Only`  
**Production Deployment Gate:** **DO NOT DEPLOY** until Phase 20 QA, backup/restore drill, and explicit owner authorization.

---

## 1. Pre-Deployment Verification Checklist (BestWebHostBD SSH & cPanel)

Before staging/production deployment, confirm the remaining `UNVERIFIED` server parameters (`docs/CPANEL_COMPATIBILITY.md` §1.2):

1. **Node.js Runtime Version (`U-01`):** Verify `node -v` / cPanel **Setup Node.js App** offers Node `18.18+`, `20.x`, or `22.x` LTS.
2. **MySQL Server Version (`U-02`):** Verify `SELECT VERSION();` (`MySQL 5.7+` / `MySQL 8.0+` / `MariaDB 10.3+`) and confirm `InnoDB` + `utf8mb4` support.
3. **Process Manager (`U-03`):** Confirm cPanel **Setup Node.js App** startup file (`app.js`) and graceful restart via `touch tmp/restart.txt`.
4. **Persistent Storage (`U-04`):** Create `/home/<cpanel_user>/mrtumi_storage/{uploads,backups}` outside the Git checkout directory and verify `UPLOAD_DIR` write permissions.
5. **Cron Worker (`U-05`):** Confirm **cPanel → Cron Jobs** permits `*/5 * * * *` execution for `scripts/cron-runner.js`.
6. **LVE Quotas (`U-06`):** Check RAM, Entry Processes, NPROC, and Inode ceiling; size `DB_CONNECTION_LIMIT` accordingly (default `10`).
7. **Outbound Egress (`U-07`):** Confirm outbound `443` HTTPS to courier/payment/fraud/SMS APIs and SMTP `465`/`587`.

---

## 2. Planned BestWebHostBD Directory & Release Layout

```text
/home/<cpanel_user>/
├── mrtumi_app/                    # Git repository checkout (NEVER inside public_html)
│   ├── app.js                     # Passenger / LiteSpeed lsnode entry point
│   ├── server.js                  # Express bootstrap
│   ├── .env                       # Server-only secrets (chmod 600, untracked)
│   └── tmp/restart.txt            # Passenger graceful reload trigger
├── mrtumi_storage/                # Persistent data surviving Git updates
│   ├── uploads/                   # Product, banner & support media
│   └── backups/                   # Pre-migration & daily mysqldump archives
└── nodevenv/mrtumi_app/<ver>/     # CloudLinux Node virtual environment
```

---

## 3. Release & Rollback Summary (Detailed in `docs/MYSQL_MIGRATION_PLAN.md` §7)

1. **Pre-Release Snapshot:** Run `mysqldump --single-transaction --quick --default-character-set=utf8mb4` to `~/mrtumi_storage/backups/`.
2. **Code & Dependencies:** `git fetch origin && git checkout <verified-commit>` → `npm ci --omit=dev`.
3. **Schema Migration:** `npm run migrate:up` (checksum-verified, MySQL advisory-locked).
4. **Reload & Smoke Test:** `touch tmp/restart.txt` → verify `/health` HTTP `200` and MySQL readiness.
5. **Rollback if Needed:** `npm run migrate:down` (or full snapshot restore from `.sql.gz`) → checkout prior verified commit → `touch tmp/restart.txt`.
