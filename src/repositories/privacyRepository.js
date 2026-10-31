'use strict';

const crypto = require('node:crypto');
const { env } = require('../config/env');
const { getPool, createQueryClient, withTransaction } = require('../db/mysqlPool');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const { requirePositiveInt } = require('../utils/validator');

const CONSENT_KEYS = new Set(['marketing', 'analytics']);
const REQUEST_TYPES = new Set(['access', 'correction', 'deletion', 'consent_withdrawal']);
const REQUEST_STATUSES = new Set(['pending', 'in_review', 'approved', 'rejected', 'cancelled', 'completed']);
function assertMysql() { if (env.db.client !== 'mysql') throw new Error('Privacy workflows require MySQL.'); }
function client(pool) { return createQueryClient(pool || getPool()); }
function cleanText(value, label, max, required = false) {
  if (typeof value !== 'string') throw new ValidationError(`${label} must be text.`);
  const result = value.trim();
  if ((required && !result) || result.length > max) throw new ValidationError(`${label} is required and must not exceed ${max} characters.`);
  return result;
}
function audit(tx, actor, action, entityId, before, after) {
  return tx.execute(
    'INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?,?)',
    [actor.type, actor.id || null, action, 'customer_privacy', String(entityId), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, String(actor.ip || '').slice(0, 64), String(actor.userAgent || '').slice(0, 255)]
  );
}
function validateCorrection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Correction details are required.');
  const out = {};
  if (input.name !== undefined && String(input.name).trim()) out.name = cleanText(String(input.name), 'Name', 191, true);
  if (input.email !== undefined) {
    const email = cleanText(String(input.email || ''), 'Email', 191);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Enter a valid email address.');
    out.email = email || null;
  }
  if (input.phone !== undefined) {
    const phone = cleanText(String(input.phone || ''), 'Phone', 32, true).replace(/[\s()-]/g, '');
    if (!/^01[3-9]\d{8}$/.test(phone)) throw new ValidationError('Phone corrections require a Bangladesh mobile number and manual verification.');
    out.phone = phone;
  }
  if (!Object.keys(out).length) throw new ValidationError('Provide at least one field to correct.');
  return out;
}

