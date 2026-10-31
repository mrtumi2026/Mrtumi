'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const d7=require('../src/repositories/d7Repository');
const phase08=require('../src/repositories/phase08Repository');
const migrator=require('../src/db/migrator');
const routes=fs.readFileSync(require.resolve('../src/routes/d7Admin'),'utf8');
const customerRoutes=fs.readFileSync(require.resolve('../src/routes/customerAccount'),'utf8');
const migration=migrator.loadMigrationPairs().find(row=>row.version==='0013');
test('D7 migration adds cancellation, item return inspection, history and settlement evidence with reversible pair',()=>{
 assert.ok(migration);for(const table of ['order_cancellation_requests','return_category_policies','customer_return_requests','customer_return_items','customer_return_events','vendor_settlement_batches','vendor_settlement_items','vendor_financial_adjustments'])assert.ok(migration.upSql.includes('CREATE TABLE IF NOT EXISTS `'+table+'`'));
 assert.match(migration.downSql,/DROP TABLE IF EXISTS `customer_return_items`/);assert.match(migration.upSql,/InnoDB/);assert.doesNotMatch(migration.upSql,/FLOAT|DOUBLE/i);
});
test('commission and return transition validators use bounded integer basis points and states',()=>{
 assert.equal(d7.validateCommissionBps(1250),1250);for(const value of [-1,10001,1.2,'NaN'])assert.throws(()=>d7.validateCommissionBps(value),{code:'VALIDATION_ERROR'});
 assert.deepEqual(phase08.TRANSITIONS.return_requested,['returned']);assert.ok(phase08.TRANSITIONS.processing.includes('cancelled'));
});
test('customer and admin D7 mutations are ownership-, permission- and CSRF-protected',()=>{
 assert.match(customerRoutes,/d7\.cancelOrder\(req\.params\.id,req\.session\.customerUser\.id/);
 assert.match(customerRoutes,/d7\.requestReturn\(req\.session\.customerUser\.id,req\.params\.id/);
 assert.match(routes,/requirePermission\('returns\.review'\),requireCsrf/);
 assert.match(routes,/requirePermission\('settings\.manage'\),requireCsrf/);
 assert.match(routes,/requirePermission\('settlements\.prepare'\),requireCsrf/);
 assert.match(routes,/requirePermission\('settlements\.approve'\),requireCsrf/);
});
test('returns never restock until approved inspection and vendor/product ownership match',()=>{
 const source=fs.readFileSync(require.resolve('../src/repositories/d7Repository'),'utf8');
 assert.match(source,/!\['approved','inspected'\]\.includes\(request\.status\)/);
 assert.match(source,/product\.vendor_id\|\|0\)!==Number\(line\.vendor_id\|\|0\)/);
 assert.match(source,/movement_type,qty_delta,balance_after/);
 assert.match(source,/disposition==='restock'/);
});
test('responsive CSS contracts contain admin tables, controls and layouts at narrow widths',()=>{
 const design=fs.readFileSync(require('node:path').join(__dirname,'../public/shared/css/mrtumi-design-system.css'),'utf8');
 const d7css=fs.readFileSync(require('node:path').join(__dirname,'../public/shared/css/d7-workflows.css'),'utf8');
 const storefront=fs.readFileSync(require('node:path').join(__dirname,'../public/frontEnd/css/storefront.css'),'utf8');
 assert.match(design,/\.table-responsive[\s\S]*?overflow-x:\s*auto/);assert.match(design,/max-width:\s*100%/);
 assert.match(d7css,/@media\s*\(max-width:767\.98px\)/);assert.match(d7css,/min-width:0/);assert.match(storefront,/@media\s*\(max-width: 767px\)/);
});
test('refund and settlement surfaces keep execution and unsupported reseller entitlements disabled',()=>{
 const customer=fs.readFileSync(require.resolve('../src/routes/customerAccount'),'utf8');
 const phase08Source=fs.readFileSync(require.resolve('../src/repositories/phase08Repository'),'utf8');
 assert.match(customer,/COD refunds are disabled until a verified destination/);
 assert.match(phase08Source,/refunds\.approve_high/);
 assert.match(phase08Source,/provider processing is not available here/);
 const reseller=fs.readFileSync(require.resolve('../src/routes/resellerPanel'),'utf8');
 assert.match(reseller,/reseller-order pricing, stock allocation/);
 assert.match(reseller,/wallet reconciliation, review/);
});
