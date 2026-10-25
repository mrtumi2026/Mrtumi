# DEPLOYMENT & HOSTING FEASIBILITY PLAN — Mr. Tumi Grocery & Gift

**Hosting Provider:** BestWebHostBD (`bestwebhostbd.com` / `my.bestwebhostbd.com`)  
**Purchased Package Status:** `UNVERIFIED` (`OWNER APPROVAL REQUIRED` — see [`docs/CPANEL_COMPATIBILITY.md`](docs/CPANEL_COMPATIBILITY.md))  
**Production Deployment Gate:** **DO NOT DEPLOY** until Phase 20 QA, backup/restore verification, and explicit owner sign-off.

---

## 1. Deployment Feasibility Summary by BestWebHostBD Tier

1. **If Purchased Plan Supports Node.js (`Alfa Pro/Plus/Swift/Business`, `Turbo Lite/Power/Plus/Advance`, `USA Webhost`, or `BDIX Business` with `Setup Node.js App`):**
   - Deploy the Express + EJS Modular Monolith via **cPanel → Setup Node.js App** using startup file `app.js` and **MySQL / MariaDB (`InnoDB`)** as the production database.
2. **If Purchased Plan Is PHP-Only Shared Hosting (`Web Hosting Basic/Plus/Business` or lower `BDIX` without Node.js):**
   - **Recommended:** Upgrade within BestWebHostBD (`my.bestwebhostbd.com`) to a Node-enabled plan (`Alfa Pro` / `BDIX Business` / `Turbo Lite`) OR a BestWebHostBD `VPS`.
   - **Alternative:** Only if the owner explicitly chooses to stay on PHP-only shared hosting, approve a dedicated framework migration to PHP 8.2+/Laravel + MySQL before Phase 03 begins (`docs/ARCHITECTURE.md` §2).

---

## 2. Planned BestWebHostBD cPanel Passenger Deployment Topology

```text
/home/<cpanel_user>/
├── mrtumi_app/                    # Git checkout OUTSIDE public_html (protects .git, src/, views/)
│   ├── app.js                     # Passenger / LiteSpeed lsnode startup file
│   ├── server.js
│   ├── package.json
│   └── public/
│       └── uploads/
│           └── custom -> /home/<cpanel_user>/mrtumi_storage/uploads
├── mrtumi_storage/                # Persistent directory surviving git releases
│   ├── uploads/
│   └── backups/
└── nodevenv/mrtumi_app/<ver>/     # CloudLinux managed Node virtual environment
```

### Key Production Safeguards
- **Never Clone Inside `public_html`:** Keeps `src/`, `views/`, `package.json`, and `.git` inaccessible from direct static HTTP requests; Passenger proxies public web traffic cleanly to `app.js`.
- **Database Integrity:** Production writes go to cPanel **MySQL (`InnoDB`)** over `127.0.0.1:3306` rather than a local SQLite file, avoiding Passenger multi-worker file-lock contention and ensuring clean cPanel `mysqldump` backups.
- **Stateless Cron Execution:** Because shared cPanel Passenger sleeps idle Node processes, scheduled jobs (SMS retries, OTP cleanup, courier sync) will run via **cPanel → Cron Jobs** (`*/5 * * * *`) invoking a dedicated CLI task script (`scripts/cron-runner.js`, added in Phase 03/10/13).
- **Secrets Management:** Set `SESSION_SECRET`, `CSRF_SECRET`, `DB_*`, and provider API keys exclusively in cPanel's NodeJS environment variables or server-only `.env` (`chmod 600 .env`).
