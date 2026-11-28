'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');
const { DICTIONARIES } = require('../src/i18n');

test('Customer wishlist i18n keys are present in both Bengali and English dictionaries', () => {
  const bn = DICTIONARIES.bn.common;
  const en = DICTIONARIES.en.common;
  assert.ok(bn.wishlist, 'bn.common.wishlist should exist');
  assert.ok(en.wishlist, 'en.common.wishlist should exist');
  assert.equal(bn.wishlist, 'পছন্দের তালিকা');
  assert.equal(en.wishlist, 'Wishlist');
  assert.equal(bn.addToWishlist, 'পছন্দে যোগ করুন');
  assert.equal(en.addToWishlist, 'Add to Wishlist');
  assert.equal(bn.removeFromWishlist, 'পছন্দ থেকে মুছুন');
  assert.equal(en.removeFromWishlist, 'Remove from Wishlist');
  assert.equal(bn.emptyWishlist, 'আপনার পছন্দের তালিকা খালি');
  assert.equal(en.emptyWishlist, 'Your wishlist is empty');
});

test('Customer wishlist view renders empty state cleanly with localized copy', () => {
  const templatePath = path.join(__dirname, '..', 'views', 'customer', 'wishlist.ejs');
  assert.ok(fs.existsSync(templatePath), 'views/customer/wishlist.ejs must exist');
  const template = fs.readFileSync(templatePath, 'utf8');

  // Verify key elements and classes in template
  assert.match(template, /My Wishlist|আমার পছন্দের তালিকা/);
  assert.match(template, /table-responsive/);
  assert.match(template, /formaction="\/customer\/account\/wishlist\/remove"|action="\/customer\/account\/wishlist\/remove"/);
  assert.match(template, /action="\/cart\/add"/);
});

// Owner decision (Nov 2026): no separate wishlist yet. Items are kept in the cart and ticked when ordering.
test('Storefront does not offer a separate wishlist, and wishlist addresses open the cart', () => {
  for (const file of ['store/partials/header.ejs', 'store/product.ejs', 'customer/account.ejs']) {
    const content = fs.readFileSync(path.join(__dirname, '..', 'views', file), 'utf8');
    assert.doesNotMatch(content, /\/customer\/account\/wishlist/, `${file} must not link to the wishlist`);
  }
  const account = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'customerAccount.js'), 'utf8');
  assert.match(account, /router\.get\("\/customer\/account\/wishlist", \(req, res\) => res\.redirect\("\/cart"\)\)/);
});

test('Storefront router includes /wishlist alias redirect', () => {
  const storefrontRouterPath = path.join(__dirname, '..', 'src', 'routes', 'storefront.js');
  const content = fs.readFileSync(storefrontRouterPath, 'utf8');
  assert.match(content, /router\.get\('\/wishlist'/, 'Storefront router should have /wishlist route');
});

test('Customer account router contains wishlist routes with CSRF protection on mutations', () => {
  const accountRouterPath = path.join(__dirname, '..', 'src', 'routes', 'customerAccount.js');
  const content = fs.readFileSync(accountRouterPath, 'utf8');
  assert.match(content, /router\.get\(['"]\/customer\/account\/wishlist['"]/, 'Wishlist GET route must be registered');
  assert.match(content, /router\.post\(['"]\/customer\/account\/wishlist\/add['"],\s*requireCsrf/, 'Wishlist add route must require CSRF');
  assert.match(content, /router\.post\(['"]\/customer\/account\/wishlist\/remove['"],\s*requireCsrf/, 'Wishlist remove route must require CSRF');
});
