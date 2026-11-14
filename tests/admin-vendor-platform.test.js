'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

test('Admin & Vendor Platform Consolidation Suite', async (t) => {
  await t.test('Admin vendor withdrawals in MySQL mode query MySQL and delegate decision to repository', () => {
    const adminOpsSource = fs.readFileSync(path.join(__dirname, '../src/routes/adminOperations.js'), 'utf8');
    
    // Verify GET /admin/vendor-withdrawals queries MySQL vendor_withdrawals
    assert.match(adminOpsSource, /FROM vendor_withdrawals vw/);
    assert.match(adminOpsSource, /customActionPrefix:\s*['"]\/admin\/vendor-withdrawals\/approve['"]/);
    assert.match(adminOpsSource, /customActionHideWhenPaid:\s*true/);

    // Verify POST /admin/vendor-withdrawals/approve/:id delegates to adminResellerCommerceRepository.decideWithdrawal
    assert.match(adminOpsSource, /adminResellerCommerceRepository\.decideWithdrawal\(\s*\{\s*partnerType:\s*['"]vendor['"],\s*requestId:\s*req\.params\.id,\s*decision:\s*['"]approve['"]\s*\}/);

    // Verify POST /admin/vendor-withdrawals/delete/:id delegates reject decision
    assert.match(adminOpsSource, /adminResellerCommerceRepository\.decideWithdrawal\(\s*\{\s*partnerType:\s*['"]vendor['"],\s*requestId:\s*req\.params\.id,\s*decision:\s*['"]reject['"]/);
  });

  await t.test('Admin reseller withdrawals in MySQL mode query MySQL and delegate decision to repository', () => {
    const adminOpsSource = fs.readFileSync(path.join(__dirname, '../src/routes/adminOperations.js'), 'utf8');

    // Verify GET /admin/reseller-withdrawals queries MySQL reseller_transactions
    assert.match(adminOpsSource, /FROM reseller_transactions rt/);
    assert.match(adminOpsSource, /tx_type\s*=\s*['"]withdrawal['"]/);
    assert.match(adminOpsSource, /customActionPrefix:\s*['"]\/admin\/reseller-tx\/approve['"]/);
    assert.match(adminOpsSource, /customActionHideWhenPaid:\s*true/);

    // Verify POST /admin/reseller-tx/approve/:id delegates to adminResellerCommerceRepository.decideWithdrawal
    assert.match(adminOpsSource, /adminResellerCommerceRepository\.decideWithdrawal\(\s*\{\s*partnerType:\s*['"]reseller['"],\s*requestId:\s*req\.params\.id,\s*decision:\s*['"]approve['"]\s*\}/);
  });

  await t.test('Admin vendor verification and soft-deactivation in MySQL mode update database with audit trails', () => {
    const adminOpsSource = fs.readFileSync(path.join(__dirname, '../src/routes/adminOperations.js'), 'utf8');

    // Verify verify endpoint updates lifecycle_status and records audit log
    assert.match(adminOpsSource, /UPDATE vendors SET verified = 1, lifecycle_status = 'active', status = 1 WHERE id = \?/);
    assert.match(adminOpsSource, /'vendor\.verified'/);

    // Verify delete endpoint soft deactivates instead of hard deleting
    assert.match(adminOpsSource, /UPDATE vendors SET status = 0, lifecycle_status = 'deactivated' WHERE id = \?/);
    assert.match(adminOpsSource, /'vendor\.deactivated'/);
  });

  await t.test('Admin reseller verification and suspension in MySQL mode delegate to repository', () => {
    const adminOpsSource = fs.readFileSync(path.join(__dirname, '../src/routes/adminOperations.js'), 'utf8');

    // Verify verify endpoint calls setResellerStatus with approve
    assert.match(adminOpsSource, /adminResellerCommerceRepository\.setResellerStatus\(req\.params\.id,\s*['"]approve['"],\s*actor\(req\)\)/);

    // Verify delete endpoint calls setResellerStatus with suspend
    assert.match(adminOpsSource, /adminResellerCommerceRepository\.setResellerStatus\(req\.params\.id,\s*['"]suspend['"],\s*actor\(req\)\)/);
  });

  await t.test('Admin product form POST in MySQL mode redirects safely with informative flash message', () => {
    const adminCatalogSource = fs.readFileSync(path.join(__dirname, '../src/routes/adminCatalog.js'), 'utf8');

    assert.match(adminCatalogSource, /if\s*\(mysqlMode\(\)\)\s*\{\s*if\s*\(req\.file\)\s*upload\.safeUnlink\(req\.file\.path\);\s*req\.flash\('info'/);
  });

  await t.test('crud-module template hides action button when customActionHideWhenPaid is set and record is paid/approved', () => {
    const templatePath = path.join(__dirname, '../views/admin/crud-module.ejs');
    const templateSource = fs.readFileSync(templatePath, 'utf8');

    // Compile template with mock data
    const mockPendingRow = { id: 1, shop_name: 'Fresh Farm', amount: 500, status: 'pending' };
    const mockPaidRow = { id: 2, shop_name: 'Organic Hub', amount: 1200, status: 'paid' };
    const mockApprovedRow = { id: 3, shop_name: 'Green Grocer', amount: 800, status: 'approved' };

    const renderOpts = (rows) => ({
      pageTitle: 'Withdrawals',
      subtitle: 'Manage',
      columns: [
        { key: 'id', label: '#' },
        { key: 'shop_name', label: 'Shop' },
        { key: 'amount', label: 'Amount', type: 'currency' },
        { key: 'status', label: 'Status', type: 'badge' }
      ],
      fields: [],
      rows,
      customActionPrefix: '/admin/vendor-withdrawals/approve',
      customActionLabel: 'Approve',
      customActionHideWhenPaid: true,
      csrfToken: 'test-csrf-token',
      createAction: null,
      deletePrefix: null,
      updatePrefix: null,
      publicLinkPrefix: null,
      t: (key) => key,
      fmt: { bdt: (v) => `৳${v}`, number: (v) => String(v) },
      locale: 'en',
      siteSettings: { site_name: 'Mr. Tumi', favicon: '/favicon.ico' },
      brand: { isPlaceholderLogo: false },
      adminUser: { name: 'Admin', role: 'superadmin' },
      hasPermission: () => true,
      pendingOrdersCount: 0,
      pendingOrdersList: [],
      pendingReviewsCount: 0,
      flash: null,
    });

    const pendingHtml = ejs.render(templateSource, renderOpts([mockPendingRow]), { filename: templatePath });
    assert.ok(pendingHtml.includes('/admin/vendor-withdrawals/approve/1'), 'Pending row must have approve button');

    const paidHtml = ejs.render(templateSource, renderOpts([mockPaidRow]), { filename: templatePath });
    assert.ok(!paidHtml.includes('/admin/vendor-withdrawals/approve/2'), 'Paid row must not have approve button');

    const approvedHtml = ejs.render(templateSource, renderOpts([mockApprovedRow]), { filename: templatePath });
    assert.ok(!approvedHtml.includes('/admin/vendor-withdrawals/approve/3'), 'Approved row must not have approve button');
  });
});
