# Final browser and viewport QA evidence

**Browser:** `HeadlessChrome/92.0.4512.0` via Puppeteer Core 10.4.0.

**Initial code SHA:** `523bca6906f54971ae44e63e99a4b7430c219c50`; the browser session included the three local fixes listed below before commit.

**Data:** isolated local SQLite `data/qa-browser.db`; no production data, migration, or provider was touched.

**Responsive widths:** 360, 390, 768, and 1366 CSS pixels (900 px test height unless noted).
**CSS/JS:** sandbox policy blocked external CDNs. For trustworthy Bootstrap layout/modal behavior, the exact pinned Bootstrap 5.3.3 package was obtained from npm and served locally to Chromium for matching CDN URLs; no dependency or project asset was changed. Google fonts and third-party chart/toast/provider assets remained blocked and are not considered verified.

## Journey outcomes

| Journey | Result | Evidence / limitation |
|---|---|---|
| Home, catalog, category/search, product detail | **PASS** | Real pages rendered; search returned 24 product links. Product variant selection worked. |
| Cart add and quantity, stock validation | **PASS** | Browser added a 2-unit line and completed checkout. A disposable product fixture with stock 1 accepted no more than 1 when 2 was requested. `stock-validation.json`. |
| COD checkout / order creation | **PASS** | Real browser order confirmation `/order-success/71977`; only `cod` was available. Another isolated run confirmed the order in SQLite. No real payment occurred. |
| Non-COD / manual transfer submission | **PASS — blocked safely** | Browser/template regression plus route integration test: only COD is offered; non-COD method or transfer reference redirects without creating an order. |
| Customer registration, login, logout | **BLOCKED** | Customer auth is MySQL-backed. Local SQLite registration submission returned HTTP 400; no customer was created, so subsequent customer history/cancel/return journeys could not run. |
| Contact message submit and admin inbox | **PASS** | Browser-submitted message persisted in isolated fixture and was visible on the admin Contact Messages page. |
| Admin complaints inbox and pending orders | **PASS** | `/admin/complaints` and `/admin/order/pending` rendered; QA COD order appeared in pending orders. |
| Admin D7 return review/inspection/disposition | **BLOCKED** | The new RBAC mapping lets the request reach the D7 handler; SQLite is not a supported adapter for this workflow (HTTP 500). No decision or inspection was submitted. |
| Admin D7 settlements/settings | **BLOCKED** | MySQL configuration/service is absent (HTTP 400 missing `DB_NAME`/`DB_USER`). No financial action was attempted. |
| Admin inventory and stock-ledger screens | **PASS — screen only** | `/admin/phase06` rendered four table regions at all four widths. No purchase/adjustment mutation was attempted. |
| Vendor login and portal screens | **PASS — screen only** | Orders, products, withdrawals rendered at four widths. Canonical item fulfillment and settlements remain **BLOCKED** by MySQL-only repository paths; no status or payout action was attempted. |
| Reseller login and portal screens | **PASS — screen only** | Dashboard, orders, products, transactions, deposits and withdrawals rendered at four widths. Financial/order mutations were not attempted. |
| Role and tenant boundaries | **PASS** | Support admin got HTTP 403 for complaints; vendor→reseller/admin and reseller→vendor/admin requests redirected to the relevant login. See `cross-portal-security.json`. |

## Rendered viewport checks

`final-real-browser.json` contains 92 rendered route/width measurements. Public/storefront, admin complaint/contact/order, inventory, vendor and reseller routes were checked at 360/390/768/1366 px. `documentElement.scrollWidth` and `body.scrollWidth` matched the viewport on all checked pages **after the fix**.

A real 768 px admin inventory run found the supplier submit button expanding the document to 802 px. The button was made responsive and wrapping; a repeat Chromium run measured 768/768 with no overflow. Other checked pages showed no horizontal overflow. Viewport screenshots are in this directory (home/product/contact/cart, admin inventory, vendor/reseller screens).

## Interactions and limitations

- Bootstrap mobile offcanvas and complaint modal opened in the browser at 360 px; scrolling to page bottom worked.
- Vendor create-product file input accepted a PNG selection in Chromium; the form was not submitted, so no file or product was written. Upload server handling remains **NOT TESTED**.
- External Google font, ApexCharts/toastr, and provider assets failed due sandbox host restrictions. They were not treated as application flow failures, but their production-network behavior remains **NOT TESTED**.
- No live payment, refund, payout, delivery, or provider operation occurred. COD destination verification/refund requirements, internal-only settlement approval, and all stated no-policy/no-entitlement constraints remain unchanged.

## Fixes and automated verification

1. Checkout UI is COD-only in both local SQLite and canonical MySQL rendering; SQLite route rejects non-COD/transfer-reference payloads before order insert.
2. D7 paths now have explicit legacy RBAC mappings; settlement list permits either prepare or approve permission while mutation permissions remain separate.
3. Admin inventory supplier button wraps at tablet width to avoid document overflow.

`npm run verify` after these changes: foundation checker **948 checks passed**; Node tests **167 total, 143 passed, 0 failed, 24 skipped** (MySQL/MariaDB integrations require CI). See the updated parent `browser-and-viewport-status.md` for exact-SHA CI status after push.
