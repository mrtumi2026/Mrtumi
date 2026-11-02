'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');

test('reseller MySQL order creation uses canonical pricing, transaction, reservation and audit paths',()=>{
  const repository=read('src/repositories/resellerOrderRepository.js');
  assert.match(repository,/mysql\.withTransaction\(async tx/);
  assert.match(repository,/SELECT id,verified,status FROM resellers WHERE id=\? FOR UPDATE/);
  assert.match(repository,/wholesale_price_paisa/);
  assert.match(repository,/reserveOrderInventoryTx\(tx,Number\(order\.insertId\)/);
  assert.match(repository,/reseller_margin_paisa/);
  assert.match(repository,/checkout_request_hash/);
  assert.match(repository,/audit_logs/);
  const routes=read('src/routes/resellerPanel.js');
  assert.match(routes,/resellerOrderRepository\.create/);
  assert.match(routes,/requireCsrf, async/);
  assert.match(read('views/reseller/order-create.ejs'),/name="request_key"/);
});

test('reseller profit is credited transactionally only at delivery and deduplicated by the order ledger reference',()=>{
  const phase08=read('src/repositories/phase08Repository.js');
  assert.match(phase08,/target === 'delivered' && order\.reseller_id/);
  assert.match(phase08,/reference_order_id=\? AND tx_type='profit'/);
  assert.match(phase08,/UPDATE resellers SET balance_paisa=balance_paisa\+\?/);
  assert.match(phase08,/INSERT INTO reseller_transactions/);
  assert.match(phase08,/order\.status\.\$\{target\}/);
});

test('vendor variants reserve and consume their own stock pool without aggregate warehouse checks',()=>{
  const checkout=read('src/repositories/checkoutRepository.js');
  const phase08=read('src/repositories/phase08Repository.js');
  assert.doesNotMatch(checkout,/Vendor product variants are not supported/);
  assert.doesNotMatch(phase08,/Variant reservations for vendor-stock products are not supported/);
  assert.match(phase08,/if \(!line\.variantId\) \{/);
  assert.match(phase08,/UPDATE product_variants SET stock_on_hand=stock_on_hand-\?,stock_reserved=stock_reserved-\?/);
});

test('vendor registration and withdrawal list use MySQL repositories while the SQLite safeguard remains intact',()=>{
  const vendorRoutes=read('src/routes/vendorPanel.js');
  const vendorRepo=read('src/repositories/vendorPortalRepository.js');
  assert.match(vendorRoutes,/vendorPortal\.register\(/);
  assert.match(vendorRepo,/async function register\(/);
  assert.match(vendorRoutes,/listVendorWithdrawals/);
  assert.match(read('src/repositories/partnerWithdrawalRepository.js'),/async function listVendorWithdrawals/);
  assert.match(read('src/db/database.js'),/assertSqliteAllowed/);
});
