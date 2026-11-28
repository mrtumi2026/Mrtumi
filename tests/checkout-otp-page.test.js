'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// Found on the live site: a partial siteSettings object hid the logo, page name and the OTP step.
test('the checkout page receives the full site settings, so the OTP step can appear', () => {
  const routes = read('src/routes/storefront.js');
  assert.match(routes, /siteSettings: \{ \.\.\.res\.locals\.siteSettings, free_shipping_min: 0 \}/);
  assert.doesNotMatch(routes, /siteSettings: \{ free_shipping_min: 0 \}/);
});

test('quick order, which has no OTP step, is replaced by checkout while order OTP is on', () => {
  const footer = read('views/store/partials/footer.ejs');
  assert.match(footer, /quickOrderNeedsOtp = siteSettings\.otp_mode === 'on'/);
  assert.match(footer, /id="qoDirectOrderBox" <%= quickOrderNeedsOtp \? 'hidden' : '' %>/);
});
