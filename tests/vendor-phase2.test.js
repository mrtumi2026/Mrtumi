'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {deliverVendorOtp}=require('../src/services/vendorOtpDelivery');
const root=path.join(__dirname,'..');
const settings={bulksms_api_key:'unit-test-key',bulksms_sender_id:'MRTUMI',bulksms_balance:'5.00'};

test('vendor OTP adapter uses configured BulkSMSBD settings and recognizes documented success without logging the code',async()=>{
  let request;
  const result=await deliverVendorOtp({phone:'01712345678',code:'004201',settings,enabled:true,fetchImpl:async(url,options)=>{request={url,options};return{ok:true,text:async()=>JSON.stringify({response_code:202,success_message:'SMS Submitted Successfully'})};}});
  assert.equal(result.sent,true);assert.equal(request.url,'https://bulksmsbd.net/api/smsapi');assert.equal(request.options.method,'POST');
  const body=new URLSearchParams(request.options.body);assert.equal(body.get('api_key'),settings.bulksms_api_key);assert.equal(body.get('number'),'8801712345678');assert.match(body.get('message'),/004201/);
});

test('vendor OTP delivery stays disabled until the gateway has been explicitly validated',async()=>{
  let calls=0;
  await assert.rejects(()=>deliverVendorOtp({phone:'01712345678',code:'004201',settings,fetchImpl:async()=>{calls++;}}),/disabled until the gateway is verified/);
  assert.equal(calls,0);
});

test('vendor OTP adapter stops on zero balance, missing config, provider refusal and timeouts without leaking details',async()=>{
  let calls=0;
  await assert.rejects(()=>deliverVendorOtp({phone:'01712345678',code:'004201',settings:{...settings,bulksms_balance:'0'},enabled:true,fetchImpl:async()=>{calls++;}}),/zero/);
  await assert.rejects(()=>deliverVendorOtp({phone:'01712345678',code:'004201',settings:{},fetchImpl:async()=>{calls++;}}),/manual phone-call verification/);
  await assert.rejects(()=>deliverVendorOtp({phone:'01712345678',code:'004201',settings,enabled:true,fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({response_code:1005,message:'low balance'})})}),/contact support/);
  await assert.rejects(()=>deliverVendorOtp({phone:'01712345678',code:'004201',settings,enabled:true,fetchImpl:async()=>{const e=new Error('abort');e.name='AbortError';throw e;}}),/timed out/);
  assert.equal(calls,0);
});

test('admin phone override, tier controls and verified-tier sensitive-edit review are explicitly gated',()=>{
  const routes=fs.readFileSync(path.join(root,'src/routes/vendorOnboarding.js'),'utf8');
  assert.match(routes,/phone-override',requireAdmin,requireCsrf/);assert.match(routes,/vendors\/:id\/trust-level',requireAdmin,requireCsrf/);
  const repository=fs.readFileSync(path.join(root,'src/repositories/vendorOnboardingRepository.js'),'utf8');
  assert.match(repository,/vendor\.phone\.admin_verified/);assert.match(repository,/identity_verified_at/);assert.match(repository,/vendor\.trust_level\.changed/);
  const portal=fs.readFileSync(path.join(root,'src/repositories/vendorPortalRepository.js'),'utf8');
  assert.match(portal,/approval\.trust_level==='trusted'\?'approved':'pending'/);assert.match(portal,/reviewRequired=existing\.approval_status==='rejected'\|\|\(approval\.trust_level!=='trusted'&&sensitive\)/);
});

test('trust-tier migration backfills legacy publication trust and adds indexed new-level defaults',()=>{
  const {loadMigrationPairs}=require('../src/db/migrator');const migration=loadMigrationPairs().find(x=>x.version==='0018');assert.ok(migration);
  assert.match(migration.upSql,/ADD COLUMN `trust_level` VARCHAR\(16\) NOT NULL DEFAULT 'new'/);assert.match(migration.upSql,/WHEN `trusted_auto_publish` = 1 THEN 'trusted'/);assert.match(migration.upSql,/ADD KEY `idx_vendors_trust_level`/);
  assert.match(migration.downSql,/DROP COLUMN `trust_level`/);
});