async function getCurrentPolicy(locale = 'bn', pool) {
  assertMysql();
  const row = await client(pool).queryOne("SELECT version,title_bn,title_en,content_bn,content_en,legal_review_status,legal_review_note,published_at FROM privacy_policy_versions WHERE status='published' ORDER BY published_at DESC,id DESC LIMIT 1");
  if (!row) throw new NotFoundError('No privacy policy has been published.');
  return { ...row, title: locale === 'en' ? row.title_en : row.title_bn, content: locale === 'en' ? row.content_en : row.content_bn };
}
async function getPolicyVersion(policyId,pool) {
  assertMysql();
  const id=requirePositiveInt(policyId,'Policy version ID');
  const row=await client(pool).queryOne('SELECT id,version,title_bn,title_en,content_bn,content_en,status,legal_review_status,legal_review_note,published_at FROM privacy_policy_versions WHERE id=?',[id]);
  if(!row)throw new NotFoundError('Policy version not found.');
  return row;
}
async function listPolicies(pool) {
  assertMysql();
  return client(pool).queryAll('SELECT id,version,title_bn,title_en,status,legal_review_status,legal_review_note,published_at,created_at,created_by_user_id FROM privacy_policy_versions ORDER BY id DESC');
}
async function createPolicy(input, actor, pool) {
  assertMysql();
  const version = cleanText(input.version, 'Version', 32, true);
  const titleBn = cleanText(input.title_bn, 'Bangla title', 255, true);
  const titleEn = cleanText(input.title_en, 'English title', 255, true);
  const contentBn = cleanText(input.content_bn, 'Bangla policy content', 50000, true);
  const contentEn = cleanText(input.content_en, 'English policy content', 50000, true);
  return withTransaction(async (tx) => {
    const result = await tx.execute('INSERT INTO privacy_policy_versions(version,title_bn,title_en,content_bn,content_en,status,legal_review_status,created_by_user_id) VALUES(?,?,?,?,? ,\'draft\',\'not_reviewed\',?)', [version, titleBn, titleEn, contentBn, contentEn, actor.id || null]);
    await audit(tx, actor, 'privacy.policy.draft_created', result.insertId, null, { version, status: 'draft', legal_review_status: 'not_reviewed' });
    return result.insertId;
  }, { pool });
}
async function updatePolicyDraft(policyId, input, actor, pool) {
  assertMysql();
  const id = requirePositiveInt(policyId, 'Policy version ID');
  const titleBn = cleanText(input.title_bn, 'Bangla title', 255, true);
  const titleEn = cleanText(input.title_en, 'English title', 255, true);
  const contentBn = cleanText(input.content_bn, 'Bangla policy content', 50000, true);
  const contentEn = cleanText(input.content_en, 'English policy content', 50000, true);
  return withTransaction(async (tx) => {
    const before = await tx.queryOne("SELECT id,version,title_bn,title_en,status FROM privacy_policy_versions WHERE id=? FOR UPDATE", [id]);
    if (!before) throw new NotFoundError('Policy version not found.');
    if (before.status !== 'draft') throw new ConflictError('Published policy versions are immutable; create a new draft version.');
    await tx.execute('UPDATE privacy_policy_versions SET title_bn=?,title_en=?,content_bn=?,content_en=? WHERE id=? AND status=\'draft\'', [titleBn,titleEn,contentBn,contentEn,id]);
    await audit(tx,actor,'privacy.policy.draft_updated',id,{version:before.version,status:before.status},{title_bn:titleBn,title_en:titleEn,status:'draft'});
  },{pool});
}
async function listPolicyPublications(pool) {
  assertMysql();
  return client(pool).queryAll('SELECT h.id,h.policy_version_id,p.version,p.title_bn,p.title_en,h.action,h.actor_user_id,h.note,h.created_at FROM privacy_policy_publication_history h JOIN privacy_policy_versions p ON p.id=h.policy_version_id ORDER BY h.id DESC LIMIT 250');
}
async function reviewPolicy(policyId, reviewStatus, note, actor, pool) {
  assertMysql();
  const id=requirePositiveInt(policyId,'Policy version ID');
  if(!['not_reviewed','qualified_reviewed','changes_requested'].includes(reviewStatus))throw new ValidationError('Unsupported legal-review status.');
  const reason=cleanText(String(note||''),'Review note',500,true);
  return withTransaction(async tx=>{
    const before=await tx.queryOne('SELECT id,version,legal_review_status,legal_review_note FROM privacy_policy_versions WHERE id=? FOR UPDATE',[id]);
    if(!before)throw new NotFoundError('Policy version not found.');
    await tx.execute('UPDATE privacy_policy_versions SET legal_review_status=?,legal_review_note=? WHERE id=?',[reviewStatus,reason,id]);
    await audit(tx,actor,'privacy.policy.legal_review_recorded',id,{legal_review_status:before.legal_review_status},{legal_review_status:reviewStatus,note:reason});
  },{pool});
}
async function publishPolicy(policyId, actor, note = '', pool) {
  assertMysql();
  const id = requirePositiveInt(policyId, 'Policy version ID');
  const reason = cleanText(String(note || ''), 'Publication note', 500);
  return withTransaction(async (tx) => {
    const target = await tx.queryOne('SELECT id,version,status FROM privacy_policy_versions WHERE id=? FOR UPDATE', [id]);
    if (!target) throw new NotFoundError('Policy version not found.');
    if (target.status === 'published') throw new ConflictError('This policy version is already published.');
    const current = await tx.queryAll("SELECT id,version FROM privacy_policy_versions WHERE status='published' FOR UPDATE");
    await tx.execute("UPDATE privacy_policy_versions SET status='superseded' WHERE status='published'");
    await tx.execute("UPDATE privacy_policy_versions SET status='published',published_at=CURRENT_TIMESTAMP,created_by_user_id=COALESCE(created_by_user_id,?) WHERE id=?", [actor.id || null, id]);
    for (const old of current) {
      await tx.execute('INSERT INTO privacy_policy_publication_history(policy_version_id,action,actor_user_id,note) VALUES(?,?,?,?)', [old.id, 'superseded', actor.id || null, reason]);
    }
    await tx.execute('INSERT INTO privacy_policy_publication_history(policy_version_id,action,actor_user_id,note) VALUES(?,?,?,?)', [id, 'published', actor.id || null, reason]);
    await audit(tx, actor, 'privacy.policy.published', id, { status: target.status, currentVersions: current.map((item) => item.version) }, { status: 'published', version: target.version, note: reason });
    return target.version;
  }, { pool });
}
async function listConsentOptions(pool) {
  assertMysql();
  return client(pool).queryAll('SELECT consent_key,label_bn,label_en,description_bn,description_en,enabled,updated_at,updated_by_user_id FROM privacy_consent_options ORDER BY consent_key');
}
async function updateConsentOption(key, input, actor, pool) {
  assertMysql();
  if (!CONSENT_KEYS.has(key)) throw new ValidationError('Only optional marketing or analytics consent can be configured.');
  const enabled = Number(input.enabled);
  if (![0, 1].includes(enabled)) throw new ValidationError('Consent availability must be 0 or 1.');
  const labelBn = cleanText(String(input.label_bn || ''), 'Bangla label', 120, true);
  const labelEn = cleanText(String(input.label_en || ''), 'English label', 120, true);
  const descriptionBn = cleanText(String(input.description_bn || ''), 'Bangla description', 500, true);
  const descriptionEn = cleanText(String(input.description_en || ''), 'English description', 500, true);
  return withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT enabled,label_bn,label_en,description_bn,description_en FROM privacy_consent_options WHERE consent_key=? FOR UPDATE', [key]);
    if (!before) throw new NotFoundError('Optional consent configuration not found.');
    await tx.execute('UPDATE privacy_consent_options SET enabled=?,label_bn=?,label_en=?,description_bn=?,description_en=?,updated_by_user_id=? WHERE consent_key=?', [enabled, labelBn, labelEn, descriptionBn, descriptionEn, actor.id || null, key]);
    await audit(tx, actor, 'privacy.consent.option_updated', key, before, { enabled, label_bn: labelBn, label_en: labelEn, description_bn: descriptionBn, description_en: descriptionEn });
    return { consent_key: key, enabled };
  }, { pool });
}
async function getEnabledConsentOptions(locale = 'bn', pool) {
  assertMysql();
  const rows = await client(pool).queryAll('SELECT consent_key,label_bn,label_en,description_bn,description_en FROM privacy_consent_options WHERE enabled=1 ORDER BY consent_key');
  return rows.map((row) => ({ key: row.consent_key, label: locale === 'en' ? row.label_en : row.label_bn, description: locale === 'en' ? row.description_en : row.description_bn }));
}
async function recordPolicyAcceptance(customerId, policyVersion, evidence = {}, pool, source = 'policy_update') {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  const version = cleanText(policyVersion, 'Policy version', 32, true);
  return withTransaction(async (tx) => {
    const policy = await tx.queryOne("SELECT version FROM privacy_policy_versions WHERE version=? AND status='published' FOR UPDATE", [version]);
    if (!policy) throw new ConflictError('The submitted privacy policy version is no longer current. Reload the registration form.');
    const customer = await tx.queryOne('SELECT id FROM customers WHERE id=? AND status=1 AND is_blocked=0 FOR UPDATE', [owner]);
    if (!customer) throw new NotFoundError('Customer account not found.');
    const result = await tx.execute('INSERT INTO customer_policy_acceptances(customer_id,policy_version,source,evidence_json) VALUES(?,?,?,?)', [owner, version, source, JSON.stringify({ ...evidence, accepted: true })]);
    await audit(tx, { type: 'customer', id: owner, ...evidence.actor }, 'privacy.policy.accepted', result.insertId, null, { customer_id: owner, policy_version: version, source });
    return result.insertId;
  }, { pool });
}
async function listPolicyAcceptances(customerId, pool) {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  return client(pool).queryAll('SELECT id,policy_version,accepted_at,source FROM customer_policy_acceptances WHERE customer_id=? ORDER BY id DESC', [owner]);
}
async function setConsent(customerId, consentKey, action, evidence = {}, pool) {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  if (!CONSENT_KEYS.has(consentKey)) throw new ValidationError('Essential order processing is not an optional consent and cannot be withdrawn.');
  if (!['grant', 'withdraw'].includes(action)) throw new ValidationError('Consent action must be grant or withdraw.');
  return withTransaction(async (tx) => {
    const option = await tx.queryOne('SELECT enabled FROM privacy_consent_options WHERE consent_key=? FOR UPDATE', [consentKey]);
    if (!option || (action === 'grant' && Number(option.enabled) !== 1)) throw new ConflictError('This optional consent is not currently available.');
    const customer = await tx.queryOne('SELECT id FROM customers WHERE id=? AND status=1 AND is_blocked=0 FOR UPDATE', [owner]);
    if (!customer) throw new NotFoundError('Customer account not found.');
    const policy = await tx.queryOne("SELECT version FROM privacy_policy_versions WHERE status='published' ORDER BY published_at DESC,id DESC LIMIT 1 FOR UPDATE");
    if (!policy) throw new ConflictError('No published policy is available.');
    const previous = await tx.queryOne('SELECT granted,policy_version FROM customer_consent_current WHERE customer_id=? AND consent_key=? FOR UPDATE', [owner, consentKey]);
    const granted = action === 'grant' ? 1 : 0;
    await tx.execute('INSERT INTO customer_consent_current(customer_id,consent_key,policy_version,granted) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE policy_version=VALUES(policy_version),granted=VALUES(granted),updated_at=CURRENT_TIMESTAMP', [owner, consentKey, policy.version, granted]);
    await tx.execute('INSERT INTO customer_consent_events(customer_id,consent_key,policy_version,action,evidence_json) VALUES(?,?,?,?,?)', [owner, consentKey, policy.version, action === 'grant' ? 'granted' : 'withdrawn', JSON.stringify({ ...evidence, essential_order_processing_unaffected: true })]);
    await audit(tx, { type: 'customer', id: owner, ...evidence.actor }, action === 'grant' ? 'privacy.consent.granted' : 'privacy.consent.withdrawn', `${owner}:${consentKey}`, previous, { granted, policy_version: policy.version });
    return { consent_key: consentKey, granted: Boolean(granted), policy_version: policy.version };
  }, { pool });
}
async function listConsents(customerId, pool) {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  return client(pool).queryAll('SELECT consent_key,policy_version,granted,updated_at FROM customer_consent_current WHERE customer_id=? ORDER BY consent_key', [owner]);
}
async function listConsentHistory(customerId, pool) {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  return client(pool).queryAll('SELECT consent_key,policy_version,action,created_at FROM customer_consent_events WHERE customer_id=? ORDER BY id DESC', [owner]);
}
async function createPrivacyRequest(customerId, input, actorContext = {}, pool) {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  const type = cleanText(input.request_type, 'Request type', 32, true);
  if (!REQUEST_TYPES.has(type)) throw new ValidationError('Unsupported privacy request type.');
  const message = cleanText(String(input.customer_message || ''), 'Message', 1000);
  let requested = null;
  if (type === 'correction') requested = validateCorrection(input.requested_data || {});
  if (type === 'consent_withdrawal') {
    const key = cleanText(String(input.consent_key || ''), 'Consent type', 48, true);
    if (!CONSENT_KEYS.has(key)) throw new ValidationError('Essential order processing cannot be withdrawn.');
    requested = { consent_key: key };
  }
  return withTransaction(async (tx) => {
    const customer = await tx.queryOne('SELECT id FROM customers WHERE id=? AND status=1 AND is_blocked=0 FOR UPDATE', [owner]);
    if (!customer) throw new NotFoundError('Customer account not found.');
    const duplicate = await tx.queryOne('SELECT id FROM customer_privacy_requests WHERE customer_id=? AND request_type=? AND status IN (\'pending\',\'in_review\') LIMIT 1 FOR UPDATE', [owner, type]);
    if (duplicate) throw new ConflictError('You already have an open request of this type.');
    const result = await tx.execute('INSERT INTO customer_privacy_requests(customer_id,request_type,status,requested_data_json,customer_message) VALUES(?,?,\'pending\',?,?)', [owner, type, requested ? JSON.stringify(requested) : null, message]);
    await tx.execute('INSERT INTO customer_privacy_request_events(request_id,actor_type,actor_id,from_status,to_status,reason) VALUES(?,?,?,\'\',\'pending\',?)', [result.insertId, 'customer', owner, message]);
    await audit(tx, { type: 'customer', id: owner, ...actorContext }, `privacy.request.${type}.created`, result.insertId, null, { request_type: type, status: 'pending' });
    return result.insertId;
  }, { pool });
}
async function listCustomerRequests(customerId, pool) {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  return client(pool).queryAll('SELECT id,request_type,status,customer_message,decision_reason,reviewed_at,completed_at,created_at,updated_at FROM customer_privacy_requests WHERE customer_id=? ORDER BY id DESC', [owner]);
}
async function getCustomerRequest(customerId, requestId, pool) {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  const id = requirePositiveInt(requestId, 'Privacy request ID');
  const row = await client(pool).queryOne('SELECT id,request_type,status,requested_data_json,customer_message,decision_reason,reviewer_user_id,reviewed_at,completed_at,created_at FROM customer_privacy_requests WHERE id=? AND customer_id=?', [id, owner]);
  if (!row) throw new NotFoundError('Privacy request not found.');
  return { ...row, requested_data: row.requested_data_json ? JSON.parse(row.requested_data_json) : null };
}
async function cancelCustomerRequest(customerId, requestId, actor = {}, pool) {
  assertMysql();
  const owner = requirePositiveInt(customerId, 'Customer ID');
  const id = requirePositiveInt(requestId, 'Privacy request ID');
  return withTransaction(async (tx) => {
    const row = await tx.queryOne('SELECT id,status FROM customer_privacy_requests WHERE id=? AND customer_id=? FOR UPDATE', [id, owner]);
    if (!row) throw new NotFoundError('Privacy request not found.');
    if (row.status !== 'pending') throw new ConflictError('Only a pending request can be cancelled by the customer.');
    await tx.execute("UPDATE customer_privacy_requests SET status='cancelled',decision_reason='Cancelled by customer',reviewer_user_id=NULL,reviewed_at=CURRENT_TIMESTAMP WHERE id=?", [id]);
    await tx.execute('INSERT INTO customer_privacy_request_events(request_id,actor_type,actor_id,from_status,to_status,reason) VALUES(?,?,?,?,?,?)', [id, 'customer', owner, 'pending', 'cancelled', 'Cancelled by customer']);
    await audit(tx, { type: 'customer', id: owner, ...actor }, 'privacy.request.cancelled', id, { status: 'pending' }, { status: 'cancelled' });
  }, { pool });
}
async function listAdminRequests({ status = '', type = '', pool } = {}) {
  assertMysql();
  const cleanStatusValue = cleanText(String(status || ''), 'Status', 24);
  const cleanType = cleanText(String(type || ''), 'Request type', 32);
  if (cleanStatusValue && !REQUEST_STATUSES.has(cleanStatusValue)) throw new ValidationError('Unsupported request status.');
  if (cleanType && !REQUEST_TYPES.has(cleanType)) throw new ValidationError('Unsupported request type.');
  const where = [];
  const args = [];
  if (cleanStatusValue) { where.push('r.status=?'); args.push(cleanStatusValue); }
  if (cleanType) { where.push('r.request_type=?'); args.push(cleanType); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return client(pool).queryAll(`SELECT r.id,r.customer_id,r.request_type,r.status,r.customer_message,r.decision_reason,r.reviewed_at,r.completed_at,r.created_at FROM customer_privacy_requests r ${clause} ORDER BY r.id DESC LIMIT 250`, args);
}
async function getAdminRequest(requestId, pool) {
  assertMysql();
  const id = requirePositiveInt(requestId, 'Privacy request ID');
  const row = await client(pool).queryOne('SELECT r.*,c.name AS customer_name,c.phone AS customer_phone,c.email AS customer_email FROM customer_privacy_requests r JOIN customers c ON c.id=r.customer_id WHERE r.id=?', [id]);
  if (!row) throw new NotFoundError('Privacy request not found.');
  return { ...row, requested_data: row.requested_data_json ? JSON.parse(row.requested_data_json) : null };
}
async function reviewPrivacyRequest(requestId, decision, reason, actor, pool) {
  assertMysql();
  const id = requirePositiveInt(requestId, 'Privacy request ID');
  if (!['in_review', 'approve', 'reject'].includes(decision)) throw new ValidationError('Unsupported review decision.');
  const note = cleanText(String(reason || ''), 'Review reason', 1000, true);
  return withTransaction(async (tx) => {
    const row = await tx.queryOne('SELECT id,customer_id,request_type,status,requested_data_json FROM customer_privacy_requests WHERE id=? FOR UPDATE', [id]);
    if (!row) throw new NotFoundError('Privacy request not found.');
    if (!['pending', 'in_review'].includes(row.status)) throw new ConflictError('This request is already in a terminal state.');
    const status = decision === 'in_review' ? 'in_review' : decision === 'approve' ? 'approved' : 'rejected';
    await tx.execute('UPDATE customer_privacy_requests SET status=?,decision_reason=?,reviewer_user_id=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?', [status, note, actor.id, id]);
    if (decision === 'approve' && row.request_type === 'consent_withdrawal') {
      const requested = row.requested_data_json ? JSON.parse(row.requested_data_json) : null;
      const consentKey = requested && requested.consent_key;
      if (!CONSENT_KEYS.has(consentKey)) throw new ValidationError('Consent withdrawal request does not identify an optional consent.');
      const policy = await tx.queryOne("SELECT version FROM privacy_policy_versions WHERE status='published' ORDER BY published_at DESC,id DESC LIMIT 1 FOR UPDATE");
      if (!policy) throw new ConflictError('No published policy is available.');
      const previousConsent = await tx.queryOne('SELECT granted,policy_version FROM customer_consent_current WHERE customer_id=? AND consent_key=? FOR UPDATE',[row.customer_id,consentKey]);
      await tx.execute('INSERT INTO customer_consent_current(customer_id,consent_key,policy_version,granted) VALUES(?,?,?,0) ON DUPLICATE KEY UPDATE policy_version=VALUES(policy_version),granted=0,updated_at=CURRENT_TIMESTAMP',[row.customer_id,consentKey,policy.version]);
      await tx.execute('INSERT INTO customer_consent_events(customer_id,consent_key,policy_version,action,evidence_json) VALUES(?,?,?,\'withdrawn\',?)',[row.customer_id,consentKey,policy.version,JSON.stringify({request_id:id,reviewer_id:actor.id,essential_order_processing_unaffected:true})]);
      await audit(tx,actor,'privacy.consent.withdrawn_after_review',`${row.customer_id}:${consentKey}`,previousConsent,{granted:0,policy_version:policy.version,request_id:id});
    }
    await tx.execute('INSERT INTO customer_privacy_request_events(request_id,actor_type,actor_id,from_status,to_status,reason) VALUES(?,?,?,?,?,?)', [id, 'admin', actor.id, row.status, status, note]);
    await audit(tx, actor, `privacy.request.${decision}`, id, { status: row.status, request_type: row.request_type }, { status, customer_id: Number(row.customer_id), reason: note });
    return { id, status };
  }, { pool });
}
async function applyCorrection(requestId, input, reason, actor, pool) {
  assertMysql();
  const id = requirePositiveInt(requestId, 'Privacy request ID');
  const correction = validateCorrection(input);
  const note = cleanText(String(reason || ''), 'Correction evidence', 1000, true);
  return withTransaction(async (tx) => {
    const request = await tx.queryOne("SELECT id,customer_id,status,request_type FROM customer_privacy_requests WHERE id=? FOR UPDATE", [id]);
    if (!request) throw new NotFoundError('Privacy request not found.');
    if (request.request_type !== 'correction' || request.status !== 'approved') throw new ConflictError('Only an approved correction request can be applied.');
    const customer = await tx.queryOne('SELECT id,name,phone,email FROM customers WHERE id=? AND status=1 FOR UPDATE', [request.customer_id]);
    if (!customer) throw new NotFoundError('Customer account not found.');
    const fields = Object.keys(correction);
    const sets = fields.map((field) => `\`${field}\`=?`).join(',');
    try { await tx.execute(`UPDATE customers SET ${sets} WHERE id=?`, [...fields.map((field) => correction[field]), request.customer_id]); }
    catch (error) { if (error.code === 'DB_DUPLICATE_ENTRY') throw new ConflictError('The requested phone number is already in use.'); throw error; }
    await tx.execute("UPDATE customer_privacy_requests SET status='completed',decision_reason=?,completed_at=CURRENT_TIMESTAMP WHERE id=?", [note, id]);
    await tx.execute('INSERT INTO customer_privacy_request_events(request_id,actor_type,actor_id,from_status,to_status,reason) VALUES(?,?,?,?,?,?)', [id, 'admin', actor.id, 'approved', 'completed', note]);
    await audit(tx, actor, 'privacy.customer.correction.applied', id, { customer_id: Number(customer.id), changed_fields: fields }, { status: 'completed', reason: note });
    return { id, status: 'completed' };
  }, { pool });
}
async function anonymizeCustomer(requestId, reason, actor, pool) {
  assertMysql();
  const id = requirePositiveInt(requestId, 'Privacy request ID');
  const note = cleanText(String(reason || ''), 'Anonymization approval reason', 1000, true);
  return withTransaction(async (tx) => {
    const request = await tx.queryOne("SELECT id,customer_id,status,request_type FROM customer_privacy_requests WHERE id=? FOR UPDATE", [id]);
    if (!request) throw new NotFoundError('Privacy request not found.');
    if (request.request_type !== 'deletion' || request.status !== 'approved') throw new ConflictError('Anonymization requires an approved deletion request.');
    const customerId = requirePositiveInt(request.customer_id, 'Customer ID');
    const customer = await tx.queryOne('SELECT id,name,phone,email,status FROM customers WHERE id=? FOR UPDATE', [customerId]);
    if (!customer) throw new NotFoundError('Customer account not found.');
    if (Number(customer.status) === 0 && String(customer.phone).startsWith('removed-')) throw new ConflictError('Customer data has already been anonymized.');
    await tx.execute('UPDATE customers SET name=?,phone=?,email=NULL,password_hash=?,address=NULL,district=\'\',last_ip=\'\',status=0,is_blocked=1 WHERE id=?', [`Removed customer ${customerId}`, `removed-${customerId}`, await require('bcryptjs').hash(crypto.randomBytes(48).toString('hex'), 12), customerId]);
    await tx.execute("UPDATE customer_addresses SET label='Removed',recipient_name='Removed',recipient_phone='removed',division='',district='',upazila='',street_address='Removed',is_default=0 WHERE customer_id=?", [customerId]);
    await tx.execute("DELETE FROM web_sessions WHERE actor_type='customer' AND actor_id=?", [customerId]);
    await tx.execute('UPDATE customer_recovery_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE customer_id=? AND revoked_at IS NULL AND consumed_at IS NULL',[customerId]);
    await tx.execute("UPDATE customer_privacy_requests SET status='completed',decision_reason=?,completed_at=CURRENT_TIMESTAMP WHERE id=?", [note, id]);
    await tx.execute('INSERT INTO customer_privacy_request_events(request_id,actor_type,actor_id,from_status,to_status,reason) VALUES(?,?,?,?,?,?)', [id, 'admin', actor.id, 'approved', 'completed', note]);
    await audit(tx, actor, 'privacy.customer.anonymized', id, { customer_id: customerId, status: Number(customer.status) }, { status: 'anonymized', order_history_preserved: true, reason: note });
    return { id, customer_id: customerId, status: 'completed', order_history_preserved: true };
  }, { pool });
}
async function listRetentionSettings(pool) {
  assertMysql();
  return client(pool).queryAll('SELECT category_key,retention_days,manual_review_required,notes,updated_by_user_id,updated_at FROM privacy_retention_settings ORDER BY category_key');
}
async function updateRetentionSetting(category, input, actor, pool) {
  assertMysql();
  const key = cleanText(category, 'Retention category', 64, true);
  const retentionDays = input.retention_days === '' || input.retention_days == null ? null : Number(input.retention_days);
  if (retentionDays !== null && (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 36500)) throw new ValidationError('Retention days must be blank (manual review) or a whole number from 1 to 36500.');
  const manual = Number(input.manual_review_required);
  if (![0, 1].includes(manual)) throw new ValidationError('Manual-review setting must be 0 or 1.');
  const notes = cleanText(String(input.notes || ''), 'Retention notes', 500);
  return withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT retention_days,manual_review_required,notes FROM privacy_retention_settings WHERE category_key=? FOR UPDATE', [key]);
    if (!before) throw new NotFoundError('Retention category not found.');
    await tx.execute('UPDATE privacy_retention_settings SET retention_days=?,manual_review_required=?,notes=?,updated_by_user_id=? WHERE category_key=?', [retentionDays, manual, notes, actor.id, key]);
    await audit(tx, actor, 'privacy.retention.updated', key, before, { retention_days: retentionDays, manual_review_required: manual, notes });
    return { category_key: key, retention_days: retentionDays, manual_review_required: manual };
  }, { pool });
}

module.exports = { CONSENT_KEYS, REQUEST_TYPES, getCurrentPolicy, getPolicyVersion, listPolicies, createPolicy, updatePolicyDraft, listPolicyPublications, reviewPolicy, publishPolicy, listConsentOptions, updateConsentOption, getEnabledConsentOptions, recordPolicyAcceptance, listPolicyAcceptances, setConsent, listConsents, listConsentHistory, createPrivacyRequest, listCustomerRequests, getCustomerRequest, cancelCustomerRequest, listAdminRequests, getAdminRequest, reviewPrivacyRequest, applyCorrection, anonymizeCustomer, listRetentionSettings, updateRetentionSetting, validateCorrection };
