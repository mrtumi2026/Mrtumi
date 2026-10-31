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
});

test('homepage and product card provide the accessible hero, trust, discount, stock and direct cart/order affordances', () => {
  const home = read('views/store/home.ejs');
  const card = read('views/store/partials/product-card.ejs');
  const css = read('public/frontEnd/css/storefront.css');
  assert.match(home, /store-hero-layout/);
  assert.match(home, /store-hero-categories/);
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
