# SYSTEM ARCHITECTURE & DEPLOYMENT BLUEPRINT
**Project:** Mr. Tumi Grocery & Gift  
**Document Status:** **PROVISIONAL** — Conditional on BestWebHostBD Package Verification (`docs/CPANEL_COMPATIBILITY.md`)  
**Last Updated:** 2026-10-25 (`Asia/Dhaka`)  

---

## 1. Existing Workspace Baseline Evaluation

Before proposing any architectural changes, the existing repository at `/home/user/Mrtumi` (branch `arena/8689c974-mrtumi`) was audited:

### 1.1 What the Current Project Uses
- **Runtime & Framework:** Node.js (`v22.22.3` in dev sandbox) + **Express `^4.21.1`** HTTP server (`server.js` + Passenger-compatible `app.js`).
- **View Engine & UI:** Server-rendered **EJS `^3.1.10`** (`48` templates across `views/store/`, `views/admin/`, `views/vendor/`, `views/reseller/`) + Bootstrap 5 + vanilla JS (`public/frontEnd/`, `public/backEnd/`).
- **Database Layer (Prototype):** Native `node:sqlite` (`DatabaseSync` in `src/db/database.js`), WAL journal mode, foreign keys enabled.
- **Dependencies:** Minimal footprint (`5` production packages: `express`, `ejs`, `bcryptjs`, `express-session`, `multer`) — low memory (~`65–95 MB` RSS) and tiny `node_modules` inode count (~`1,100` files, `<1.5%` of a 100k CloudLinux inode quota).

### 1.2 Strengths Worth Preserving
1. **Modular Monolith Structure:** Clean server-rendered architecture with zero separate SPA build/CORS complexity and fast TTFB on Bangladesh mobile networks.
2. **Low Resource Footprint:** Ideal for CloudLinux LVE limits (`1–2 GB RAM`, `100 NPROC`, `100k+ inodes`) compared to Next.js/Nuxt or microservices.
3. **Working 4-Portal Baseline:** Storefront, Admin Dashboard, Vendor Portal, and Reseller Portal routes and templates already exist and compile cleanly.

### 1.3 Baseline Weaknesses Requiring Phase 03+ Remediation
1. **Hard Coupling to `node:sqlite` (Node `>= 22.5.0`):** Fails immediately if BestWebHostBD's cPanel `Setup Node.js App` offers Node `18` or `20` instead of `22`.
2. **Single-File SQLite Risks on Shared cPanel:** Vulnerable to multi-process Passenger `SQLITE_BUSY` contention and un-checkpointed cPanel file backups.
3. **Data Integrity & Security Gaps (Scheduled for Phase 03–09):** Needs versioned reversible SQL migrations, integer minor-unit (`paisa`) money columns, CSRF protection, rate limiting, granular RBAC middleware, immutable `stock_ledger`, and `audit_logs`.

---

## 2. Conditional Architecture Recommendation & Alternatives Comparison

Because the owner's exact BestWebHostBD package is currently **`UNVERIFIED`**, the architecture decision is kept **provisional** across two decision branches:

### Branch 1 — Recommended Primary Architecture (If BestWebHostBD Account Supports Node.js `18` / `20` / `22`, OR Owner Upgrades to a Node-Enabled Plan / VPS)
**Architecture:** **Hardened Express + EJS Modular Monolith + Dual-Engine Relational Data Layer (`MySQL/MariaDB` in Production, `SQLite` in Local Dev/CI)**
- **How it works:**
  - Preserves 100% of `server.js`, `app.js`, route structure, and all 48 EJS templates (zero costly rewrite).
  - In **Phase 03**, introduces a clean database adapter (`src/db/adapter.js`) supporting **pure-JS `mysql2/promise`** for BestWebHostBD's managed **MySQL / MariaDB (`InnoDB`)** in production AND `node:sqlite` for zero-daemon local/CI automated tests.
  - Because `mysql2` has **zero C++ native addons**, it installs cleanly inside CloudLinux CageFS and runs on **Node 18 LTS, Node 20 LTS, and Node 22 LTS**!
  - Uses `app.js` for Phusion Passenger / LiteSpeed `lsnode` startup, stores runtime uploads outside repo swap (`storage/uploads` symlinked to `public/uploads/custom`), and executes scheduled tasks via a stateless cPanel Cron command (`node scripts/cron-runner.js`).

