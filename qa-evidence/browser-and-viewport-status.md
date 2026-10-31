# Final browser, viewport, and E2E QA status

Date: 2026-10-31 (Asia/Dhaka)

## Browser execution and evidence

- Actual browser: **HeadlessChrome/92.0.4512.0**, driven by Puppeteer Core 10.4.0. The isolated app used SQLite at `data/qa-browser.db`; no production data or provider was touched.
- Rendered route checks covered **360, 390, 768, and 1366 CSS px**. Bootstrap **5.3.3** CSS/JS was served locally to the browser from its exact pinned npm package because the sandbox blocks the app's CDN host. Google fonts and third-party chart/toast/provider assets were not available and remain unverified.
- Evidence: `qa-evidence/browser-final/README.md`, `final-real-browser.json`, `stock-validation.json`, `cross-portal-security.json`, and screenshots in `qa-evidence/browser-final/`.
- 92 route/viewport measurements were recorded. Home, product, contact, cart/checkout, admin complaints/contact/pending orders/inventory, vendor and reseller pages had no horizontal overflow after a confirmed 768 px inventory form defect was fixed and rechecked.
- Real interactions: browse/search, product variant selection, cart add, COD checkout/order confirmation, contact message and admin inbox, responsive mobile drawer/modal, inventory screens, vendor/reseller page access and cross-portal denial. Upload field selection was tested; upload submission was not.

## Journey outcomes

- **PASS:** browsing/search/product detail; cart add and constrained-stock check; COD order creation (actual local confirmation); COD-only UI and rejection of non-COD/transfer details; contact message submission/inbox; admin complaints and pending order screens; inventory/ledger screen rendering; vendor and reseller login/page rendering; limited-admin and cross-portal denial.
- **BLOCKED:** customer registration/login/logout, customer history/cancellation/returns/evidence/status, admin return inspection/disposition, vendor item fulfillment and canonical settlement workflows. The corresponding customer/D7/vendor repository flows require MySQL; no local MySQL/MariaDB service is installed. Admin D7 settings/settlement endpoints also returned missing `DB_NAME`/`DB_USER` in this isolated environment. No mutation/payment/refund/payout/provider action was attempted.
- **NOT TESTED:** upload submission (only file selection), and behavior of external fonts/charts/toast/provider assets under production network access. See the evidence README for details.

## Defects fixed during QA

1. Checkout's legacy SQLite rendering exposed configured non-COD gateway options and transfer fields. UI now offers COD only; backend rejects every non-COD/transaction-reference submission before order persistence. Integration regression passes.
2. D7 return, settings and settlement URLs had no explicit legacy RBAC mapping. They now have permission-specific policies; settlement listing accepts either `settlements.prepare` or `settlements.approve`, while mutation authority remains separate. Unit regressions pass. Runtime D7 data routes remain blocked by missing MySQL.
3. Real 768 px rendering showed the supplier submit button expanding `/admin/phase06` from 768 to 802 px. The button now wraps responsively; a repeat real-browser run measured 768/768 with no overflow.

## Automated verification

- `npm run verify`: foundation check **948 passed, 0 failed**; Node suite **167 total, 143 passed, 0 failed, 24 skipped**. Skips are MySQL/MariaDB integration cases, which must run in CI.
- Exact-SHA CI run **41215634955** passed on code commit `3d2b4f5eafe62af1215f1915942de5365877fb46`: [MySQL 8.0 job](https://github.com/mrtumi2026/Mrtumi/actions/runs/41215634955/job/124579438665) and [MariaDB 10.11 job](https://github.com/mrtumi2026/Mrtumi/actions/runs/41215634955/job/124579438898). This evidence-only follow-up is being pushed separately; its workflow will also be checked before reporting the final SHA.

## Launch sign-off

**Not 100% complete.** Browser evidence is real but local MySQL-dependent customer returns/cancellation, admin inspection/disposition, canonical vendor fulfillment/settlement and exact-final-SHA database CI remain blockers. Approved limitations remain: COD only; no real payments/refunds/payouts/delivery/provider actions; no unverified COD refund destination; settlement approval internal only; no category returns or staff permission changes without owner approval; no invented commercial policy or entitlements.
