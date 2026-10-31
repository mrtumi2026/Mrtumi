'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const phase08 = require('../src/repositories/phase08Repository');
const { loadMigrationPairs, splitSqlStatements } = require('../src/db/migrator');
const { requirePermission } = require('../src/middleware/rbac');
const { requireCsrf, deriveCsrfToken } = require('../src/middleware/csrf');

test('Phase 08 order view gets state constants from route locals, never require() inside EJS', () => {
  const templatePath = path.join(__dirname, '..', 'views', 'admin', 'phase08-orders.ejs');
  const routePath = path.join(__dirname, '..', 'src', 'routes', 'phase08Admin.js');
  const template = fs.readFileSync(templatePath, 'utf8');
  const route = fs.readFileSync(routePath, 'utf8');
  assert.doesNotMatch(template, /require\s*\(/);
  assert.match(template, /Object\.keys\(transitions\)/);
  assert.match(route, /transitions:repo\.TRANSITIONS/);
});

test('Phase 08 state machine blocks invalid and terminal transitions', () => {
  assert.deepEqual(phase08.TRANSITIONS.pending, ['confirmed', 'cancelled', 'failed']);
  assert.deepEqual(phase08.TRANSITIONS.cancelled, []);
  assert.deepEqual(phase08.TRANSITIONS.returned, []);
  assert.deepEqual(phase08.TRANSITIONS.return_requested, ['returned'], 'return completion requires inspected dispositions in the transactional repository guard');
});
test('OTP policy validates expiry, attempt and cooldown bounds', () => {
  assert.deepEqual(phase08.validateOtpPolicy({ enabled:true, expirySeconds:120, maxAttempts:4, cooldownSeconds:45 }), { enabled:true, expirySeconds:120, maxAttempts:4, cooldownSeconds:45, maxPerHour:5 });
  assert.throws(() => phase08.validateOtpPolicy({ expirySeconds:30 }), { code:'VALIDATION_ERROR' });
  assert.throws(() => phase08.validateOtpPolicy({ maxAttempts:0 }), { code:'VALIDATION_ERROR' });
  assert.throws(() => phase08.validateOtpPolicy({ cooldownSeconds:5 }), { code:'VALIDATION_ERROR' });
});
test('advance-payment math uses integer paisa and honors order limits', () => {
  assert.equal(phase08.calculateAdvance(10501, { mode:'percent', value:20 }), 2100);
  assert.equal(phase08.calculateAdvance(1000, { mode:'fixed', value:2500 }), 1000);
  assert.equal(phase08.calculateAdvance(1000, { mode:'fixed', value:300, minimumPaisa:1200 }), 0);
  assert.equal(phase08.calculateAdvance(5000, { mode:'off', value:0 }), 0);
  assert.throws(() => phase08.calculateAdvance(5000, { mode:'percent', value:101 }), { code:'VALIDATION_ERROR' });
});
test('OTP generation produces six digits and stored verifier digest is not plaintext', () => {
  const code = phase08.makeOtp();
  assert.match(code, /^\d{6}$/);
  assert.notEqual(phase08.otpDigest('01712345678', code), code);
  assert.equal(phase08.otpDigest('01712345678', code), phase08.otpDigest('01712345678', code));
  assert.notEqual(phase08.otpDigest('01712345678', code), phase08.otpDigest('01812345678', code));
});
test('incomplete checkout persists nothing without explicit consent', async () => {
  assert.deepEqual(await phase08.recordIncompleteCheckout({ consent:false }), { recorded:false, reason:'consent_required' });
});
test('COD/advance calculation rejects overpayment and keeps exact paisa boundaries', () => {
  assert.deepEqual(phase08.computeOrderPayment(10_501, 1_000, {mode:'percent',value:20}), {totalPaisa:10_501,paidPaisa:1_000,requiredAdvancePaisa:2_100,advanceDuePaisa:1_100,codDuePaisa:9_501});
  assert.equal(phase08.calculateAdvance(Number.MAX_SAFE_INTEGER,{mode:'percent',value:100}),Number.MAX_SAFE_INTEGER);
  assert.throws(()=>phase08.computeOrderPayment(1000,1001,{mode:'off'}),{code:'VALIDATION_ERROR'});
  assert.throws(()=>phase08.validateAdvancePolicy({mode:'percent',value:10,minimumPaisa:1000,maximumPaisa:999}),{code:'VALIDATION_ERROR'});
});
test('checkout capture strips all client price fields and validates bounded product identifiers', () => {
  assert.deepEqual(phase08.normalizeCaptureCart([{product_id:'9',qty:'2',price:999999},{id:3,quantity:1,unit_price_paisa:1}]),[{product_id:3,variant_id:null,qty:1},{product_id:9,variant_id:null,qty:2}]);
  assert.throws(()=>phase08.normalizeCaptureCart([{product_id:1,qty:100}]),{code:'VALIDATION_ERROR'});
});
test('Phase 08 migration 0006 is a paired additive migration with nullable unique idempotency keys', () => {
  const pair=loadMigrationPairs().find(p=>p.version==='0006');
  assert.ok(pair);
  assert.ok(splitSqlStatements(pair.upSql).length>0);
  assert.ok(splitSqlStatements(pair.downSql).length>0);
  assert.match(pair.upSql,/ADD COLUMN `request_key` VARCHAR\(128\) DEFAULT NULL/);
  assert.match(pair.upSql,/ADD UNIQUE KEY `uq_refunds_request_key`/);
  assert.match(pair.upSql,/CREATE TABLE IF NOT EXISTS `refund_status_history`/);
  assert.match(pair.downSql,/DROP INDEX `uq_refunds_request_key`/);
  assert.match(pair.downSql,/ADD CONSTRAINT `fk_order_otps_order`/);
});
test('Checkout request-hash migration is additive and reversible', () => {
  const pair=loadMigrationPairs().find(p=>p.version==='0007');
  assert.ok(pair);
  assert.match(pair.upSql,/checkout_request_hash.*CHAR\(64\).*DEFAULT NULL/s);
  assert.match(pair.downSql,/DROP COLUMN `checkout_request_hash`/);
});
test('Phase 08 admin action permission keys deny absent grants and allow an explicit grant', () => {
  const guard=requirePermission('refunds.review');
  let denied;
  guard({adminUser:{role_slug:'support',permissions:['orders.manage']}}, {}, err=>{denied=err;});
  assert.equal(denied.code,'FORBIDDEN');
  let allowed=false;
  guard({adminUser:{role_slug:'finance',permissions:['refunds.review']}}, {}, err=>{assert.equal(err,undefined);allowed=true;});
  assert.equal(allowed,true);
});
test('Phase 08 write guard requires CSRF even when admin permission exists', () => {
  const sid='phase08-csrf-session';
  const req={method:'POST',session:{_csrfNonce:'nonce'},sessionID:sid,body:{},headers:{}};
  let error;
  requireCsrf(req,{},err=>{error=err;});
  assert.equal(error.statusCode,403);
  req.body._csrf=deriveCsrfToken(sid,'nonce');
  let passed=false;
  requireCsrf(req,{},err=>{assert.equal(err,undefined);passed=true;});
  assert.equal(passed,true);
});
