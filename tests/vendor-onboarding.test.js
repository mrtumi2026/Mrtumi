'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const policy=require('../src/repositories/vendorOnboardingPolicy');
const {loadMigrationPairs}=require('../src/db/migrator');
const root=path.join(__dirname,'..');

test('vendor lifecycle requires all activation gates and only authorized transitions',()=>{
  const complete={lifecycle_status:'approved',phone_verified_at:'1',identity_verified_at:'1',onboarding_completed_at:'1',commission_configured_at:'1',commission_rate_bps:850,payout_verified_at:'1'};
  assert.deepEqual(policy.assertActivationRequirements(complete),{approved:true,phoneVerified:true,identityVerified:true,onboardingComplete:true,commissionAssigned:true,payoutVerified:true});
  for(const missing of ['phone_verified_at','identity_verified_at','onboarding_completed_at','commission_configured_at','payout_verified_at'])assert.throws(()=>policy.assertActivationRequirements({...complete,[missing]:null}),{code:'CONFLICT'});
  assert.throws(()=>policy.assertActivationRequirements({...complete,commission_rate_bps:0}),{code:'CONFLICT'});
  assert.equal(policy.nextStatus('pending','under_review'),'under_review');
  assert.equal(policy.nextStatus('suspended','active'),'active');
  assert.throws(()=>policy.nextStatus('pending','active'),{code:'CONFLICT'});
  assert.equal(policy.mayPublish({lifecycle_status:'active',status:1}),true);
  assert.equal(policy.mayPublish({lifecycle_status:'suspended',status:1}),false);
  assert.equal(policy.mayWithdraw({lifecycle_status:'active',status:1,payout_verified_at:'1'}),true);
  assert.equal(policy.mayWithdraw({lifecycle_status:'active',status:1,payout_verified_at:null}),false);
});

test('vendor onboarding migration adds private PII, payout, OTP, lifecycle history and rollback dependencies',()=>{
  const migration=loadMigrationPairs().find(x=>x.version==='0017');assert.ok(migration);
  for(const pattern of [/CREATE TABLE IF NOT EXISTS `vendor_applications`/,/UNIQUE KEY `uq_vendor_application_nid_hash`/,/CREATE TABLE IF NOT EXISTS `vendor_status_history`/,/CREATE TABLE IF NOT EXISTS `vendor_phone_otps`/,/CREATE TABLE IF NOT EXISTS `vendor_payout_accounts`/,/payout_account_id/])assert.match(migration.upSql,pattern);
  assert.ok(migration.upSql.indexOf('CREATE TABLE IF NOT EXISTS `vendor_payout_accounts`')<migration.upSql.indexOf('ADD CONSTRAINT `fk_vendor_withdrawals_payout_account`'));
  assert.match(migration.downSql,/DROP FOREIGN KEY `fk_vendor_withdrawals_payout_account`/);
  assert.match(migration.downSql,/DROP TABLE IF EXISTS `vendor_payout_accounts`/);
});

test('vendor PII encryption is authenticated, deterministic duplicate hashes are private, and no key fails closed',()=>{
  const old=process.env.VENDOR_PII_KEY;process.env.VENDOR_PII_KEY=Buffer.alloc(32,7).toString('base64');
  const pii=require('../src/utils/vendorPii');const cipher=pii.encryptVendorPii('1987654321');
  assert.notEqual(cipher,'1987654321');assert.equal(pii.decryptVendorPii(cipher),'1987654321');
  assert.equal(pii.hashVendorPii('1987654321'),pii.hashVendorPii(' 1987654321 '));
  assert.equal(pii.maskAccount('01712345678').endsWith('5678'),true);
  const corrupted=cipher.slice(0,-2)+'AA';assert.throws(()=>pii.decryptVendorPii(corrupted));
  delete require.cache[require.resolve('../src/utils/vendorPii')];delete process.env.VENDOR_PII_KEY;
  const noKey=require('../src/utils/vendorPii');assert.throws(()=>noKey.encryptVendorPii('1234567890'),{code:'VALIDATION_ERROR'});
  if(old===undefined)delete process.env.VENDOR_PII_KEY;else process.env.VENDOR_PII_KEY=old;
});

test('OTP invalid-attempt update commits before the conflict is raised',()=>{
  const source=fs.readFileSync(path.join(root,'src/repositories/vendorOnboardingRepository.js'),'utf8');
  const fn=source.slice(source.indexOf('async function verifyPhoneOtp'),source.indexOf('async function getVendorApplication'));
  assert.match(fn,/UPDATE vendor_phone_otps SET attempts=attempts\+1/);
  assert.match(fn,/return\{error:'The verification code is incorrect\.'\}/);
  assert.match(fn,/if\(outcome\.error\)throw new ConflictError/);
  assert.ok(fn.indexOf('return{error:')<fn.indexOf('if(outcome.error)throw new ConflictError'));
});

test('onboarding routes and product/order entry points enforce private review and active-vendor gates',()=>{
  const routes=fs.readFileSync(path.join(root,'src/routes/vendorOnboarding.js'),'utf8');
  assert.match(routes,/router\.post\('\/vendor\/onboarding\/resubmit',requireVendor,vendorRegistrationLimiter,parseApplicationUpload/);assert.match(routes,/router\.get\('\/admin\/vendor-applications\/:id\/documents\/:kind',requireAdmin/);assert.match(routes,/admin\/vendor-applications\/:id\/documents\/:kind/);assert.match(routes,/Cache-Control':'private, no-store/);
  const checkout=fs.readFileSync(path.join(root,'src/repositories/checkoutRepository.js'),'utf8');
  assert.match(checkout,/owner\.lifecycle_status!=='active'/);
  const reservation=fs.readFileSync(path.join(root,'src/repositories/phase08Repository.js'),'utf8');
  assert.match(reservation,/owner\.lifecycle_status!=='active'/);
  const portal=fs.readFileSync(path.join(root,'src/repositories/vendorPortalRepository.js'),'utf8');
  assert.match(portal,/Only active vendors can submit or edit products/);
  const withdrawals=fs.readFileSync(path.join(root,'src/repositories/partnerWithdrawalRepository.js'),'utf8');
  assert.match(withdrawals,/lifecycle_status!=='active'/);assert.match(withdrawals,/payout_account_id/);
});
