# Mr. Tumi Grocery & Gift — Final Acceptance Report

**Project:** Mr. Tumi Grocery & Gift (`mrtumi.com`)  
**Branch:** `antigravity/final-launch-readiness`  
**Target Environment:** BestWebHostBD cPanel (CloudLinux / Phusion Passenger / Node.js 22 / MySQL 8.0 & MariaDB 10.11)  
**Report Purpose:** Subsystem-by-subsystem acceptance verification, owner decision status, and launch gate checklist.

---

## 1. Subsystem Acceptance Matrix

| Subsystem | Scope & Functionality | Verification Level | Acceptance Disposition |
|---|---|:---:|:---:|
| **Storefront & Catalog** | Homepage, categories, search suggestions, product details, stock display, bilingual Bangla/English copy | CI & Playwright Browser E2E | **ACCEPTED (Subject to Independent Verification)** |
| **Customer Portal & Wishlist** | Account registration, profile, wishlist add/remove/view, cart, checkout, order history | CI & Unit Tests | **ACCEPTED (Subject to Independent Verification)** |
| **Admin Operations** | Dashboard, products, categories, orders, POS, inventory ledger, HR, returns, settings | CI & Playwright Browser E2E | **ACCEPTED (Subject to Independent Verification)** |
| **Vendor & Reseller Portals** | Multi-vendor onboarding, shop profile, products, sub-orders, withdrawals, reseller margin tracking | CI & Database Integration | **ACCEPTED (Subject to Independent Verification)** |
| **Courier & Delivery Platform** | Steadfast, Pathao (with AES-256-GCM token rotation, distributed row locking & restricted recovery), RedX, Mock Courier, quote comparison, booking, tracking sync cron | CI & Contract Tests | **ACCEPTED (Subject to Independent Verification)** |
| **Security & Hardening** | Open redirect prevention (`safeReferrer`), CSRF tokens on all mutations, allowlist-only admin credential sanitization, PII masking, integer paisa math | CI & Security Suites | **ACCEPTED (Subject to Independent Verification)** |

---

## 2. Owner Decisions Summary (D1 — D12)

| ID | Title | Status | Safe Fail-Closed Default |
|---|---|:---:|---|
| **D1** | Staff RBAC Grants | `PENDING: Owner approval required` | Only Super Admin can mutate access; other staff accounts read-only. |
| **D2** | Audit Log Retention | `PENDING: Owner approval required` | Indefinite retention; zero audit log records purged. |
| **D3** | Vendor Delivery Model | `PENDING: Owner approval required` | Strict vendor sub-order isolation; parent order updated on delivery. |
| **D4** | Production DB Accounts | `PENDING: Blocked pending external config` | Awaiting cPanel MySQL user provisioning by owner. |
| **D5** | Perishable FEFO/Expiry | `PENDING: Owner approval required` | Aggregate inventory active; low-stock alerts enabled. |
| **D6** | Legal & Privacy Copy | `PENDING: Owner approval required` | Draft policy pages display review notice; password recovery disabled. |
| **D7** | Returns & Refunds Policy | `PENDING: Owner approval required` | Customer returns recorded with photo evidence; internal review only. |
| **D8** | Marketing Attribution Pixels | `PENDING: Blocked pending external config` | Disabled by default (`ANALYTICS_ATTRIBUTION_ENABLED=false`). |
| **D9/D10** | Android Signing & Origin | `PENDING: Blocked pending external config` | Requires owner production HTTPS domain and release keystore. |
| **D11** | Production Maintenance Window | `PENDING: Owner approval required` | Owner schedules deployment window on cPanel. |
| **D12** | cPanel Hosting Facts & Passenger Setup | `PENDING: Blocked pending external confirmation` | Actual cPanel/CloudLinux features, runtime versions, and storage paths remain unverified until inspected on the live host by the owner. |

---

## 3. Launch Verification Gate

> [!IMPORTANT]
> **Production deployment remains strictly ON HOLD.**
> All four critical findings confirmed by Arena (Pathao database persistence fail-closed, cross-process refresh locking via InnoDB `FOR UPDATE`, allowlist-only admin credential sanitization, and strict `invalid_grant` recovery boundary) have been implemented, verified with 16 automated tests, and committed to branch `antigravity/final-launch-readiness`.
> In accordance with governance instructions, **actual cPanel/Passenger verification and owner approvals are explicitly marked pending, and final acceptance is left entirely to Arena's independent verification**. No live money, production host modifications, live provider API credentials, or third-party live dispatches have been executed.
