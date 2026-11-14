'use strict';

process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'mysql';
process.env.LOG_SILENT = 'true';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const resellerPortal = require('../src/repositories/resellerPortalRepository');

function fakePool(responses) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const result = typeof responses === 'function' ? responses(sql, params) : responses;
      return [result, []];
    }
  };
}

describe('Reseller Portal Consolidation Suite', () => {
  test('resellerPortal.getProfile computes available and pending balances in BDT and paisa', async () => {
    const pool = fakePool((sql, params) => {
      assert.match(sql, /LEFT JOIN partner_wallets/);
      assert.match(sql, /COALESCE\(w\.available_balance, r\.balance_paisa, 0\) AS available_balance_paisa/);
      assert.match(sql, /COALESCE\(w\.pending_balance, 0\) AS pending_balance_paisa/);
      return [{
        id: 15,
        name: 'Target Reseller',
        shop_name: 'Super Shop',
        phone: '01711002233',
        email: 'reseller@test.com',
        balance_paisa: 50000,
        available_balance_paisa: 50000,
        pending_balance_paisa: 15000,
        deposit_paisa: 20000,
        verified: 1,
        status: 1,
        created_at: new Date('2026-01-01')
      }];
    });

    const profile = await resellerPortal.getProfile(15, pool);
    assert.equal(profile.id, 15);
    assert.equal(profile.balance, 500);
    assert.equal(profile.available_balance, 500);
    assert.equal(profile.pending_balance, 150);
    assert.equal(profile.deposit_amount, 200);
    assert.equal(profile.balance_paisa, 50000);
    assert.equal(profile.available_balance_paisa, 50000);
    assert.equal(profile.pending_balance_paisa, 15000);
  });

  test('resellerPortal.getDashboardSummary calculates delivered order margin earnings', async () => {
    const pool = fakePool((sql, params) => {
      assert.match(sql, /total_earned_paisa/);
      assert.match(sql, /reseller_margin_paisa/);
      assert.deepEqual(params, [15]);
      return [{
        total_orders: 12,
        delivered_orders: 8,
        pending_orders: 4,
        total_earned_paisa: 75000
      }];
    });

    const summary = await resellerPortal.getDashboardSummary(15, pool);
    assert.equal(summary.total_orders, 12);
    assert.equal(summary.delivered_orders, 8);
    assert.equal(summary.pending_orders, 4);
    assert.equal(summary.total_earned_paisa, 75000);
  });

  test('resellerPortal.getOrderDetails selects courier code, tracking ID, and reseller margin', async () => {
    const pool = fakePool((sql, params) => {
      if (sql.includes('FROM orders WHERE id=? AND reseller_id=?')) {
        assert.match(sql, /courier_code/);
        assert.match(sql, /courier_tracking_id/);
        assert.match(sql, /reseller_margin_paisa/);
        return [{
          id: 42,
          invoice_id: 'INV-42',
          customer_name: 'Customer A',
          phone: '01811223344',
          address: 'Mirpur, Dhaka',
          status: 'pending',
          payment_method: 'COD',
          payment_status: 'unpaid',
          total_paisa: 120000,
          paid_paisa: 0,
          cod_due_paisa: 120000,
          reseller_margin_paisa: 25000,
          courier_code: 'steadfast',
          courier_tracking_id: 'ST-998877',
          created_at: new Date('2026-02-01')
        }];
      }
      return [{
        product_name: 'Premium Honey',
        product_image: '/uploads/honey.jpg',
        unit_price_paisa: 120000,
        qty: 1,
        line_total_paisa: 120000,
        size_label: '1kg',
        color_label: null
      }];
    });

    const details = await resellerPortal.getOrderDetails(15, 42, pool);
    assert.equal(details.order.id, 42);
    assert.equal(details.order.courier_code, 'steadfast');
    assert.equal(details.order.courier_tracking_id, 'ST-998877');
    assert.equal(details.order.reseller_margin_paisa, 25000);
    assert.equal(details.items.length, 1);
  });

  test('views/reseller/wallet.ejs renders withdrawal form with balances in canonical mode', () => {
    const templatePath = path.resolve(__dirname, '../views/reseller/wallet.ejs');
    const templateSource = fs.readFileSync(templatePath, 'utf8');

    const renderOpts = (mode, reseller) => ({
      mode,
      canonicalWallet: true,
      reseller,
      transactions: [],
      pagination: { total: 0, page: 1, totalPages: 1 },
      transactionType: '',
      csrfToken: 'mock-csrf-token-xyz',
      t: (key) => key,
      fmt: { bdt: (v) => `৳${v}`, number: (v) => String(v) },
      locale: 'bn',
      siteSettings: { site_name: 'Mr. Tumi', favicon: '/favicon.ico' },
      brand: { isPlaceholderLogo: false },
      resellerUser: reseller,
      flash: null,
      allowOrderCreation: true,
      allowFinancialMutations: true
    });

    const withdrawalHtml = ejs.render(templateSource, renderOpts('withdrawal', {
      phone: '01711002233',
      balance: 1500,
      available_balance: 1500,
      pending_balance: 300,
      deposit_amount: 500
    }), { filename: templatePath });

    assert.ok(withdrawalHtml.includes('action="/reseller/withdrawals/create"'), 'Must have withdrawal form action');
    assert.ok(withdrawalHtml.includes('name="trx_id"'), 'Must have phone/account input');
    assert.ok(withdrawalHtml.includes('name="amount"'), 'Must have amount input');
    assert.ok(withdrawalHtml.includes('value="mock-csrf-token-xyz"'), 'Must contain CSRF token');
    assert.ok(withdrawalHtml.includes('1,500'), 'Must display available balance');
    assert.ok(withdrawalHtml.includes('300'), 'Must display pending balance');

    const depositHtml = ejs.render(templateSource, renderOpts('deposit', {
      deposit_amount: 500,
      balance: 1500
    }), { filename: templatePath });

    assert.ok(depositHtml.includes('অনলাইন সিকিউরিটি ডিপোজিট'), 'Must contain security deposit message');
  });

  test('src/routes/resellerPanel.js declares CSRF-guarded cancel route and active order creation', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/routes/resellerPanel.js'), 'utf8');

    assert.match(source, /router\.post\('\/reseller\/orders\/:id\/cancel',\s*requireCsrf/);
    assert.match(source, /phase08Repository\.transitionOrder/);
    assert.match(source, /res\.locals\.allowOrderCreation\s*=\s*true/);
    assert.match(source, /res\.locals\.allowFinancialMutations\s*=\s*true/);
  });
});