### Branch 2 — Alternatives & Honest Trade-Off Matrix (If Current Purchased Package Lacks Node.js)

If the owner's purchased BestWebHostBD plan is one of the PHP-only shared tiers (e.g., `Web Hosting Basic/Plus/Business` or lower `BDIX` tier without `Setup Node.js App`), **the Node.js app cannot run on that package as-is**. Three legitimate options exist:

| Option | Description | Migration / Engineering Cost | Hosting Cost Impact | Reliability & Maintenance Trade-Offs |
|---|---|---|---|---|
| **Option A (Recommended if on PHP-only cPanel): Plan Upgrade within BestWebHostBD** | Upgrade existing BestWebHostBD service via WHMCS (`my.bestwebhostbd.com`) to a Node-enabled tier (`Alfa Pro ৳3,000/yr`, `BDIX Business ৳4,999/yr`, or `Turbo Lite`) | **Zero rewrite cost.** Preserves 100% of existing Express + EJS codebase and Phase 01–02 work. | Low (~`৳800–৳3,000/yr` difference depending on current tier) | Runs inside familiar cPanel with managed MySQL, SSL, and automated backups; still subject to shared CloudLinux LVE limits & Passenger idle timeouts (mitigated via MySQL + cPanel Cron). |
| **Option B (Best Long-Term Scale): BestWebHostBD VPS or Cloud VM** | Deploy Express + Node 22 LTS + MySQL/PostgreSQL + Nginx + PM2/systemd on `BestWebHostBD VPS1 (৳2,500/mo)` or equivalent Linux VPS | **Zero rewrite cost.** Full control over Node 22 LTS, background workers, and firewall egress. | Moderate (`৳2,500/mo` on BestWebHostBD VPS1) | Highest performance, zero Passenger idle sleep, zero inode throttling, true persistent background workers; requires Linux OS security updates & automated off-site backup cron. |
| **Option C (Only if Owner Strictly Requires PHP-Only Shared Hosting): Approved Migration to PHP 8.2/8.3 + Laravel + MySQL** | Re-implement backend in **PHP 8.2+ / Laravel 11 + Blade + MySQL**, keeping Phase 01 requirements & UI design | **High migration cost.** Requires porting `server.js`, all 9 route modules, session/auth middleware, and all `48` `.ejs` templates to `.blade.php`. | **Zero** additional hosting fee (runs natively on every `৳1,699/yr+` BestWebHostBD shared plan) | First-class native execution on LiteSpeed (`lsphp`) + cPanel MySQL + cPanel Cron (`artisan schedule:run`) with zero Node version/Passenger friction; delays Phase 03–05 while baseline views/controllers are ported. **Will NOT be started without explicit owner approval.** |

---

## 3. Database Engine Technical Evaluation (`SQLite` vs `MySQL/MariaDB` vs `PostgreSQL`)

Per Phase 02 Step 2, database selection for an e-commerce platform handling **BDT money ledgers, stock reservations, multi-portal concurrent checkouts (Storefront + POS + Reseller + Vendor), and webhook callbacks** must be evaluated on engineering merit—never mere dev convenience:

| Criterion | SQLite (`WAL` Mode) | MySQL 8 / MariaDB 10.6+ (`InnoDB`) | PostgreSQL 15+ |
|---|---|---|---|
| **BestWebHostBD Availability** | File-based (`UNVERIFIED` under Passenger CageFS) | **Included on ALL BestWebHostBD cPanel plans** (`5` to `Unlimited` DBs + phpMyAdmin) | **Not advertised** on BestWebHostBD shared/cPanel plans (VPS only) |
| **Multi-Process Write Concurrency** | **Single-writer lock** per DB file. Under multi-worker Passenger (`20–50` Entry Processes), concurrent checkouts + courier webhooks risk `SQLITE_BUSY` timeouts | **Row-level locking (`InnoDB`)** + `SELECT ... FOR UPDATE` handles concurrent checkout, stock deduction, and webhook updates safely across workers | Excellent MVCC + row-level locking + `SERIALIZABLE` / advisory locks (requires VPS) |
| **Financial & Stock Atomic Integrity** | Supports `BEGIN IMMEDIATE` ACID transactions, weak dynamic column affinity unless `STRICT` tables enforced | Strict `BIGINT` (`paisa` minor units) / `DECIMAL(14,2)`, `FOREIGN KEY` constraints, atomic `START TRANSACTION ... COMMIT/ROLLBACK` | Strongest native constraints (`CHECK`, `NUMERIC`, transactional DDL) |
| **Backup & Restore Safety on cPanel** | **High risk if naive:** cPanel weekly file copy during active writes without WAL checkpoint / `VACUUM INTO` can capture inconsistent `.db` + `.db-wal` state | **Native cPanel integration:** JetBackup / `pkgacct` dumps consistent `mysqldump` snapshots automatically; easy point-in-time SQL export | `pg_dump` / WAL archiving (self-managed on VPS) |
| **Node.js Driver Compatibility** | `node:sqlite` requires **Node `>= 22.5`**; `better-sqlite3` requires C++ `node-gyp` build (often fails on shared CloudLinux) | **`mysql2` is 100% pure JavaScript** — zero C++ compilation, works on Node `18`, `20`, and `22` | `pg` is pure JavaScript (works on Node `18+`, requires PostgreSQL server) |

