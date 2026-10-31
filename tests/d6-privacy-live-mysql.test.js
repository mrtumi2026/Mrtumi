'use strict';
/** D6 lifecycle integration against the disposable MySQL/MariaDB CI database only. */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const host = String(process.env.MYSQL_TEST_HOST || '').trim();
const required = process.env.MYSQL_TEST_REQUIRED === 'true';
const skipReason = 'SKIPPED locally: no disposable MySQL/MariaDB service; required in exact database CI.';
if (required && !host) throw new Error('MYSQL_TEST_REQUIRED=true, but MYSQL_TEST_HOST was not provided.');
process.env.NODE_ENV = 'test'; process.env.LOG_SILENT = 'true';
if (host) { process.env.DB_CLIENT='mysql'; process.env.DB_HOST=host; process.env.DB_PORT=String(process.env.MYSQL_TEST_PORT||3306); process.env.DB_NAME=process.env.MYSQL_TEST_DB||'mrtumi_test'; process.env.DB_USER=process.env.MYSQL_TEST_USER||'mrtumi_test'; process.env.DB_PASSWORD=process.env.MYSQL_TEST_PASSWORD||'mrtumi_test_pw'; }
const { getPool, createQueryClient, closePool } = require('../src/db/mysqlPool');
const { migrateUp, migrateDown } = require('../src/db/migrator');
const customers = require('../src/repositories/customerRepository');
const privacy = require('../src/repositories/privacyRepository');

