'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DB_PATH = path.join(os.tmpdir(), `mrtumi.phase04.${process.pid}.${Date.now()}.test.db`);
const TEST_ADMIN_EMAIL = 'phase04admin@mrtumi.test';
const TEST_ADMIN_PASSWORD = 'Phase04StrongPassword!2026';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'sqlite';
process.env.SQLITE_PATH = TEST_DB_PATH;
process.env.SEED_DEMO_DATA = 'true';
process.env.BOOTSTRAP_ADMIN_EMAIL = TEST_ADMIN_EMAIL;
process.env.BOOTSTRAP_ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
process.env.LOG_SILENT = 'true';

const {
  DICTIONARIES,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  normalizeLocale,
  translate,
  flattenDictionaryKeys,
} = require('../src/i18n');
const {
  formatBdtDisplay,
  formatPaisaDisplay,
  formatLocalizedNumber,
  formatDhakaDate,
  formatDhakaDateTime,
} = require('../src/utils/formatters');
const {
  resolveBrandContext,
  requiresOwnerCopyReview,
  hasLegacyReferenceBrand,
} = require('../src/i18n/brand');
const { sanitizeReturnTo, LOCALE_COOKIE_NAME } = require('../src/middleware/i18n');
const { buildConfig } = require('../src/config/env');
const sqliteDb = require('../src/db/database');
const { app } = require('../server');

/**
 * Minimal HTTP client helper for testing Express routes with cookies & headers.
 */
