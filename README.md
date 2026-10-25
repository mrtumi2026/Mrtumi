# Mr. Tumi Grocery & Gift

Bilingual (**Bangla `bn` + English `en`**) e-commerce, wholesale, multivendor, reseller, and POS platform engineered for Bangladesh (`BDT / ৳`, `Asia/Dhaka`).

> **Current Phase:** **PHASE 02 — FINAL ARCHITECTURE AND GITHUB FOUNDATION** (`TESTED AND PASSED`; awaiting explicit owner approval to start **Phase 03 — Database, Backend and API Foundation**).

---

## 1. Documentation & Governance Index

| Document | Purpose |
|---|---|
| [`PROJECT_STATUS.md`](PROJECT_STATUS.md) | 20-Phase master execution tracker & current phase gate |
| [`MASTER_CHECKLIST.md`](MASTER_CHECKLIST.md) | Granular feature & module status inventory |
| [`DECISIONS.md`](DECISIONS.md) | Finalized architecture & owner-approved business rules (`ADR-001`–`ADR-009`) |
| [`INTEGRATION_STATUS.md`](INTEGRATION_STATUS.md) | Honest third-party courier, payment, fraud, SMS & pixel status ledger |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | BestWebHostBD SSH + cPanel + MySQL deployment prerequisites & runbook |
| [`docs/PHASE_01_REFERENCE_AUDIT.md`](docs/PHASE_01_REFERENCE_AUDIT.md) | Reference audit, 43-item sidebar inventory, 9-band dashboard spec & requirements |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Finalized Node.js + Express + EJS + Production MySQL architecture |
| [`docs/CPANEL_COMPATIBILITY.md`](docs/CPANEL_COMPATIBILITY.md) | Confirmed vs `UNVERIFIED` BestWebHostBD capabilities & SSH check commands |
| [`docs/MYSQL_MIGRATION_PLAN.md`](docs/MYSQL_MIGRATION_PLAN.md) | SQLite-to-MySQL DDL, `paisa` money math, transactions, backup & rollback plan |

---

## 2. Architecture & Hosting Summary

- **Application Stack:** **Node.js + Express + EJS Modular Monolith** across 4 portals (`Storefront`, `Admin`, `Vendor`, `Reseller`).
- **Confirmed BestWebHostBD Hosting Capabilities (Owner-Provided):**
  1. **Node.js applications are supported.**
  2. **SSH access is available.**
  3. **MySQL is the only supported database** (**MySQL `InnoDB` `utf8mb4` is locked as the production database**; SQLite is blocked in `NODE_ENV=production`).
- **Unresolved Server Version Questions (`UNVERIFIED` until checked via SSH):** Exact Node.js version (`18`/`20`/`22`), exact MySQL/MariaDB version (`5.7`/`8.0`/`10.x`), Passenger/process manager startup config, persistent upload path outside release folder, cron interval limit, LVE/inode quotas, and outbound API/SMTP firewall rules (`docs/CPANEL_COMPATIBILITY.md` §1.2).

---

## 3. Local Setup, Environment & Database Configuration

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Configure `.env` from template (never committed to Git):**
   ```bash
   cp .env.example .env
   ```
   - Set `SESSION_SECRET` and `CSRF_SECRET` (minimum 32 random characters).
   - **Production (`NODE_ENV=production`):** Requires `DB_CLIENT=mysql` (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
   - **Local Dev / Sandbox Transition (Pre-Phase 03 Cutover):** Preserves existing prototype baseline cleanly (`DB_CLIENT=sqlite` when local `mysqld` is absent); Phase 03 introduces `mysql2/promise` connection pooling and versioned reversible MySQL migrations (`src/db/migrations/`).
3. **Start local development server:**
   ```bash
   npm run dev
   ```
   Listens on `http://0.0.0.0:3000` (`/` Storefront, `/admin/login` Admin, `/vendor/login` Vendor, `/reseller/login` Reseller).

---

## 4. Verification, Tests & Git Workflow

```bash
# Static syntax check, 48-template EJS compile, governance check & secret scan
npm run lint

# Automated test suite (env validation, production SQLite block, HTTP boot checks)
npm test

# Full pre-commit verification gate
npm run verify
```

- **Git Workflow:** Develop on `arena/8689c974-mrtumi` → run `npm run verify` → inspect `git diff --cached` → make descriptive conventional commits → push verified changes to `origin/arena/8689c974-mrtumi` (never force-push; never commit `.env`, secrets, or `.db`/`.sql` dumps).
