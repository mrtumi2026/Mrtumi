'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('storefront refresh keeps localized customer navigation, category search and the existing live cart contract', () => {
  const header = read('views/store/partials/header.ejs');
  const footer = read('views/store/partials/footer.ejs');
  const js = read('public/frontEnd/js/storefront.js');
  const bn = require('../src/i18n/locales/bn');
  const en = require('../src/i18n/locales/en');
  const desktopNav = header.split('<!-- Category & Storefront Navigation Strip -->')[1].split('</nav>')[0];
  const mobileDrawer = header.split('id="mobileStoreNavDrawer"')[1];
  assert.equal(bn.store.searchPlaceholder, 'পছন্দের পণ্য খুঁজুন...');
  assert.equal(en.store.searchPlaceholder, 'Search products...');
  assert.match(header, /action="\/all-products" method="GET"/);
  assert.match(header, /name="q"/);
  assert.match(header, /placeholder="<%= t\('store\.searchPlaceholder'\) %>"/);
  assert.doesNotMatch(desktopNav, /Grocery|Gift Items|গ্রোসারি|গিফট আইটেম/);
  assert.doesNotMatch(mobileDrawer, /href="\/all-products\?deal=gift"|Gift Items|গিফট আইটেম/);
  assert.match(header, /name="category"/);
  assert.match(header, /navCategories/);
  assert.match(header, /store-utility-bar/);
  assert.match(header, /t\('common\.trackOrder'\)/);
  assert.match(header, /store-cart-total/);
  assert.match(header, /js-cart-subtotal/);
  assert.match(footer, /store-mobile-bottom-nav/);
  assert.match(footer, /data-bs-target="#miniCartDrawer"/);
  assert.match(footer, /data-bs-target="#mobileStoreNavDrawer"/);
  assert.match(js, /querySelectorAll\('\.js-cart-count'\)/);
  assert.match(js, /querySelectorAll\('\.js-cart-subtotal'\)/);
  assert.match(js, /initProductSearchSuggestions/);
  assert.match(js, /}, 300\)/);
  assert.match(js, /\/api\/search-suggestions\?q=/);
});

test('search suggestions query only active products with bound terms and return a limited localized price projection', async () => {
  const repository = require('../src/repositories/storefrontRepository');
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    return [[{ id: '4', name: 'Fresh fruit', slug: 'fresh-fruit', image: '/uploads/product/fruit.jpg', price: '125.5' }], []];
  } };
  const suggestions = await repository.getSearchSuggestions('fruit', 'en', pool);
  assert.equal(suggestions.length, 1);
  assert.deepEqual(suggestions[0], { id: 4, name: 'Fresh fruit', slug: 'fresh-fruit', image: '/uploads/product/fruit.jpg', price: 125.5, formatted_price: '৳125.5' });
  assert.match(calls[0].sql, /p\.status=1 AND p\.is_archived=0/);
  assert.match(calls[0].sql, /p\.approval_status='approved'/);
  assert.match(calls[0].sql, /LIMIT 5/);
  assert.deepEqual(calls[0].params, ['en', '%fruit%', '%fruit%', '%fruit%']);
  assert.deepEqual(await repository.getSearchSuggestions('x', 'en', pool), []);
});

test('homepage and product card provide the accessible hero, trust, discount, stock and direct cart/order affordances', () => {
  const home = read('views/store/home.ejs');
  const header = read('views/store/partials/header.ejs');
  const card = read('views/store/partials/product-card.ejs');
  const css = read('public/frontEnd/css/storefront.css');
  const authMiddleware = read('src/middleware/auth.js');
  const storefrontRoutes = read('src/routes/storefront.js');
  const storefrontRepository = read('src/repositories/storefrontRepository.js');
  assert.match(authMiddleware, /res\.locals\.mysqlCheckoutEnabled = typeof res\.locals\.mysqlCheckoutEnabled === 'boolean'/);
  assert.match(storefrontRoutes, /router\.get\('\/api\/search-suggestions', publicFormLimiter/);
  assert.match(storefrontRepository, /async function getSearchSuggestions/);
  assert.match(home, /store-hero-layout/);
  assert.match(home, /store-category-card/);
  assert.match(home, /id="heroCategoryMenu"/);
  assert.match(home, /hero-category-link/);
  assert.doesNotMatch(home, /categoriesTitle|categoriesSub|Shop by Category Grid/);
  assert.match(header, /id="mobileStoreNavDrawer"/);
  assert.match(header, /store-all-categories-button/);
  assert.match(storefrontRoutes, /res\.render\('store\/home',\s*\{\s*\.\.\.homeData/);
  assert.match(home, /store-hero-promos/);
  assert.match(home, /store-trust-row/);
  assert.match(home, /data-countdown=/);
  assert.match(card, /js-add-to-cart/);
  assert.match(card, /js-quick-order/);
  assert.match(card, /role="meter"/);
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
});
