'use strict';

const crypto=require('node:crypto');
const bcrypt=require('bcryptjs');
const {env}=require('../config/env');
const mysql=require('../db/mysqlPool');
const {requirePositiveInt,requireString,normalizeBdPhone}=require('../utils/validator');
const {ValidationError,ConflictError,NotFoundError}=require('../utils/errors');
const pii=require('../utils/vendorPii');
const policy=require('./vendorOnboardingPolicy');

function assertMysql(){if(env.db.client!=='mysql')throw new Error('Vendor onboarding requires MySQL/InnoDB.');}
function text(value,label,max,required=true){return requireString(value,label,{min:required?1:0,max});}
function email(value){const result=text(value,'Email',191).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))throw new ValidationError('Enter a valid email address.');return result;}
function normalizeNid(value){const nid=String(value||'').replace(/[\s-]/g,'');if(!/^(?:\d{10}|\d{13}|\d{17})$/.test(nid))throw new ValidationError('NID must contain 10, 13, or 17 digits.');return nid;}
function business(input){const type=text(input.business_type,'Business type',32);if(!['individual','sole_proprietor','registered_company'].includes(type))throw new ValidationError('Choose a valid business type.');const trade=text(input.trade_license_document||'','trade license document',128,false);if(type!=='individual'&&!trade)throw new ValidationError('Trade license is required for registered businesses.');return{type,trade:trade||null};}
function actorInfo(actor={}){return{type:String(actor.type||'admin'),id:actor.id||null,ip:String(actor.ip||'').slice(0,64),userAgent:String(actor.userAgent||'').slice(0,255)};}
async function audit(tx,actor,action,vendorId,before,after){const a=actorInfo(actor);await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?,?)',[a.type,a.id,action,'vendor',String(vendorId),before?JSON.stringify(before):null,JSON.stringify(after),a.ip,a.userAgent]);}
async function history(tx,vendorId,from,to,reason,actor){const a=actorInfo(actor);await tx.execute('INSERT INTO vendor_status_history(vendor_id,from_status,to_status,reason,actor_type,actor_id) VALUES(?,?,?,?,?,?)',[vendorId,from||'',to,reason||'',a.type,a.id]);}
async function auditSensitiveAccess(vendorId,resource,actor,{pool}={}){assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID'),name=String(resource||'').trim().slice(0,64);return mysql.withTransaction(async tx=>{const vendor=await tx.queryOne('SELECT id FROM vendors WHERE id=? FOR UPDATE',[id]);if(!vendor)throw new NotFoundError('Vendor not found.');await audit(tx,actor,'vendor.private_data.viewed',id,null,{resource:name});return{vendorId:id,resource:name};},{pool});}
async function tryActivate(tx,vendorId){
  const vendor=await tx.queryOne('SELECT id,status,lifecycle_status,phone_verified_at,identity_verified_at,onboarding_completed_at,commission_configured_at,payout_verified_at,commission_rate_bps FROM vendors WHERE id=? FOR UPDATE',[vendorId]);
  if(!vendor)throw new NotFoundError('Vendor not found.');
  if(vendor.lifecycle_status!=='approved'&&vendor.lifecycle_status!=='suspended')return vendor;
  try{policy.assertActivationRequirements(vendor);}catch(error){if(error.code==='CONFLICT')return vendor;throw error;}
  if(vendor.lifecycle_status==='approved'){
    await tx.execute("UPDATE vendors SET lifecycle_status='active',status=1,verified=1 WHERE id=?",[vendorId]);
    await history(tx,vendorId,'approved','active','All required activation checks completed',{type:'system'});
    await audit(tx,{type:'system'},'vendor.activated',vendorId,{lifecycle_status:'approved'},{lifecycle_status:'active'});
    return{...vendor,lifecycle_status:'active',verified:1};
  }
  return vendor;
}
async function register(input,documents,{pool}={}){
  assertMysql();
  const shop=text(input.shop_name,'Shop name',191),owner=text(input.owner_name,'Owner name',191),phone=normalizeBdPhone(input.phone),mail=email(input.email),address=text(input.address,'Shop address',1000),district=text(input.district,'District',100),upazila=text(input.upazila,'Upazila',100),category=text(input.business_category,'Business category',100),nid=normalizeNid(input.nid_number),kind=business({business_type:input.business_type,trade_license_document:documents.trade_license||''});
  if(!input.terms_accepted)throw new ValidationError('Accept the vendor onboarding terms to continue.');
  if(!documents.nid_front||!documents.nid_back||!documents.shop_logo)throw new ValidationError('NID front, NID back, and shop logo images are required.');
  const password=String(input.password||'');if(password.length<10||Buffer.byteLength(password,'utf8')>72)throw new ValidationError('Password must contain at least 10 characters and no more than 72 UTF-8 bytes.');
  const passwordHash=await bcrypt.hash(password,12),nidCipher=pii.encryptVendorPii(nid),nidHash=pii.hashVendorPii(nid);
  try{return await mysql.withTransaction(async tx=>{
    const duplicate=await tx.queryOne('SELECT id FROM vendors WHERE phone=? OR email=? LIMIT 1 FOR UPDATE',[phone,mail]);
    if(duplicate)throw new ConflictError('A vendor account already exists for this phone or email.');
    const duplicateNid=await tx.queryOne('SELECT vendor_id FROM vendor_applications WHERE nid_hash=? LIMIT 1 FOR UPDATE',[nidHash]);
    if(duplicateNid)throw new ConflictError('This NID is already associated with a vendor application.');
    const result=await tx.execute("INSERT INTO vendors(shop_name,owner_name,phone,email,address,password_hash,commission_rate_bps,balance_paisa,verified,status,lifecycle_status) VALUES(?,?,?,?,?,?,0,0,0,1,'pending')",[shop,owner,phone,mail,address,passwordHash]);
    const id=Number(result.insertId);
    await tx.execute('INSERT INTO vendor_applications(vendor_id,business_type,business_category,district,upazila,nid_ciphertext,nid_hash,nid_front_document,nid_back_document,trade_license_document,shop_logo_document) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,kind.type,category,district,upazila,nidCipher,nidHash,documents.nid_front,documents.nid_back,kind.trade,documents.shop_logo]);
    await history(tx,id,'','pending','Vendor application submitted',{type:'vendor',id});
    await audit(tx,{type:'vendor',id},'vendor.application.submitted',id,null,{lifecycle_status:'pending',business_type:kind.type,district,upazila,nid_last4:nid.slice(-4)});
    return{id,shop_name:shop,owner_name:owner,phone,email:mail,lifecycle_status:'pending'};
  },{pool,isolationLevel:'SERIALIZABLE'});}catch(error){if(error.code==='DB_DUPLICATE_ENTRY')throw new ConflictError('A vendor account or NID application already exists.');throw error;}
}
async function resubmitApplication(vendorId,input,documents,actor={type:'vendor'}, {pool}={}){
  assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID'),shop=text(input.shop_name,'Shop name',191),owner=text(input.owner_name,'Owner name',191),mail=email(input.email),address=text(input.address,'Shop address',1000),district=text(input.district,'District',100),upazila=text(input.upazila,'Upazila',100),category=text(input.business_category,'Business category',100),nid=normalizeNid(input.nid_number),kind=business({business_type:input.business_type,trade_license_document:documents.trade_license||''});
  if(!input.terms_accepted)throw new ValidationError('Accept the vendor onboarding terms to continue.');
  if(!documents.nid_front||!documents.nid_back||!documents.shop_logo)throw new ValidationError('NID front, NID back, and shop logo images are required.');
  const nidCipher=pii.encryptVendorPii(nid),nidHash=pii.hashVendorPii(nid);
  return mysql.withTransaction(async tx=>{
    const vendor=await tx.queryOne('SELECT id,phone,email,lifecycle_status FROM vendors WHERE id=? FOR UPDATE',[id]);if(!vendor)throw new NotFoundError('Vendor not found.');
    if(!['action_required','rejected'].includes(vendor.lifecycle_status))throw new ConflictError('Resubmission is available only after requested changes or rejection.');
    const application=await tx.queryOne('SELECT nid_hash,resubmission_count FROM vendor_applications WHERE vendor_id=? FOR UPDATE',[id]);if(!application)throw new NotFoundError('Vendor application not found.');
    const duplicate=await tx.queryOne('SELECT id FROM vendors WHERE email=? AND id<>? LIMIT 1 FOR UPDATE',[mail,id]);if(duplicate)throw new ConflictError('This email is already used by another vendor.');
    const duplicateNid=await tx.queryOne('SELECT vendor_id FROM vendor_applications WHERE nid_hash=? AND vendor_id<>? LIMIT 1 FOR UPDATE',[nidHash,id]);if(duplicateNid)throw new ConflictError('This NID is already associated with another vendor application.');
    const next=vendor.lifecycle_status==='rejected'?'pending':'under_review';policy.nextStatus(vendor.lifecycle_status,next);
    await tx.execute('UPDATE vendors SET shop_name=?,owner_name=?,email=?,address=?,lifecycle_status=?,identity_verified_at=NULL,verified=0,status=1 WHERE id=?',[shop,owner,mail,address,next,id]);
    await tx.execute('UPDATE vendor_applications SET business_type=?,business_category=?,district=?,upazila=?,nid_ciphertext=?,nid_hash=?,nid_front_document=?,nid_back_document=?,trade_license_document=?,shop_logo_document=?,resubmission_count=resubmission_count+1 WHERE vendor_id=?',[kind.type,category,district,upazila,nidCipher,nidHash,documents.nid_front,documents.nid_back,kind.trade,documents.shop_logo,id]);
    await history(tx,id,vendor.lifecycle_status,next,'Vendor resubmitted requested application information',{type:'vendor',id});
    await audit(tx,{type:'vendor',id},'vendor.application.resubmitted',id,{lifecycle_status:vendor.lifecycle_status,resubmission_count:Number(application.resubmission_count)},{lifecycle_status:next,resubmission_count:Number(application.resubmission_count)+1,nid_last4:nid.slice(-4)});
    return{vendorId:id,lifecycle_status:next};
  },{pool,isolationLevel:'SERIALIZABLE'});
}

async function issuePhoneOtp(vendorId,{deliver,pool}={}){
  assertMysql();if(typeof deliver!=='function')throw new ConflictError('Phone OTP delivery is not configured; no code was sent.');
  const id=requirePositiveInt(vendorId,'Vendor ID'),code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  const challenge=await mysql.withTransaction(async tx=>{
    const vendor=await tx.queryOne('SELECT id,phone,phone_verified_at,status,lifecycle_status FROM vendors WHERE id=? FOR UPDATE',[id]);
    if(!vendor||Number(vendor.status)!==1)throw new NotFoundError('Vendor account not found.');
    if(vendor.phone_verified_at)return{verified:true};
    const limits=await tx.queryOne('SELECT COUNT(*) AS n FROM vendor_phone_otps WHERE vendor_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR)',[id]);
    if(Number(limits.n)>=5)throw new ConflictError('OTP issue limit reached. Try again later.');
    const recent=await tx.queryOne('SELECT id FROM vendor_phone_otps WHERE vendor_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 60 SECOND) ORDER BY id DESC LIMIT 1',[id]);
    if(recent)throw new ConflictError('Please wait before requesting another verification code.');
    await tx.execute('UPDATE vendor_phone_otps SET expires_at=UTC_TIMESTAMP() WHERE vendor_id=? AND verified_at IS NULL',[id]);
    const otpHash=pii.hashVendorPii(`${vendor.phone}:${code}`);
    const inserted=await tx.execute('INSERT INTO vendor_phone_otps(vendor_id,phone,otp_hash,expires_at) VALUES(?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 5 MINUTE))',[id,vendor.phone,otpHash]);
    await audit(tx,{type:'vendor',id},'vendor.phone.otp_issued',id,null,{phone_last4:vendor.phone.slice(-4),expires_in_seconds:300});
    return{vendorId:id,phone:vendor.phone,code,challengeId:Number(inserted.insertId)};
  },{pool});
  if(challenge.verified)return{verified:true};
  try{await deliver({phone:challenge.phone,code:challenge.code,purpose:'vendor_registration'});}
  catch(error){await mysql.withTransaction(tx=>tx.execute('UPDATE vendor_phone_otps SET expires_at=UTC_TIMESTAMP() WHERE id=?',[challenge.challengeId]),{pool});throw new ConflictError('Could not deliver the verification code. No code was sent; try again later.');}
  return{sent:true,expiresInSeconds:300};
}
async function verifyPhoneOtp(vendorId,code,{pool,actor={type:'vendor'}}={}){
  assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID'),candidate=String(code||'').trim();if(!/^\d{6}$/.test(candidate))throw new ValidationError('Enter the six-digit OTP.');
  const outcome=await mysql.withTransaction(async tx=>{
    const vendor=await tx.queryOne('SELECT id,phone,phone_verified_at,status,lifecycle_status FROM vendors WHERE id=? FOR UPDATE',[id]);if(!vendor||Number(vendor.status)!==1)throw new NotFoundError('Vendor account not found.');if(vendor.phone_verified_at)return{verified:true,replayed:true};
    const challenge=await tx.queryOne('SELECT id,otp_hash,attempts,expires_at FROM vendor_phone_otps WHERE vendor_id=? AND phone=? AND verified_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE',[id,vendor.phone]);
    if(!challenge||new Date(challenge.expires_at).getTime()<=Date.now())return{error:'OTP has expired. Request a new code.'};
    if(Number(challenge.attempts)>=5)return{error:'Too many incorrect OTP attempts. Request a new code later.'};
    const expected=Buffer.from(challenge.otp_hash,'hex'),actual=Buffer.from(pii.hashVendorPii(`${vendor.phone}:${candidate}`),'hex');
    if(expected.length!==actual.length||!crypto.timingSafeEqual(expected,actual)){await tx.execute('UPDATE vendor_phone_otps SET attempts=attempts+1 WHERE id=?',[challenge.id]);return{error:'The verification code is incorrect.'};}
    await tx.execute('UPDATE vendor_phone_otps SET verified_at=UTC_TIMESTAMP() WHERE id=?',[challenge.id]);
    await tx.execute('UPDATE vendors SET phone_verified_at=UTC_TIMESTAMP() WHERE id=?',[id]);
    await audit(tx,actor,'vendor.phone.verified',id,null,{phone_verified:true});
    const activated=await tryActivate(tx,id);
    return{verified:true,replayed:false,lifecycle_status:activated.lifecycle_status};
  },{pool});
  if(outcome.error)throw new ConflictError(outcome.error);
  return outcome;
}

async function getVendorApplication(vendorId,{admin=false,pool}={}){
  assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID'),db=mysql.createQueryClient(pool||mysql.getPool());
  const row=await db.queryOne(`SELECT v.id,v.shop_name,v.owner_name,v.phone,v.email,v.address,v.lifecycle_status,v.status,v.verified,v.commission_rate_bps,v.phone_verified_at,v.identity_verified_at,v.onboarding_completed_at,v.commission_configured_at,v.payout_verified_at,v.trusted_auto_publish,v.created_at,a.id AS application_id,a.business_type,a.business_category,a.district,a.upazila,a.nid_ciphertext,a.nid_hash,a.nid_front_document,a.nid_back_document,a.trade_license_document,a.shop_logo_document,a.resubmission_count FROM vendors v JOIN vendor_applications a ON a.vendor_id=v.id WHERE v.id=?`,[id]);
  if(!row)throw new NotFoundError('Vendor application not found.');
  const result={...row,commission_rate_bps:Number(row.commission_rate_bps),verified:Number(row.verified),status:Number(row.status),trusted_auto_publish:Number(row.trusted_auto_publish),documents:{nid_front:row.nid_front_document,nid_back:row.nid_back_document,trade_license:row.trade_license_document,shop_logo:row.shop_logo_document}};
  delete result.nid_ciphertext;delete result.nid_hash;delete result.nid_front_document;delete result.nid_back_document;delete result.trade_license_document;delete result.shop_logo_document;
  if(admin){result.nid_number=pii.decryptVendorPii(row.nid_ciphertext);result.nid_last4=result.nid_number.slice(-4);}
  return result;
}
async function listApplications(statusInput='pending',{page=1,pool}={}){
  assertMysql();const status=String(statusInput||'pending');if(status&&!policy.VENDOR_STATUSES.includes(status))throw new ValidationError('Invalid vendor application status.');const pg=requirePositiveInt(page,'Page',{max:100000});const db=mysql.createQueryClient(pool||mysql.getPool());
  const rows=await db.queryAll(`SELECT v.id,v.shop_name,v.owner_name,v.lifecycle_status,v.created_at,a.business_type,a.business_category,a.district,a.upazila,a.resubmission_count FROM vendors v JOIN vendor_applications a ON a.vendor_id=v.id WHERE v.lifecycle_status=? ORDER BY v.created_at DESC,v.id DESC LIMIT 50 OFFSET ?`,[status,(pg-1)*50]);
  const total=await db.queryOne('SELECT COUNT(*) AS total FROM vendors v JOIN vendor_applications a ON a.vendor_id=v.id WHERE v.lifecycle_status=?',[status]);return{rows,total:Number(total?.total||0),page:pg,status};
}
async function getStatusHistory(vendorId,{pool}={}){assertMysql();return mysql.createQueryClient(pool||mysql.getPool()).queryAll('SELECT id,from_status,to_status,reason,actor_type,actor_id,created_at FROM vendor_status_history WHERE vendor_id=? ORDER BY id DESC',[requirePositiveInt(vendorId,'Vendor ID')]);}
async function transition(vendorId,targetInput,reasonInput,actor={}, {confirmIdentity=false,pool}={}){
  assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID'),target=String(targetInput||''),reason=text(reasonInput||'', 'Reason',1000,false);
  if(['rejected','action_required','suspended'].includes(target)&&reason.length<5)throw new ValidationError('A reason of at least 5 characters is required for this action.');
  return mysql.withTransaction(async tx=>{
    const vendor=await tx.queryOne('SELECT id,status,lifecycle_status,phone_verified_at,identity_verified_at,onboarding_completed_at,commission_configured_at,payout_verified_at,commission_rate_bps FROM vendors WHERE id=? FOR UPDATE',[id]);if(!vendor)throw new NotFoundError('Vendor not found.');
    policy.nextStatus(vendor.lifecycle_status,target);
    if(target==='approved'){
      if(!confirmIdentity)throw new ConflictError('Review the submitted identity documents and explicitly confirm identity verification.');
      await tx.execute('UPDATE vendors SET lifecycle_status=?,identity_verified_at=UTC_TIMESTAMP(),verified=0 WHERE id=?',[target,id]);
    }else if(target==='active'){
      policy.assertActivationRequirements(vendor);
      await tx.execute('UPDATE vendors SET lifecycle_status=?,verified=1,status=1 WHERE id=?',[target,id]);
    }else if(target==='deactivated')await tx.execute('UPDATE vendors SET lifecycle_status=?,status=0,verified=0 WHERE id=?',[target,id]);
    else await tx.execute('UPDATE vendors SET lifecycle_status=?,verified=0 WHERE id=?',[target,id]);
    await history(tx,id,vendor.lifecycle_status,target,reason,actor);
    await audit(tx,actor,`vendor.status.${target}`,id,{lifecycle_status:vendor.lifecycle_status},{lifecycle_status:target,reason});
    if(target==='approved')await tryActivate(tx,id);
    return{vendorId:id,from:vendor.lifecycle_status,to:target};
  },{pool});
}
async function assignCommission(vendorId,rateInput,autoPublishInput,actor={}, {pool}={}){
  assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID'),bps=Number(rateInput);if(!Number.isSafeInteger(bps)||bps<1||bps>10000)throw new ValidationError('Commission must be 1–10000 basis points (0.01%–100%).');const auto=Boolean(autoPublishInput);
  return mysql.withTransaction(async tx=>{const vendor=await tx.queryOne('SELECT id,lifecycle_status,commission_rate_bps,trusted_auto_publish,commission_configured_at FROM vendors WHERE id=? FOR UPDATE',[id]);if(!vendor)throw new NotFoundError('Vendor not found.');await tx.execute('UPDATE vendors SET commission_rate_bps=?,commission_configured_at=UTC_TIMESTAMP(),trusted_auto_publish=? WHERE id=?',[bps,auto?1:0,id]);await audit(tx,actor,'vendor.commission.assigned',id,{commission_rate_bps:Number(vendor.commission_rate_bps),trusted_auto_publish:Number(vendor.trusted_auto_publish)},{commission_rate_bps:bps,trusted_auto_publish:auto});const activated=await tryActivate(tx,id);return{vendorId:id,commission_rate_bps:bps,lifecycle_status:activated.lifecycle_status};},{pool});
}
async function savePayoutAccount(vendorId,input,actor={}, {pool}={}){
  assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID'),method=String(input.method||'').trim();if(!['bank','bkash','nagad'].includes(method))throw new ValidationError('Choose bank, bKash, or Nagad.');const holder=text(input.holder_name,'Account holder',191),rawAccount=text(input.account_number,'Account number',64),account=['bkash','nagad'].includes(method)?normalizeBdPhone(rawAccount,'payout mobile'):rawAccount,details={holder_name:holder,account_number:account};
  if(method==='bank'){details.bank_name=text(input.bank_name,'Bank name',191);details.branch=text(input.branch,'Branch',191);details.routing_number=text(input.routing_number||'','Routing number',32,false);}
  const cipher=pii.encryptVendorPii(JSON.stringify(details)),mask=pii.maskAccount(account);
  return mysql.withTransaction(async tx=>{const vendor=await tx.queryOne('SELECT id,phone_verified_at,lifecycle_status FROM vendors WHERE id=? AND status=1 FOR UPDATE',[id]);if(!vendor)throw new NotFoundError('Vendor account not found.');if(!vendor.phone_verified_at)throw new ConflictError('Verify your mobile number before adding payout details.');const result=await tx.execute("INSERT INTO vendor_payout_accounts(vendor_id,method,details_ciphertext,masked_account,verification_status) VALUES(?,?,?,?,'pending')",[id,method,cipher,mask]);await audit(tx,actor,'vendor.payout.submitted',id,null,{payout_account_id:Number(result.insertId),method,masked_account:mask,verification_status:'pending'});return{id:Number(result.insertId),method,masked_account:mask,verification_status:'pending'};},{pool});
}
async function listPayoutAccounts(vendorId,{pool}={}){assertMysql();return mysql.createQueryClient(pool||mysql.getPool()).queryAll('SELECT id,method,masked_account,verification_status,verification_reason,created_at,verified_at FROM vendor_payout_accounts WHERE vendor_id=? ORDER BY id DESC',[requirePositiveInt(vendorId,'Vendor ID')]);}
async function verifyPayoutAccount(accountId,statusInput,reasonInput,actor={}, {pool}={}){
  assertMysql();const id=requirePositiveInt(accountId,'Payout account ID'),status=String(statusInput||''),reason=text(reasonInput||'','Reason',1000,false);if(!['verified','rejected'].includes(status))throw new ValidationError('Payout verification status must be verified or rejected.');if(status==='rejected'&&reason.length<5)throw new ValidationError('Provide a rejection reason of at least 5 characters.');
  return mysql.withTransaction(async tx=>{const account=await tx.queryOne('SELECT id,vendor_id,verification_status,masked_account,method FROM vendor_payout_accounts WHERE id=? FOR UPDATE',[id]);if(!account)throw new NotFoundError('Payout account not found.');await tx.execute('UPDATE vendor_payout_accounts SET verification_status=?,verification_reason=?,verified_by_user_id=?,verified_at=IF(?=\'verified\',UTC_TIMESTAMP(),NULL) WHERE id=?',[status,reason,actor.id||null,status,id]);if(status==='verified')await tx.execute('UPDATE vendors SET payout_verified_at=UTC_TIMESTAMP() WHERE id=?',[account.vendor_id]);else await tx.execute('UPDATE vendors SET payout_verified_at=IF(EXISTS(SELECT 1 FROM vendor_payout_accounts WHERE vendor_id=? AND verification_status=\'verified\' AND id<>?),payout_verified_at,NULL) WHERE id=?',[account.vendor_id,id,account.vendor_id]);await audit(tx,actor,`vendor.payout.${status}`,account.vendor_id,{payout_account_id:id,verification_status:account.verification_status},{payout_account_id:id,verification_status:status,reason,method:account.method,masked_account:account.masked_account});const vendor=await tryActivate(tx,Number(account.vendor_id));return{accountId:id,vendorId:Number(account.vendor_id),status,lifecycle_status:vendor.lifecycle_status};},{pool});
}
async function getPayoutDetailsForAdmin(accountId,{pool}={}){assertMysql();const row=await mysql.createQueryClient(pool||mysql.getPool()).queryOne('SELECT id,vendor_id,method,details_ciphertext,masked_account,verification_status,verification_reason,verified_by_user_id,verified_at,created_at FROM vendor_payout_accounts WHERE id=?',[requirePositiveInt(accountId,'Payout account ID')]);if(!row)throw new NotFoundError('Payout account not found.');return{...row,details:JSON.parse(pii.decryptVendorPii(row.details_ciphertext))};}
async function listPayoutDetailsForAdmin(vendorId,{pool}={}){assertMysql();const rows=await mysql.createQueryClient(pool||mysql.getPool()).queryAll('SELECT id,vendor_id,method,details_ciphertext,masked_account,verification_status,verification_reason,verified_by_user_id,verified_at,created_at FROM vendor_payout_accounts WHERE vendor_id=? ORDER BY id DESC',[requirePositiveInt(vendorId,'Vendor ID')]);return rows.map(row=>({...row,details:JSON.parse(pii.decryptVendorPii(row.details_ciphertext))}));}
async function completeOnboarding(vendorId,termsAccepted,actor={type:'vendor'}, {pool}={}){
 assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID');if(!termsAccepted)throw new ValidationError('Accept the onboarding policy before continuing.');return mysql.withTransaction(async tx=>{const vendor=await tx.queryOne('SELECT id,lifecycle_status,onboarding_completed_at FROM vendors WHERE id=? AND status=1 FOR UPDATE',[id]);if(!vendor)throw new NotFoundError('Vendor account not found.');if(!vendor.onboarding_completed_at)await tx.execute('UPDATE vendors SET onboarding_completed_at=UTC_TIMESTAMP() WHERE id=?',[id]);await audit(tx,actor,'vendor.onboarding.completed',id,{onboarding_completed:Boolean(vendor.onboarding_completed_at)},{onboarding_completed:true});const updated=await tryActivate(tx,id);return{lifecycle_status:updated.lifecycle_status};},{pool});
}
async function getPortalDashboard(vendorId,{pool}={}){
 assertMysql();const id=requirePositiveInt(vendorId,'Vendor ID'),db=mysql.createQueryClient(pool||mysql.getPool());const vendor=await db.queryOne('SELECT id,shop_name,owner_name,phone,email,address,balance_paisa/100 AS balance,commission_rate_bps/100 AS commission_rate,lifecycle_status,verified,phone_verified_at,identity_verified_at,onboarding_completed_at,commission_configured_at,payout_verified_at,trusted_auto_publish FROM vendors WHERE id=?',[id]);if(!vendor)throw new NotFoundError('Vendor account not found.');const [app,counts,orders,payouts]=await Promise.all([db.queryOne('SELECT business_type,business_category,district,upazila,resubmission_count FROM vendor_applications WHERE vendor_id=?',[id]),db.queryOne("SELECT COUNT(*) AS total_products,SUM(approval_status='approved') AS approved_products,SUM(approval_status='pending') AS pending_products FROM products WHERE vendor_id=?",[id]),db.queryOne('SELECT COUNT(*) AS total_orders,COALESCE(SUM(oi.line_total_paisa),0)/100 AS gross_sales FROM order_items oi JOIN products p ON p.id=oi.product_id AND p.vendor_id=oi.vendor_id JOIN orders o ON o.id=oi.order_id WHERE oi.vendor_id=? AND o.order_status NOT IN (\'cancelled\',\'failed\')',[id]),db.queryAll('SELECT id,method,masked_account,verification_status FROM vendor_payout_accounts WHERE vendor_id=? ORDER BY id DESC',[id])]);return{vendor,application:app||null,counts:{totalProducts:Number(counts?.total_products||0),approvedProducts:Number(counts?.approved_products||0),pendingProducts:Number(counts?.pending_products||0)},orders:{totalOrders:Number(orders?.total_orders||0),grossSales:Number(orders?.gross_sales||0)},payouts};
}
module.exports={register,resubmitApplication,issuePhoneOtp,verifyPhoneOtp,auditSensitiveAccess,getVendorApplication,listApplications,getStatusHistory,transition,assignCommission,savePayoutAccount,listPayoutAccounts,verifyPayoutAccount,getPayoutDetailsForAdmin,listPayoutDetailsForAdmin,completeOnboarding,getPortalDashboard};
