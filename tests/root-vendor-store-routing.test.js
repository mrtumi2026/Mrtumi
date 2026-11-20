'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const { RESERVED_SLUGS, SLUG_REGEX, isReservedRoute, validateVendorSlug } = require('../src/utils/vendorSlug');
const storefrontRepo = require('../src/repositories/storefrontRepository');

const root = path.join(__dirname, '..');

test('RESERVED_SLUGS includes all critical system and platform routes', () => {
  const critical = [
    'admin', 'admins', 'vendor', 'vendors', 'reseller', 'resellers', 'customer', 'customers',
    'api', 'cart', 'checkout', 'login', 'register', 'logout', 'store', 'stores',
    'category', 'categories', 'subcategory', 'childcategory', 'brand', 'brands',
    'product', 'products', 'robots.txt', 'sitemap.xml', 'favicon.ico', 'order', 'orders',
    'track-order', 'campaign', 'flash-sales', 'hot-deals', 'faq', 'about', 'contact',
    'affiliate', 'wishlist', 'feed', 'fulfillment', 'payment', 'settings'
  ];

  for (const slug of critical) {
    assert.strictEqual(isReservedRoute(slug), true, `Reserved route "${slug}" must be reserved`);
    const val = validateVendorSlug(slug);
    assert.strictEqual(val.valid, false, `validateVendorSlug must reject reserved route "${slug}"`);
  }
});

test('Valid vendor slugs are accepted while invalid formats are rejected', () => {
  const valid = ['green-grocers', 'dhaka-fresh', 'pure-honey', 'store-101', 'organic-farm'];
  for (const slug of valid) {
    assert.strictEqual(SLUG_REGEX.test(slug), true, `"${slug}" should match SLUG_REGEX`);
    assert.strictEqual(isReservedRoute(slug), false, `"${slug}" must not be reserved`);
    const val = validateVendorSlug(slug);
    assert.strictEqual(val.valid, true, `validateVendorSlug must accept "${slug}"`);
  }

  const invalid = ['green_grocers', 'DhakaFresh', 'pure honey', 'store/101', 'a', 'a-'];
  for (const slug of invalid) {
    const val = validateVendorSlug(slug);
    assert.strictEqual(val.valid, false, `validateVendorSlug must reject invalid format "${slug}"`);
  }
});

test('storefront.js redirects legacy /store/:slug to root /:slug with 301 Permanent Redirect', async () => {
  const fileContent = fs.readFileSync(path.join(root, 'src/routes/storefront.js'), 'utf8');

  // Verify legacy route redirects with 301
  assert.match(fileContent, /router\.get\(\s*['"]\/store\/:slug['"]/);
  assert.match(fileContent, /res\.redirect\(301,\s*`\/\$\{encodeURIComponent\(rawSlug\)\}\$\{queryStr\}`\)/);
});

test('storefront.js registers root /:slug route at the end of router with reserved checks', () => {
  const fileContent = fs.readFileSync(path.join(root, 'src/routes/storefront.js'), 'utf8');

  // Verify /:slug is handled
  assert.match(fileContent, /router\.get\(\s*['"]\/:slug['"]/);
  // Verify safety checks pass to next()
  assert.match(fileContent, /if\s*\(!rawSlug\s*\|\|\s*!SLUG_REGEX\.test\(rawSlug\)\s*\|\|\s*isReservedRoute\(rawSlug\)\)\s*\{\s*return next\(\);/);
});

test('sitemap.xml emits root-level vendor store URLs without /store/ prefix', () => {
  const fileContent = fs.readFileSync(path.join(root, 'src/routes/storefront.js'), 'utf8');
  assert.match(fileContent, /\(entries\.stores\s*\|\|\s*\[\]\)\.map\(\(s\)\s*=>\s*`\$\{baseUrl\}\/\$\{encodeURIComponent\(s\.slug\)\}`\)/);
  assert.doesNotMatch(fileContent, /\(entries\.stores\s*\|\|\s*\[\]\)\.map\(\(s\)\s*=>\s*`\$\{baseUrl\}\/store\/\$\{encodeURIComponent\(s\.slug\)\}`\)/);
});

test('Views use canonical root-level vendor store URLs without /store/ prefix', () => {
  const productCard = fs.readFileSync(path.join(root, 'views/store/partials/product-card.ejs'), 'utf8');
  assert.match(productCard, /href="\/<%= p\.vendor_store_slug %>"/);
  assert.doesNotMatch(productCard, /href="\/store\/<%= p\.vendor_store_slug %>"/);

  const productDetail = fs.readFileSync(path.join(root, 'views/store/product.ejs'), 'utf8');
  assert.match(productDetail, /href="\/<%= product\.vendor_store_slug %>"/);
  assert.doesNotMatch(productDetail, /href="\/store\/<%= product\.vendor_store_slug %>"/);

  const vendorStore = fs.readFileSync(path.join(root, 'views/store/vendor-store.ejs'), 'utf8');
  assert.match(vendorStore, /actionPath\s*:\s*\('\/'\s*\+\s*vendor\.slug\)/);
  assert.doesNotMatch(vendorStore, /actionPath\s*:\s*\('\/store\/'\s*\+\s*vendor\.slug\)/);

  const vendorProfile = fs.readFileSync(path.join(root, 'views/vendor/profile.ejs'), 'utf8');
  assert.match(vendorProfile, /href="\/<%= vendor\.slug \|\| \('store-' \+ vendor\.id\) %>"/);
  assert.match(vendorProfile, /mrtumi\.com\//);
  assert.doesNotMatch(vendorProfile, /mrtumi\.com\/store\//);

  const adminVendors = fs.readFileSync(path.join(root, 'views/admin/vendors-mysql.ejs'), 'utf8');
  assert.match(adminVendors, /href="\/<%= v\.slug %>"/);
  assert.doesNotMatch(adminVendors, /href="\/store\/<%= v\.slug %>"/);
});
