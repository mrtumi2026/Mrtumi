'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

test('Admin Ads Analytics: EJS form contains hidden _csrf field', () => {
  const filePath = path.join(__dirname, '..', 'views', 'admin', 'ads-analytics.ejs');
  const template = fs.readFileSync(filePath, 'utf8');

  // Verify template contains the hidden _csrf input inside the settings save form
  assert.match(
    template,
    /<form[^>]*action="\/admin\/settings\/save"[^>]*>[\s\S]*?<input[^>]*name="_csrf"[^>]*value="<%=\s*csrfToken\s*%>"/,
    'ads-analytics.ejs form must include hidden _csrf input with csrfToken value'
  );

  // Render check with mock data
  const mockLocals = {
    channel: 'overview',
    adSettings: { fb_ads_spend: 15000, google_ads_spend: 7000, tiktok_ads_spend: 4000 },
    fbOrders: { c: 10, rev: 25000 },
    directOrders: { c: 5, rev: 12000 },
    otherOrders: { c: 2, rev: 5000 },
    csrfToken: 'test-secure-csrf-token-12345',
    adminUser: { id: 1, name: 'Admin', role: 'admin' },
    isEn: false,
    t: (k) => k,
  };

  // Compile check ensures no syntax errors
  assert.doesNotThrow(() => {
    ejs.compile(template, { filename: filePath });
  });
});

test('Admin Orders: Bulk and Status Quick forms include hidden _csrf fields', () => {
  const filePath = path.join(__dirname, '..', 'views', 'admin', 'orders.ejs');
  const template = fs.readFileSync(filePath, 'utf8');

  assert.match(
    template,
    /<form[^>]*id="bulkOrderForm"[^>]*>[\s\S]*?<input[^>]*name="_csrf"/,
    'orders.ejs bulkOrderForm must include hidden _csrf input'
  );

  assert.match(
    template,
    /<form[^>]*action="\/admin\/order\/status-quick"[^>]*>[\s\S]*?<input[^>]*name="_csrf"/,
    'orders.ejs status-quick form must include hidden _csrf input'
  );

  assert.match(
    template,
    /<form[^>]*action="\/admin\/order\/delete\/<%= o\.id %>"[^>]*>[\s\S]*?<input[^>]*name="_csrf"/,
    'orders.ejs delete form must include hidden _csrf input'
  );
});
