# ARCHITECTURAL & BUSINESS DECISIONS LOG — Mr. Tumi Grocery & Gift

Every ambiguous technical or business rule is recorded here with its current status (`OWNER APPROVAL REQUIRED` or `IMPLEMENTED`) and proposed safe default per **Fundamental Rule 23**.

---

## Open Decisions Requiring Owner Review (End of Phase 01)

| ID | Topic | Proposed Safe Default | Status |
|---|---|---|---|
| **ADR-001** | **Target Hosting & Backend Stack** | Modular Monolith in **Node.js 22 + Express + SQLite (WAL) / PostgreSQL-compatible SQL layer + EJS + Bootstrap 5** (preserving & hardening the existing `/home/user/Mrtumi` codebase). *If owner's hosting is cPanel PHP/MySQL-only without Node.js support, owner will notify before Phase 02.* | `OWNER APPROVAL REQUIRED` |
| **ADR-002** | **Mr. Tumi Branding & Default Language** | Original **Mr. Tumi Grocery & Gift** branding (emerald-green `#1b4332` + warm gift-gold `#d97706`), default language **Bangla (`bn`)** with header/admin toggle to **English (`en`)**, currency `BDT` (`৳`), display timezone `Asia/Dhaka`. | `OWNER APPROVAL REQUIRED` |
| **ADR-003** | **GitHub Push Policy** | Local git commits after verified phase checks; `git push origin arena/8689c974-mrtumi` executed **only** after explicit owner authorization. | `OWNER APPROVAL REQUIRED` |
| **ADR-004** | **Money Representation** | Store all monetary values as integer minor units (`paisa`, where `৳1.00 = 100 paisa`) or exact integer BDT + paisa columns; perform 100% of subtotal, discount, tax, shipping, advance-payment, and COD-balance math server-side inside transactions. | `OWNER APPROVAL REQUIRED` |
| **ADR-005** | **Order OTP & Advance Payment Rules** | Both **Order OTP** and **Advance Payment** are admin-configurable in DB settings: OTP supports `OFF`, `ALL_COD`, or `OUTSIDE_DHAKA_OR_HIGH_VALUE`; Advance Payment supports `OFF`, `SHIPPING_FEE_ONLY`, `FIXED_AMOUNT`, or `PERCENTAGE`. | `OWNER APPROVAL REQUIRED` |
| **ADR-006** | **Vendor / Reseller / Wholesale Inventory & Refund Rules** | **Inhouse & Reseller** orders reserve/deduct Mr. Tumi warehouse stock (`stock_ledger`); Reseller profit credits on `Completed` and reverses automatically on `Returned`/`Refunded`. **Vendor** products require Admin moderation, track vendor stock separately, and credit `(Subtotal − Commission)` on `Completed` with automatic clawback/dispute state on return. | `OWNER APPROVAL REQUIRED` |
| **ADR-007** | **CGNAT-Safe Fraud & IP Restriction Policy** | Because Bangladesh mobile networks share public IPv4 addresses across many users (CGNAT), IP rate limits default to **temporary TTL cooldowns or OTP step-up verification** rather than permanent silent auto-rejection; permanent IP blocks require explicit Admin action with audit reason. | `OWNER APPROVAL REQUIRED` |
| **ADR-008** | **HRM Payroll Calculation Scope** | Configurable Bangladesh SME monthly salary sheet (`Basic + Allowance/Bonus − Leave/Advance Deduction = Net Payable`) requiring Admin approval before recording an expense payout. | `OWNER APPROVAL REQUIRED` |
