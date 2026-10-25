# PHASE 04 — FRONTEND BASELINE AUDIT, BRANDING, DESIGN SYSTEM & BILINGUAL UI SPECIFICATION

**Project:** Mr. Tumi Grocery & Gift (`মি. তুমি গ্রোসারি অ্যান্ড গিফট`)  
**Phase:** `PHASE 04 — BRANDING, DESIGN SYSTEM AND BILINGUAL UI`  
**Date:** `2026-10-25` (`Asia/Dhaka`)  
**Default Locale:** Bangla (`bn`) | **Alternate Locale:** English (`en`) | **Currency:** `BDT (৳)`

---

## 1. Pre-Implementation Frontend & Brand Baseline Audit

Before modifying any stylesheet, script, or EJS template, all `48` EJS views, `2` CSS stylesheets, `3` client JS files, and `15` `public/uploads/` assets were inspected at commit `63bb7a0`.

### 1.1 Brand Asset & Identity Findings
1. **Owner Logo Search:** Inspected `public/` and full Git commit history (`781fcb4`..`63bb7a0`). **No owner-supplied Mr. Tumi Grocery & Gift logo files exist in the repository yet.**
2. **Reference Website Identity Leakage Found in Baseline:**
   - `public/uploads/settings/logo.svg` and `public/uploads/settings/logo-light.svg` contained SVG wordmarks for `"ফল বাজার"` (`Phol Bazar`) with tagline `"খাঁটি মানের খাবারের নিশ্চয়তা"`.
   - `16` EJS templates (`views/store/partials/{header,footer}.ejs`, `views/store/{page,product}.ejs`, `views/admin/partials/head.ejs`, `views/admin/{login,order-invoice,settings,gemini-chat}.ejs`, `views/vendor/{auth,partials/layout-top}.ejs`, `views/reseller/{auth,products,partials/layout-top}.ejs`) and legacy local prototype settings fell back to `'ফল বাজার'`.
3. **Phase 04 Remediation (Honest Temporary Placeholder Policy):**
   - Replace `logo.svg`, `logo-light.svg`, and add `favicon.svg` under `public/uploads/brand/` (and mirror to `public/uploads/settings/logo*.svg` so existing DB paths never render `"ফল বাজার"`).
   - Explicitly mark these SVGs and UI metadata as **Temporary Brand Placeholders** (`TEMP LOGO`, `data-brand-asset-status="temporary-placeholder"`), **not** final owner-approved logos.
   - Normalize legacy `'ফল বাজার'` display fallbacks at the presentation boundary (`src/i18n/brand.js`) without destructively modifying or resetting untouched `data/pholbazar.db*`.

### 1.2 Portal, Layout & Asset Baseline Inventory

| Portal | Layout / Templates | Baseline Styles & Scripts | Baseline Issues Identified |
|---|---|---|---|
| **Customer Storefront** | `views/store/partials/{header,footer,product-card}.ejs` + `9` page views | `Bootstrap 5.3.3`, `FontAwesome 6.5.2`, `Toastr`, `public/frontEnd/css/storefront.css`, `storefront.js`, `pb-session.js` | Hardcoded `<html lang="bn">`; no `bn`/`en` language switch; no dedicated mobile navigation offcanvas drawer (`<992px` header wraps awkwardly); icon-only buttons (`Search`, `Add to Cart`, `Delete`, `Close`) missing `aria-label`s; `.toLocaleString('en-IN')` hardcoded instead of `BDT` localized formatter; fruit-only copy instead of Grocery & Gift foundation. |
| **Admin Control Panel** | `views/admin/partials/{head,topbar,sidebar,footer}.ejs` + `14` views (`43` sidebar menu links across `14` collapsible groups & `20` direct items) | `Bootstrap 5.3.3`, `Feather Icons`, `FontAwesome`, `SweetAlert2`, `ApexCharts`, `public/backEnd/css/ubold-admin.css`, `admin-core.js` | Hardcoded `<html lang="en">` mixed with Bangla strings; no `bn`/`en` language toggle; collapsible sidebar links missing initial `aria-expanded="false"` and `aria-controls`; **missing mobile sidebar backdrop overlay** on `<992px` and no `Escape` key handler; muted `#9ca3af` text on `#ffffff` (`2.54:1` contrast) fails WCAG AA (`4.5:1`). |
| **Vendor / Seller Portal** | `views/vendor/partials/{layout-top,layout-bottom}.ejs` + `6` views | Shares `ubold-admin.css` + inline green sidebar overrides | Missing `admin-core.js` mobile backdrop/Escape support, missing `bn`/`en` switch, missing skip link & focus outlines, legacy `'ফল বাজার'` title/logo fallback. |
| **Reseller Portal** | `views/reseller/partials/{layout-top,layout-bottom}.ejs` + `6` views | Shares `ubold-admin.css` + inline indigo sidebar overrides | Same mobile sidebar, focus-visible, language toggle, and brand fallback issues as Vendor portal. |

