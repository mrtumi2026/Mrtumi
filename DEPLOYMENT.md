# DEPLOYMENT & HOSTING GUIDE — Mr. Tumi Grocery & Gift

**Status:** `NOT STARTED` (Initial Governance Skeleton — Phase 01; Full Runbook Scheduled for Phase 02 & Phase 20)

---

## 1. Deployment Governance Rules
1. **Owner-Controlled Hosting Only:** All application code, database storage, uploaded assets, and environment secrets belong exclusively to the owner.
2. **No Unauthorized Production Push or Deploy:** Production deployment will **never** run without explicit owner approval after Phase 20 QA and backup verification.
3. **Zero Secrets in Git:** All production credentials (`SESSION_SECRET`, DB paths/URLs, `bKash`, `ShurjoPay`, `UddoktaPay`, `Steadfast`, `Pathao`, `RedX`, `BDCourier`, `BulkSMSBD`, `Meta CAPI`, `SMTP`) must reside only in server-side `.env` / hosting secret manager, documented via placeholder keys in `.env.example`.

## 2. Hosting Questionnaire (Pending Owner Confirmation in `DECISIONS.md` — `ADR-001`)
Before locking the runtime architecture in **Phase 02**, confirm your target hosting environment:
- **Option A (Recommended for Existing Codebase):** VPS / Cloud VM (Ubuntu + Nginx + PM2/Docker) or cPanel with **Setup Node.js App** enabled.
- **Option B:** Shared cPanel hosting with **PHP/MySQL only** (no Node.js runtime).

## 3. Sections to be Populated in Phases 02, 03 & 20
- Server prerequisites & runtime versions
- Environment variable reference (`.env.example`)
- Database migration & rollback commands
- Reverse proxy, HTTPS/TLS & static upload hardening
- Cron / background worker configuration (SMS retry queue, incomplete checkout cleanup, courier sync)
- Automated daily database & media backup + tested restore procedure
