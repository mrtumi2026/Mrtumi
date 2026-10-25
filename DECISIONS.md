# ARCHITECTURAL & BUSINESS DECISIONS LOG — Mr. Tumi Grocery & Gift

**Last Updated:** 2026-10-25 (`Asia/Dhaka`)

---

## 1. Provisional Architecture Gate (`OWNER APPROVAL REQUIRED`)

| ID | Topic | Provisional Recommendation & Unverified Dependencies | Status |
|---|---|---|---|
| **ADR-001** | **Target Hosting (`BestWebHostBD`), Runtime & Production Database** | **Provisional Recommendation:** Harden the existing **Express + EJS Modular Monolith** with **MySQL / MariaDB (`InnoDB` via pure-JS `mysql2`)** for production on BestWebHostBD and **SQLite (`WAL`)** for local/CI tests (`docs/ARCHITECTURE.md`).<br>**Why Provisional (`UNVERIFIED`):** BestWebHostBD disables Node.js on `Web Hosting Basic/Plus/Business` and lists `NO` on lower `BDIX` spec tables while enabling Node.js on `Alfa`, `Turbo`, `USA`, `BDIX Business`, and `VPS` (`docs/CPANEL_COMPATIBILITY.md`). Furthermore, current prototype uses `node:sqlite` (`Node >= 22.5`), whereas cPanel CloudLinux may offer Node `18` or `20`.<br>**Owner Decision Needed:** Confirm exact BestWebHostBD package + whether `Setup Node.js App` (and which Node versions) + `MySQL Databases` exist, OR choose between BestWebHostBD plan upgrade / VPS / separately approved PHP+Laravel migration. | `OWNER APPROVAL REQUIRED` |

---

## 2. Owner-Approved Business & Engineering Decisions

| ID | Topic | Approved Decision | Status |
|---|---|---|---|
| **ADR-002** | **Branding & Default Language** | Default language is **Bangla (`bn`)** with **English (`en`)** toggle (`src/config/env.js` implemented). Preserve and use owner's existing **Mr. Tumi** brand assets when provided (note: no Mr. Tumi logo files were present in `/home/user/Mrtumi` or `/tmp/arena-coding-uploads/` during Phase 02 audit; owner may upload existing brand assets before/during Phase 04, otherwise clean original Mr. Tumi vector branding will be created). | `IMPLEMENTED` |
| **ADR-003** | **GitHub Push Policy** | Authorized to commit and push verified, secret-scanned project changes on active branch `arena/8689c974-mrtumi` (`origin`: `https://github.com/mrtumi2026/Mrtumi.git`). Never force-push, never commit secrets/dumps, and never deploy to production without explicit owner sign-off. | `IMPLEMENTED` |
| **ADR-004** | **Money Representation & Server-Side Math** | Store monetary values in integer minor units (`paisa`, `৳1.00 = 100 paisa`) from Phase 03 onward; calculate 100% of subtotals, discounts, shipping, advance payments, and COD balances server-side inside ACID transactions. | `IMPLEMENTED` |
| **ADR-005** | **Order OTP & Advance Payment Rules** | Both **Order OTP** and **Advance Payment** are configurable through Admin Settings (`OFF`, `ALL_COD`, `OUTSIDE_DHAKA_OR_HIGH_VALUE` for OTP; `OFF`, `SHIPPING_FEE_ONLY`, `FIXED_AMOUNT`, `PERCENTAGE` for Advance Payment; scheduled for Phase 08). | `IMPLEMENTED` |
| **ADR-006** | **Inventory Ownership Across Warehouse, Reseller & Multivendor** | **In-house & Reseller orders** draw from Mr. Tumi warehouse stock (`stock_ledger`), crediting reseller margin on `Completed` and reversing on return/cancel. **Vendor products** maintain separately tracked vendor stock, subject to Admin product approval and commission rules (scheduled for Phase 06 & Phase 16). | `IMPLEMENTED` |
| **ADR-007** | **CGNAT-Safe Fraud & IP Restriction Policy** | Combine phone/account velocity, TTL cooldowns, OTP step-up, and manual review queue so shared Bangladesh mobile carrier CGNAT IPs are never blindly auto-rejected; require Admin audit reason for permanent blocks (scheduled for Phase 12). | `IMPLEMENTED` |
| **ADR-008** | **HRM Payroll Scope** | Configurable SME monthly salary calculation (`Basic + Allowance/Bonus − Leave/Advance Deduction = Net Payable`) requiring explicit Admin approval before recording payout (scheduled for Phase 17). | `IMPLEMENTED` |