**Database Recommendation:**
- **Production (BestWebHostBD cPanel or VPS):** **MySQL / MariaDB (`InnoDB`)** with `BIGINT` minor units (`paisa`, `1 BDT = 100 paisa`) + strict foreign keys + row-locked transactions. *(PostgreSQL is equally suitable if owner selects a VPS instead of cPanel.)*
- **Local Sandbox & CI Automated Tests:** Support **SQLite (`WAL` + `STRICT` / foreign keys)** through the same repository/query interface in Phase 03 so automated tests and Arena Live Preview run deterministically with zero external daemon setup.

---

## 4. Target Modular Monolith Project Structure & Conventions

```text
/home/user/Mrtumi/
├── app.js                         # cPanel Passenger / LiteSpeed lsnode startup entry
├── server.js                      # Express application bootstrap & standalone HTTP entry
├── package.json                   # Runtime metadata, scripts (start, dev, lint, test, verify)
├── .env.example                   # Safe placeholder template (NEVER commit .env)
├── .gitignore                     # Excludes .env, *.db*, node_modules, runtime uploads, keys
├── .github/
│   └── workflows/
│       └── ci.yml                 # Automated lint, template compile, secret scan & test suite
├── docs/
│   ├── PHASE_01_REFERENCE_AUDIT.md
│   ├── ARCHITECTURE.md            # This architecture & conventions blueprint
│   └── CPANEL_COMPATIBILITY.md    # BestWebHostBD verification matrix
├── scripts/
│   └── check-foundation.js        # Syntax, EJS compilation, governance & secret scanner
├── src/
│   ├── config/
│   │   └── env.js                 # Validated dev/test/prod config (Asia/Dhaka, BDT, bn/en)
│   ├── db/                        # Database connection, Phase 03 migrations & transaction helpers
│   ├── middleware/                # Session, auth/RBAC, CSRF (P03), rate-limit (P03), upload
│   ├── routes/                    # Portal HTTP routers (Storefront, Admin, Vendor, Reseller)
│   ├── modules/                   # Domain services added across Phases 03–18 (orders, stock, otp, pos...)
│   ├── integrations/              # Provider adapters (Phases 10–14: couriers, payments, sms, fraud, capi)
│   └── i18n/                      # Bangla (bn) & English (en) locale dictionaries (Phase 04)
├── views/
│   ├── store/                     # Customer storefront EJS templates
│   ├── admin/                     # Reference-inspired Admin Panel EJS templates
│   ├── vendor/                    # Isolated Multivendor portal EJS templates
│   └── reseller/                  # Isolated Reseller portal EJS templates
├── public/
│   ├── frontEnd/                  # Storefront CSS & JS
│   ├── backEnd/                   # Admin CSS & JS
│   └── uploads/                   # Static brand defaults + gitignored custom/ runtime uploads
└── tests/
    └── phase02-foundation.test.js # Automated Node test runner suite (expanded every phase)
```

