# Mobile-responsive audit (implementation slice)

**Status:** `IN PROGRESS`. This documents a source-level responsive audit and CSS hardening, not a completed visual acceptance pass. No browser engine (Chromium/Chrome/Firefox/WebKit) or Playwright/Puppeteer package is installed in the current workspace. Therefore, the target widths below have not yet been rendered or measured in a browser, and no screenshot/overflow claim is made.

## Source reviewed

- Shared storefront shell/navigation/footer, home, catalog/filter bar, product detail, cart, checkout, order-success, and customer login/register/account templates.
- Shared Admin shell/head/topbar/sidebar plus Phase 06 inventory, supplier/product edit and Phase 08 order/refund tables/forms.
- Vendor and reseller shared shells, dashboards, product/order/wallet views.
- Shared design-system, storefront, and Admin CSS; shared interaction helper for CSRF, sidebar, focus, and table behaviors.

## Implemented responsive adjustments

- Added a shared small-screen layer with explicit breakpoints at `991.98px`, `767.98px`, `575.98px`, and `359.98px`; the phone floor is 320px and rules scale to desktop.
- Admin/vendor/reseller topbars reflow in mobile order, shrink the logo, reduce control padding, and suppress only nonessential compact-width topbar items/search while the sidebar retains portal navigation. User identity remains exposed through the avatar alt text.
- Storefront header/search become full-width and wrapping, category navigation retains horizontal scrolling, hero/copy and product cards get compact spacing, and cart/checkout details stay within available width.
- Checkout order summary stops sticking on small screens. Dialogs and floating support/notice UI are bounded by viewport width/height. Form controls and grid/flex children may shrink rather than forcing page overflow.
- Existing table scrollers receive touch momentum and visible keyboard focus. Shared UI marks scroll regions as keyboard-focusable named regions; the inventory table has a server-rendered localized region label and `tabindex`.
- Added `prefers-reduced-motion` overrides. No business behavior or workflow was changed by the CSS.

## Coverage and evidence

- Local `npm run lint` compiles all EJS templates and passes the repository foundation checks. Phase 04 tests include source-contract checks for the breakpoints and responsive selectors, plus existing HTTP coverage for bilingual storefront and all four portals.
- The Phase 06 database-backed route test now exercises the paginated inventory view in Bangla and English; this is in the exact-SHA MySQL/MariaDB CI suite, not a local browser test.
- Required manual/browser follow-up: render representative storefront home, catalog, product detail, cart, checkout, customer login/account, Admin dashboard/Phase 06/Phase 08, Vendor dashboard/list, and Reseller dashboard/list at 320, 360, 375, 576, 768, 992, and 1280px or wider, in both `bn` and `en`. Check `scrollWidth <= clientWidth` for page-level overflow, header/menu interactions, table keyboard/touch scrolling, dialogs, forms, and focus visibility. Correct issues found; do not mark P04-03 responsive acceptance complete until this evidence exists.

## Current follow-up

1. Run the manual/browser matrix when a browser-capable environment is available and record actual widths, routes/locales, overflow findings and screenshots or automation output.
2. Continue Phase 06 reports/low-stock acceptance after exact-SHA MySQL 8.0 and MariaDB 10.11 verification of the search/filter/pagination work.