### 1.3 Bangla Typography & Accessibility Issues Identified
- **Bangla Vowel Diacritic Clipping Risk:** `line-height: 1.1–1.25` on headings/badges can clip upper/lower Bangla *kar*/*fala* glyphs (`ী`, `ৈ`, `ু`, `ূ`, `ঁ`). Fixed in Phase 04 via `:lang(bn)` line-height rules (`>= 1.45` on headings, `>= 1.6` on body copy) and `Hind Siliguri` + `Noto Sans Bengali` fallback stack.
- **Keyboard Focus Visibility:** Buttons, sidebar links, category links, and custom payment radio cards lacked high-contrast `:focus-visible` outlines.
- **Business-Critical Legal & Policy Copy:** CMS policy pages (`about-us`, `return-policy`, `privacy-policy`, `terms-conditions`) currently hold prototype Bangla text and have no owner-approved English legal translation. Per Phase 04 instructions, **we do not silently machine-translate legal/policy text and present it as approved** — `views/partials/copy-review-notice.ejs` flags unapproved policy copy explicitly for owner review.

---

## 2. Mr. Tumi Design System Architecture (`public/shared/css/mrtumi-design-system.css`)

### 2.1 Semantic Color Tokens (WCAG AA Contrast Verified `>= 4.5:1`)
- **Primary Grocery Emerald:**
  - `--mt-primary-900`: `#0d3b26` (Deep Market Forest — `12.1:1` on white)
  - `--mt-primary-800`: `#14532d` (`8.9:1` on white)
  - `--mt-primary-700`: `#15803d` (`5.1:1` on white)
  - `--mt-primary-50`: `#f0fdf4` (Soft surface tint)
- **Secondary Gift Warm Amber / Terracotta:**
  - `--mt-gift-700`: `#b45309` (`5.0:1` on white — accessible Gift badge/accent text)
  - `--mt-gift-500`: `#f59e0b` (Warm gold highlight with `#111827` dark text — `10.8:1` contrast)
  - `--mt-gift-50`: `#fffbeb`
- **Admin Dark Shell (Guided by Reference Screenshots):**
  - `--mt-admin-topbar`: `#151e2c`
  - `--mt-admin-sidebar`: `#1a2433`
  - `--mt-admin-sidebar-text`: `#cbd5e1` (`9.8:1` on `#1a2433`)
  - `--mt-admin-sidebar-active`: `rgba(34, 197, 94, 0.16)` with `#4ade80` accent bar
- **Neutral & Text Scale (Upgraded from `#9ca3af` for WCAG AA):**
  - `--mt-text-strong`: `#0f172a` (`18.9:1` on white)
  - `--mt-text-body`: `#1e293b` (`16.1:1` on white)
  - `--mt-text-muted`: `#475569` (`7.5:1` on white — replaces low-contrast `#9ca3af`)
  - `--mt-border`: `#e2e8f0`
  - `--mt-surface`: `#ffffff`, `--mt-bg`: `#f8fafc`

### 2.2 Typography, Spacing & Responsive Breakpoints
- **Font Stack:** `'Hind Siliguri', 'Noto Sans Bengali', 'Inter', system-ui, -apple-system, sans-serif`
- **Spacing Scale:** `4px` base (`--mt-space-1: 0.25rem` through `--mt-space-8: 2.5rem`)
- **Breakpoints Tested:**
  - Mobile Small: `360px` – `575px` (2-column compact product cards, offcanvas mobile nav & filter drawer, stacked forms, touch targets `>= 40px`)
  - Tablet: `768px` – `991px` (3-column product grid, slide-over admin/vendor/reseller sidebar with backdrop)
  - Desktop: `992px` – `1440px+` (4-column product grid, fixed `252px` collapsible dark admin sidebar)

### 2.3 Reusable UI Partials (`views/partials/`)
1. `views/partials/lang-switch.ejs` — Accessible `বাংলা | EN` toggle preserving current URL & iframe session token.
2. `views/partials/empty-state.ejs` — Standardized empty-collection card with icon, bilingual title/description, and optional CTA.
3. `views/partials/alert-banner.ejs` — Accessible (`role="alert"` / `aria-live="polite"`) `success`, `error`, `warning`, and `info` feedback banner.
4. `views/partials/pagination.ejs` — Accessible `<nav aria-label="...">` pagination bar with localized page numerals.
5. `views/partials/filter-bar.ejs` — Reusable search, sort, and filter control strip.
6. `views/partials/copy-review-notice.ejs` — Explicit notice for legal/policy/payment copy awaiting owner sign-off.

---

## 3. Bilingual Localization & Bangladesh Formatting (`src/i18n/` & `src/utils/formatters.js`)

1. **Resolution Order (`src/middleware/i18n.js`):**
   - Query parameter `?lang=bn|en` (persists to session + cookie) → `req.session.locale` → `mrtumi_lang` cookie → `env.defaultLocale` (`'bn'`).
   - Switcher endpoint `GET /locale/:lang` (and `POST /locale`) validates against `env.supportedLocales` (`['bn', 'en']`) and redirects safely to internal relative paths only (preventing open-redirect vulnerabilities).
2. **Dictionary Discipline (`src/i18n/locales/bn.js` & `en.js`):**
   - Strict 1:1 key parity enforced by automated tests (`tests/phase04-ui-i18n.test.js`).
   - Missing keys never expose raw dotted identifiers in production UI.
3. **Localized Formatters (`src/utils/formatters.js`):**
   - `formatBdtDisplay(amountBdt, locale)` & `formatPaisaDisplay(amountPaisa, locale)` — Renders `৳১,৩৫০` in `bn` and `৳1,350` in `en`.
   - `formatLocalizedNumber(value, locale)` — Bangla digits (`০-৯`) in `bn`, ASCII digits (`0-9`) in `en`.
   - `formatDhakaDate(input, locale)` & `formatDhakaDateTime(input, locale)` — Always formats in `timeZone: 'Asia/Dhaka'` (`UTC+06:00`).

---

## 4. Items Flagged for Owner Review / Assets Requested

1. **Official Brand Logo Files Requested from Owner:**
   - Primary light-background logo (`SVG` or transparent `PNG`, recommended `320×80`)
   - Dark-background logo for Admin/Vendor/Reseller dark topbar & footer (`SVG` or transparent `PNG`)
   - Square icon / favicon (`SVG` or `512×512 PNG`)
2. **Business-Critical Legal & Policy Copy Requires Owner Sign-Off (Not Machine-Translated):**
   - `About Us` (`আমাদের সম্পর্কে`), `Return & Refund Policy` (`রিটার্ন ও রিফান্ড পলিসি`), `Privacy Policy` (`গোপনীয়তা নীতি`), and `Terms & Conditions` (`শর্তাবলী`) — flagged via `copy-review-notice.ejs` until final bilingual (`bn` + `en`) legal copy is provided by the owner.