### Coding & Security Conventions
1. **CommonJS (`'use strict'`)** across backend modules for immediate compatibility with Node `18/20/22` and Passenger `app.js` loaders without ESM loader flags.
2. **Money Arithmetic (Enforced from Phase 03+):** Integer minor units (`paisa`, `৳1 = 100 paisa`); browser-submitted prices/subtotals/discounts are **never** trusted.
3. **Time & Locale:** Server stores UTC ISO-8601 / epoch timestamps; UI formats timestamps explicitly in `Asia/Dhaka` (`UTC+06:00`) with Bangla (`bn`, default) and English (`en`) toggle.
4. **External Providers:** Every courier, payment, fraud, and SMS integration implements an explicit adapter contract returning `NOT_CONFIGURED` when credentials are blank—never fabricated live balances or fake tracking IDs.
5. **Secrets Policy:** Zero passwords, API tokens, `.env` files, private keys, or `.db` dumps in Git; verified automatically on every commit/CI run via `npm run lint`.

---

## 5. Testing, CI & GitHub Workflow Strategy

### 5.1 Automated Verification Layers
1. **Static & Security Gate (`npm run lint` → `node scripts/check-foundation.js`):**
   - Runs `node --check` across every `.js` file.
   - Compiles all `48` `.ejs` templates via `ejs.compile` to catch broken tags before runtime.
   - Scans `git ls-files` to guarantee zero `.env`, `.db`, keystores, API tokens, or hardcoded demo passwords are tracked.
   - Verifies all governance markdowns use only the 7 permitted status labels.
2. **Automated Test Suite (`npm test` → `NODE_ENV=test node --test tests/*.test.js`):**
   - Uses Node's built-in `node:test` + `node:assert/strict` against an isolated ephemeral test database (`data/mrtumi.test.db`, cleaned up automatically).
   - Expanded in every phase (Phase 03: migrations, rollback, transactions, money math; Phase 06: stock ledger; Phase 07–08: checkout, OTP, advance payment; Phase 09: RBAC; Phase 10–13: mocked provider contract & webhook tests).
3. **GitHub Actions CI (`.github/workflows/ci.yml`):**
   - Triggers on `push` and `pull_request` across active branches.
   - Runs `npm ci`, `npm run lint`, and `npm test` on Ubuntu (`Node 22.x`).

### 5.2 GitHub Branch & Commit Discipline
- **Active Session Branch:** `arena/8689c974-mrtumi` (remote: `https://github.com/mrtumi2026/Mrtumi.git`).
- **Commit Format:** Conventional commits (`docs(phase-01): ...`, `chore(phase-02): ...`, `feat(phase-03): ...`, `fix(security): ...`).
- **Pre-Commit Checklist:** Run `npm run verify` → inspect `git status` and `git diff --cached` → verify zero secrets/binaries/dumps → commit → `git push origin arena/8689c974-mrtumi` (never `--force`).

---

## 6. cPanel Deployment Feasibility Plan (BestWebHostBD)

Once the owner confirms a Node-enabled BestWebHostBD cPanel plan (or upgrades to `Alfa` / `BDIX Business` / `Turbo`):

1. **Database Provisioning:** Create MySQL database + restricted user in **cPanel → MySQL® Databases** (`ALL PRIVILEGES` on `cpaneluser_mrtumi` only).
2. **Persistent Storage Outside Repo Directory:** Create `/home/<cpaneluser>/mrtumi_storage/uploads` so product/banner images survive `git pull` releases; symlink into `public/uploads/custom`.
3. **Application Registration:** In **cPanel → Setup Node.js App**:
   - Application mode: `Production`
   - Application root: `mrtumi` (outside `public_html` so `.git` and `src/` are never web-exposed!)
   - Application URL: `mrtumi.com` (Passenger proxies HTTPS `443` traffic cleanly)
   - Application startup file: `app.js`
   - Environment variables: Set `NODE_ENV=production`, `SESSION_SECRET`, `CSRF_SECRET`, `DB_CLIENT=mysql`, `DB_HOST=127.0.0.1`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `TZ=Asia/Dhaka`, `DEFAULT_LOCALE=bn`.
4. **Dependency Install & Migrations:** Click **Run NPM Install** (or via cPanel Terminal: `source ~/nodevenv/mrtumi/<ver>/bin/activate && npm ci --omit=dev && npm run migrate`).
5. **Cron Worker Registration:** Add cPanel Cron (`*/5 * * * *`) invoking the virtualenv Node binary on `scripts/cron-runner.js` so SMS retries, OTP expiry, and courier status sync run reliably even when Passenger idles web workers.