function httpRequest(baseUrl, reqPath, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseUrl);
    const payload = body
      ? typeof body === 'string'
        ? body
        : new URLSearchParams(body).toString()
      : null;

    const finalHeaders = { ...headers };
    if (payload && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      finalHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      url,
      {
        method,
        headers: finalHeaders,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function mergeCookies(existingCookieStr, setCookieHeader) {
  const jar = new Map();
  if (existingCookieStr) {
    existingCookieStr.split(';').forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    });
  }
  const incoming = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  incoming.forEach((raw) => {
    const first = String(raw).split(';')[0];
    const idx = first.indexOf('=');
    if (idx > 0) jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
  });
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * WCAG 2.1 contrast ratio helper (`#rrggbb` foreground vs background).
 */
function hexToLuminance(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(fgHex, bgHex) {
  const l1 = hexToLuminance(fgHex);
  const l2 = hexToLuminance(bgHex);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Phase 04 — Branding, Design System, Accessibility & Bilingual UI (`bn` / `en`)', () => {
  let server;
  let baseUrl;

  before(async () => {
    sqliteDb.run('UPDATE users SET role = ? WHERE LOWER(email) = ?', 'Super Admin', TEST_ADMIN_EMAIL.toLowerCase());
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${TEST_DB_PATH}${suffix}`);
      } catch (_err) {
        // Ignore if not created
      }
    }
  });

  test('1. i18n dictionaries enforce strict 1:1 `bn` and `en` key parity with Bangla default', () => {
    assert.equal(DEFAULT_LOCALE, 'bn');
    assert.deepEqual(SUPPORTED_LOCALES, ['bn', 'en']);

    const bnKeys = flattenDictionaryKeys(DICTIONARIES.bn);
    const enKeys = flattenDictionaryKeys(DICTIONARIES.en);

    assert.ok(bnKeys.length >= 120, `Expected >= 120 keys, found ${bnKeys.length}`);
    assert.deepEqual(bnKeys, enKeys, 'bn and en dictionaries must have identical key sets');

    for (const key of bnKeys) {
      const bnVal = translate('bn', key);
      const enVal = translate('en', key);
      assert.ok(bnVal.trim().length > 0, `Empty bn translation for ${key}`);
      assert.ok(enVal.trim().length > 0, `Empty en translation for ${key}`);
    }

    assert.equal(normalizeLocale(undefined), 'bn');
    assert.equal(normalizeLocale('bn-BD'), 'bn');
    assert.equal(normalizeLocale('en-US'), 'en');
    assert.equal(normalizeLocale('fr-FR'), 'bn');

    // Missing keys must humanize gracefully and NEVER leak raw dotted keys
    assert.equal(translate('bn', 'nonExistent.checkoutButtonLabel'), 'Checkout Button Label');
  });

  test('2. Bangladesh BDT (`৳`), South Asian grouping, Bangla numerals & `Asia/Dhaka` timestamps format accurately', () => {
    assert.equal(formatBdtDisplay(1350, 'bn'), '৳১,৩৫০');
    assert.equal(formatBdtDisplay(1350, 'en'), '৳1,350');
    assert.equal(formatBdtDisplay(135000, 'bn'), '৳১,৩৫,০০০');
    assert.equal(formatBdtDisplay(135000, 'en'), '৳1,35,000');

    assert.equal(formatPaisaDisplay(99950, 'bn'), '৳৯৯৯.৫০');
    assert.equal(formatPaisaDisplay(99950, 'en'), '৳999.50');
    assert.equal(formatLocalizedNumber(42, 'bn'), '৪২');
    assert.equal(formatLocalizedNumber(42, 'en'), '42');

    // Midnight UTC boundary check: 2026-10-24T20:30:00Z == 2026-10-25 02:30 AM in Asia/Dhaka (+06:00)
    const utcTimestamp = '2026-10-24T20:30:00Z';
    assert.equal(formatDhakaDate(utcTimestamp, 'en'), '25 Oct 2026');
    assert.equal(formatDhakaDate(utcTimestamp, 'bn'), '২৫ অক্টো ২০২৬');
    assert.equal(formatDhakaDateTime(utcTimestamp, 'en'), '25 Oct 2026, 02:30 AM');
    assert.equal(formatDhakaDateTime(utcTimestamp, 'bn'), '২৫ অক্টো ২০২৬, ০২:৩০ পূর্বাহ্ণ');
  });

  test('3. Brand context normalizes legacy reference identity and flags temporary placeholder logos honestly', () => {
    const legacyBn = resolveBrandContext(
      {
        site_name: 'ফল বাজার',
        site_email: 'support@pholbazar.com',
        logo_dark: '/uploads/settings/logo.svg',
      },
      'bn'
    );
    assert.equal(legacyBn.siteSettings.site_name, 'মি. তুমি গ্রোসারি অ্যান্ড গিফট');
    assert.equal(legacyBn.siteSettings.site_email, 'support@mrtumi.com');
    assert.equal(legacyBn.brand.isPlaceholderLogo, true);
    assert.equal(hasLegacyReferenceBrand(legacyBn.siteSettings.site_name), false);

    const legacyEn = resolveBrandContext({ site_name: 'ফল বাজার' }, 'en');
    assert.equal(legacyEn.siteSettings.site_name, 'Mr. Tumi Grocery & Gift');

    const customOwnerLogo = resolveBrandContext(
      {
        site_name: 'Mr. Tumi Grocery & Gift',
        logo_dark: '/uploads/custom/owner-approved-logo.svg',
        logo_light: '/uploads/custom/owner-approved-logo-light.svg',
      },
      'en'
    );
    assert.equal(customOwnerLogo.brand.isPlaceholderLogo, false);

    // Open-redirect protection on locale switcher returnTo
    assert.equal(sanitizeReturnTo('/all-products?sort=price_asc'), '/all-products?sort=price_asc');
    assert.equal(sanitizeReturnTo('//evil.example/phish'), '/');
    assert.equal(sanitizeReturnTo('https://evil.example/phish'), '/');
    assert.equal(sanitizeReturnTo('/\\evil.example'), '/');
  });

  test('4. Storefront defaults to Bangla (`bn`), switches cleanly to English (`en`), persists preference & exposes zero reference brand strings', async () => {
    // Default visit -> Bangla (`bn`)
    const homeBn = await httpRequest(baseUrl, '/');
    assert.equal(homeBn.status, 200);
    assert.equal(homeBn.headers['content-language'], 'bn');
    assert.match(homeBn.text, /<html lang="bn">/);
    assert.match(homeBn.text, /মি\. তুমি গ্রোসারি অ্যান্ড গিফট/);
    assert.match(homeBn.text, /কেনাকাটা শুরু করুন/);
    assert.match(homeBn.text, /data-brand-asset-status="temporary-placeholder"/);
    assert.doesNotMatch(homeBn.text, /ফল বাজার/);

    // Switch to English (`en`) via `/locale/en` (sessionManager preserves `_sid` query in non-prod)
    const switchRes = await httpRequest(baseUrl, '/locale/en?returnTo=/all-products');
    assert.equal(switchRes.status, 302);
    assert.equal(new URL(switchRes.headers.location, baseUrl).pathname, '/all-products');
    const cookieJar = mergeCookies('', switchRes.headers['set-cookie']);
    assert.match(cookieJar, new RegExp(`${LOCALE_COOKIE_NAME}=en`));

    // Subsequent page load uses persisted English preference
    const catalogEn = await httpRequest(baseUrl, '/all-products', {
      headers: { Cookie: cookieJar },
    });
    assert.equal(catalogEn.status, 200);
    assert.equal(catalogEn.headers['content-language'], 'en');
    assert.match(catalogEn.text, /<html lang="en">/);
    assert.match(catalogEn.text, /Mr\. Tumi Grocery &amp; Gift|Mr\. Tumi Grocery & Gift/);
    assert.match(catalogEn.text, /Newest Arrivals/);
    assert.match(catalogEn.text, /Order Now/);
    assert.doesNotMatch(catalogEn.text, /ফল বাজার/);

    // Block open redirect attempts on `/locale/bn`
    const openRedirectTry = await httpRequest(baseUrl, '/locale/bn?returnTo=//attacker.example');
    assert.equal(openRedirectTry.status, 302);
    assert.equal(new URL(openRedirectTry.headers.location, baseUrl).pathname, '/');
  });

  test('5. Legal & policy CMS pages explicitly flag draft copy for owner review instead of faking approved legal copy', async () => {
    assert.equal(requiresOwnerCopyReview('return-policy'), true);
    assert.equal(requiresOwnerCopyReview('privacy-policy'), true);
    assert.equal(requiresOwnerCopyReview('terms-conditions'), true);

    const policyBn = await httpRequest(baseUrl, '/page/return-policy');
    assert.equal(policyBn.status, 200);
    assert.match(policyBn.text, /mt-copy-review-banner/);
    assert.match(policyBn.text, /মালিকের অনুমোদন প্রয়োজন/);
    assert.doesNotMatch(policyBn.text, /ফল বাজার/);

    const policyEn = await httpRequest(baseUrl, '/page/terms-conditions?lang=en');
    assert.equal(policyEn.status, 200);
    assert.match(policyEn.text, /mt-copy-review-banner/);
    assert.match(policyEn.text, /Owner Review Required/);
    assert.doesNotMatch(policyEn.text, /ফল বাজার/);
  });

  test('6. Accessibility landmarks, mobile navigation, form labels & 43-item Admin sidebar work across all 4 portals', async () => {
    // Storefront Cart & Track Order accessibility checks
    for (const storePath of ['/', '/cart', '/track-order', '/customer/checkout']) {
      const res = await httpRequest(baseUrl, storePath);
      assert.equal(res.status, 200, `Expected 200 on ${storePath}`);
      assert.match(res.text, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
      assert.match(res.text, /class="mt-skip-link"/);
      assert.match(res.text, /id="mainContent"/);
      assert.match(res.text, /id="mobileStoreNavDrawer"/);
      assert.doesNotMatch(res.text, /ফল বাজার/);
    }

    // Vendor & Reseller auth portals
    for (const portalPath of ['/vendor/login', '/reseller/login', '/admin/login']) {
      const res = await httpRequest(baseUrl, `${portalPath}?lang=en`);
      assert.equal(res.status, 200, `Expected 200 on ${portalPath}`);
      assert.match(res.text, /<html lang="en">/);
      assert.match(res.text, /class="mt-skip-link"/);
      assert.match(res.text, /id="mainContent"/);
      assert.match(res.text, /<label for=/);
      assert.doesNotMatch(res.text, /ফল বাজার/);
    }

    // Authenticate into Admin Dashboard & verify dark sidebar, mobile backdrop, ARIA collapse & all routes
    const loginPage = await httpRequest(baseUrl, '/admin/login');
    let adminCookie = mergeCookies('', loginPage.headers['set-cookie']);
    const loginCsrf=loginPage.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
    assert.ok(loginCsrf,'login form exposes a session-bound CSRF token');

    const loginPost = await httpRequest(baseUrl, '/admin/login', {
      method: 'POST',
      headers: { Cookie: adminCookie },
      body: { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, _csrf:loginCsrf },
    });
    assert.equal(loginPost.status, 302);
    assert.equal(loginPost.headers.location, '/admin/dashboard');
    adminCookie = mergeCookies(adminCookie, loginPost.headers['set-cookie']);

    const dashBn = await httpRequest(baseUrl, '/admin/dashboard?lang=bn', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(dashBn.status, 200);
    assert.match(dashBn.text, /data-leftbar-color="dark"/);
    assert.match(dashBn.text, /id="mtSidebarBackdrop"/);
    assert.match(dashBn.text, /মি\. তুমি অপারেশন ড্যাশবোর্ড/);
    assert.doesNotMatch(dashBn.text, /ফল বাজার/);

    // Verify collapsible sidebar triggers carry aria-expanded and aria-controls
    const collapseTriggers = [...dashBn.text.matchAll(/<a\s+[^>]*data-bs-toggle="collapse"[^>]*>/g)].map((m) => m[0]);
    assert.ok(collapseTriggers.length >= 14, `Expected >= 14 collapsible admin menu groups, found ${collapseTriggers.length}`);
    for (const tag of collapseTriggers) {
      assert.match(tag, /aria-expanded="false"/, `Missing aria-expanded on ${tag}`);
      assert.match(tag, /aria-controls="[^"]+"/, `Missing aria-controls on ${tag}`);
    }

    // Verify >= 43 admin route links preserved in sidebar
    const sidebarLinks = [...dashBn.text.matchAll(/href="(\/admin\/[^"#]+)"/g)].map((m) => m[1]);
    const uniqueAdminRoutes = new Set(sidebarLinks);
    assert.ok(uniqueAdminRoutes.size >= 43, `Expected >= 43 unique admin routes in sidebar/dashboard, found ${uniqueAdminRoutes.size}`);

    // Verify Admin Dashboard switches cleanly to English (`en`) too
    const dashEn = await httpRequest(baseUrl, '/admin/dashboard?lang=en', {
      headers: { Cookie: adminCookie },
    });
    assert.equal(dashEn.status, 200);
    assert.match(dashEn.text, /<html lang="en">/);
    assert.match(dashEn.text, /Mr\. Tumi Operations Dashboard/);
  });

  test('7. Responsive style contract covers phone/tablet breakpoints, portal topbars, checkout, tables and reduced motion', () => {
    const css=fs.readFileSync(path.join(__dirname,'../public/shared/css/mrtumi-design-system.css'),'utf8');
    const ui=fs.readFileSync(path.join(__dirname,'../public/shared/js/mrtumi-ui.js'),'utf8');
    const topbar=fs.readFileSync(path.join(__dirname,'../views/admin/partials/topbar.ejs'),'utf8');
    const checkout=fs.readFileSync(path.join(__dirname,'../views/store/checkout.ejs'),'utf8');
    for(const width of ['991.98px','767.98px','575.98px','359.98px'])assert.ok(css.includes(`max-width: ${width}`),`responsive breakpoint ${width} remains explicit`);
    assert.match(css,/\.navbar-custom \.topnav-menu\.float-end/);
    assert.match(css,/\.pb-search-box\s*\{\s*flex-basis:\s*100%/);
    assert.match(css,/\.checkout-order-summary\s*\{\s*position:\s*static/);
    assert.match(css,/\.table-responsive:focus-visible/);
    assert.match(css,/prefers-reduced-motion:\s*reduce/);
    assert.match(ui,/labelScrollableTables/);
    assert.match(topbar,/admin-top-search/);
    assert.match(checkout,/checkout-order-summary/);
  });

  test('8. Design-system color tokens satisfy WCAG 2.1 AA contrast (`>= 4.5:1`) & Phase 03 SQLite guard remains intact', () => {
    const tokenPairs = [
      { name: 'Body text on white surface', fg: '#1e293b', bg: '#ffffff', min: 4.5 },
      { name: 'Muted text on white surface', fg: '#475569', bg: '#ffffff', min: 4.5 },
      { name: 'Muted text on subtle surface', fg: '#475569', bg: '#f8fafc', min: 4.5 },
      { name: 'Primary button white on emerald-900', fg: '#ffffff', bg: '#0d3b26', min: 4.5 },
      { name: 'Gift button dark text on amber-500', fg: '#111827', bg: '#f59e0b', min: 4.5 },
      { name: 'Admin sidebar text on dark sidebar', fg: '#cbd5e1', bg: '#1a2433', min: 4.5 },
      { name: 'Storefront footer links on dark emerald', fg: '#cbd5e1', bg: '#072618', min: 4.5 },
      { name: 'Copy review badge text on amber-100', fg: '#78350f', bg: '#fef3c7', min: 4.5 },
    ];

    for (const pair of tokenPairs) {
      const ratio = contrastRatio(pair.fg, pair.bg);
      assert.ok(
        ratio >= pair.min,
        `${pair.name} (${pair.fg} on ${pair.bg}) contrast ${ratio.toFixed(2)}:1 is below ${pair.min}:1`
      );
    }

    // Regression: Phase 03 SQLite production guard must NEVER be weakened
    assert.throws(
      () =>
        buildConfig({
          NODE_ENV: 'production',
          DB_CLIENT: 'sqlite',
          APP_URL: 'https://mrtumi.com',
          SESSION_SECRET: 'production-secret-at-least-thirty-two-characters-long!!',
        }),
      /SQLite|DB_CLIENT/i
    );

    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(
        () => sqliteDb.assertSqliteAllowed(),
        (err) => err && err.code === 'SQLITE_PROHIBITED_IN_PRODUCTION'
      );
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });
});
