# Mr. Tumi Grocery & Gift

Bilingual (**Bangla `bn` + English `en`**) e-commerce, wholesale, multivendor, reseller, and POS platform engineered for Bangladesh (`BDT / ৳`, `Asia/Dhaka`).

> **Current Phase:** **PHASE 02 — ARCHITECTURE AND GITHUB FOUNDATION** (`TESTED AND PASSED`; Architecture Provisional pending BestWebHostBD package confirmation — see [`docs/CPANEL_COMPATIBILITY.md`](docs/CPANEL_COMPATIBILITY.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)).

---

## 1. Documentation & Governance Index

| Document | Purpose |
|---|---|
| [`PROJECT_STATUS.md`](PROJECT_STATUS.md) | 20-Phase master execution tracker & current approval gates |
| [`MASTER_CHECKLIST.md`](MASTER_CHECKLIST.md) | Granular feature & module status inventory |
| [`DECISIONS.md`](DECISIONS.md) | Owner-approved business rules & provisional hosting ADRs |
| [`INTEGRATION_STATUS.md`](INTEGRATION_STATUS.md) | Honest third-party courier, payment, fraud, SMS & pixel status ledger |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | BestWebHostBD cPanel / VPS deployment feasibility & safety guide |
| [`docs/PHASE_01_REFERENCE_AUDIT.md`](docs/PHASE_01_REFERENCE_AUDIT.md) | Reference audit, 43-item sidebar inventory, 9-band dashboard spec & requirements |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Conditional system architecture, SQLite vs MySQL evaluation & repo conventions |
| [`docs/CPANEL_COMPATIBILITY.md`](docs/CPANEL_COMPATIBILITY.md) | BestWebHostBD product audit & zero-password owner verification checklist |

---

## 2. Runtime & Prerequisites

- **Local Development / CI Runtime:** Node.js `>= 22.5.0` (`npm >= 10`) — uses built-in `node:sqlite` and `node:test`.
- **Target Production Hosting (`BestWebHostBD`):** Provisional pending confirmation of the owner's purchased package (`Setup Node.js App` version selector & MySQL database quota). See [`docs/CPANEL_COMPATIBILITY.md`](docs/CPANEL_COMPATIBILITY.md).

---

## 3. Local Setup Instructions

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Create your local environment file (never committed to Git):**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to set `SESSION_SECRET`, `CSRF_SECRET`, and (for local development) `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (minimum 8 characters).
3. **Start the development server:**
   ```bash
   npm run dev
   ```
   The application listens on `http://0.0.0.0:3000` (configurable via `HOST` and `PORT`).
   - Storefront: `/`
   - Admin Control Panel: `/admin/login`
   - Vendor Portal: `/vendor/login`
   - Reseller Portal: `/reseller/login`

---

## 4. Verification, Linting & Automated Tests

```bash
# Run JS syntax check, 48-template EJS compiler, governance check & secret scanner
npm run lint

# Run automated integration & configuration tests against an isolated test DB
npm test

# Run full verification suite (lint + tests)
npm run verify
```

---

## 5. Security & Version Control Rules

- **Zero Secrets in Git:** `.env`, `*.db*`, private keys, Android keystores, and runtime customer uploads are excluded via `.gitignore` and enforced by `npm run lint` in GitHub Actions CI (`.github/workflows/ci.yml`).
- **Branch Discipline:** Active development runs on `arena/8689c974-mrtumi` with verified conventional commits; never force-push or commit unverified credentials.