describe('D6 privacy lifecycle MySQL/MariaDB integration', { skip: !host && !required ? skipReason : false }, () => {
  let db;
  before(async () => { if (!host) return; const pool=getPool(); db=createQueryClient(pool); await migrateDown(pool,{steps:13}); await migrateUp(pool); });
  after(async () => { if (host) await closePool(); });
  test('policy acceptance, consent history, owned requests, deletion review, anonymization, recovery single-use/expiry and rollback', async t => {
    if(!host)return t.skip(skipReason);
    const suffix=crypto.randomBytes(6).toString('hex');
    const email=`d6-${suffix}@example.invalid`, phone=`017${String(Date.now()).slice(-8)}`;
    const customer=await customers.registerCustomer({name:'D6 Customer',phone,password:'d6-test-password-long',email,policyVersion:'1.0',evidence:{ip:'127.0.0.1',userAgent:'d6-ci'}});
    const acceptance=await privacy.listPolicyAcceptances(customer.id);
    assert.equal(acceptance[0].policy_version,'1.0'); assert.equal(acceptance[0].source,'registration');
    const addressId=await customers.saveAddress(customer.id,{label:'Home',recipient_name:'D6 Customer',recipient_phone:phone,division:'Dhaka',district:'Dhaka',upazila:'Dhanmondi',street_address:'CI fixture address',is_default:'1'},{ip:'127.0.0.1',userAgent:'d6-ci'});
    await customers.deleteAddress(customer.id,addressId,{ip:'127.0.0.1',userAgent:'d6-ci'});
    assert.ok(await db.queryOne("SELECT id FROM audit_logs WHERE actor_id=? AND action='customer.address.deleted' AND entity_id=?",[customer.id,String(addressId)]));
    await privacy.recordPolicyAcceptance(customer.id,'1.0',{ip:'127.0.0.1'},null,'policy_update');
    assert.equal((await privacy.listPolicyAcceptances(customer.id)).length,2);
    await privacy.setConsent(customer.id,'marketing','grant',{ip:'127.0.0.1'});
    const withdrawalId=await privacy.createPrivacyRequest(customer.id,{request_type:'consent_withdrawal',consent_key:'marketing'});
    await privacy.reviewPrivacyRequest(withdrawalId,'approve','Optional marketing withdrawal approved.',{id:1,type:'admin'});
    assert.deepEqual((await privacy.listConsentHistory(customer.id)).map(x=>x.action),['withdrawn','granted']);
    assert.equal(Number((await db.queryOne('SELECT granted FROM customer_consent_current WHERE customer_id=? AND consent_key=\'marketing\'',[customer.id])).granted),0);
    const accessId=await privacy.createPrivacyRequest(customer.id,{request_type:'access',customer_message:'My data'});
    await assert.rejects(()=>privacy.getCustomerRequest(customer.id+1,accessId),(e)=>e.code==='NOT_FOUND');
    assert.equal((await privacy.getCustomerRequest(customer.id,accessId)).status,'pending');
    const correctionId=await privacy.createPrivacyRequest(customer.id,{request_type:'correction',requested_data:{name:'D6 Corrected Customer'},customer_message:'Correct my display name'});
    await privacy.reviewPrivacyRequest(correctionId,'approve','Verified customer correction request.',{id:1,type:'admin'});
    await privacy.applyCorrection(correctionId,{name:'D6 Corrected Customer'},'Identity verified; corrected the account name.',{id:1,type:'admin'});
    assert.equal((await customers.getProfile(customer.id)).name,'D6 Corrected Customer');
    await privacy.updateRetentionSetting('customer_account',{retention_days:'730',manual_review_required:'1',notes:'Configured period; still no automatic purge.'},{id:1,type:'admin'});
    assert.equal(Number((await privacy.listRetentionSettings()).find(x=>x.category_key==='customer_account').retention_days),730);
    const historyBefore=(await privacy.listConsentHistory(customer.id)).length;
    const trigger=`d6_fail_audit_${suffix}`;
    await db.execute(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_logs FOR EACH ROW BEGIN IF NEW.action='privacy.consent.granted' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='intentional D6 audit rollback'; END IF; END`);
    try { await assert.rejects(()=>privacy.setConsent(customer.id,'analytics','grant',{ip:'127.0.0.1'})); }
    finally { await db.execute(`DROP TRIGGER IF EXISTS ${trigger}`); }
    assert.equal((await privacy.listConsentHistory(customer.id)).length,historyBefore,'failed audit must roll back the consent state/event transaction');
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM customer_consent_current WHERE customer_id=? AND consent_key=\'analytics\'',[customer.id])).n),0);

    const deletionId=await privacy.createPrivacyRequest(customer.id,{request_type:'deletion',customer_message:'Please review'});
    await assert.rejects(()=>privacy.anonymizeCustomer(deletionId,'not approved',{id:1,type:'admin'}),(e)=>e.code==='CONFLICT');
    await privacy.reviewPrivacyRequest(deletionId,'approve','Manual review approved after preserving order and financial evidence.',{id:1,type:'admin'});
    const reviewed=await privacy.getAdminRequest(deletionId); assert.equal(reviewed.status,'approved'); assert.ok(reviewed.reviewer_user_id);

    // Recovery remains disabled in the product route. Repository token behavior is exercised only
    // with an injected fake delivery and a test-only verified contact timestamp.
    await db.execute('UPDATE customers SET phone_verified_at=CURRENT_TIMESTAMP WHERE id=?',[customer.id]);
    let issued;
    await customers.issueCustomerRecovery(phone,'phone',async message=>{issued=message;});
    assert.ok(issued?.token);
    await customers.consumeCustomerRecoveryToken(issued.token,'a-new-d6-password-long');
    await assert.rejects(()=>customers.consumeCustomerRecoveryToken(issued.token,'another-new-password-long'),(e)=>e.code==='VALIDATION_ERROR');
    await customers.issueCustomerRecovery(phone,'phone',async message=>{issued=message;});
    const tokenHash=crypto.createHash('sha256').update(issued.token).digest('hex');
    await db.execute('UPDATE customer_recovery_tokens SET expires_at=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 1 MINUTE) WHERE token_hash=?',[tokenHash]);
    await assert.rejects(()=>customers.consumeCustomerRecoveryToken(issued.token,'a-third-d6-password-long'),(e)=>e.code==='VALIDATION_ERROR');

    await privacy.anonymizeCustomer(deletionId,'Approved with retained order/financial evidence.',{id:1,type:'admin'});
    const anonymized=await db.queryOne('SELECT status,phone,email FROM customers WHERE id=?',[customer.id]);
    assert.equal(Number(anonymized.status),0); assert.equal(anonymized.phone,`removed-${customer.id}`); assert.equal(anonymized.email,null);

    const before=Number((await db.queryOne('SELECT COUNT(*) AS n FROM privacy_policy_versions'))?.n||0);
    await assert.rejects(()=>privacy.createPolicy({version:'1.0',title_bn:'dup',title_en:'dup',content_bn:'dup',content_en:'dup'},{id:1,type:'admin'}));
    assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM privacy_policy_versions'))?.n||0),before,'failed policy create and its audit write must roll back together');
  });
});
