'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { asyncHandler } = require('../utils/asyncHandler');
const { safeReferrer } = require('../utils/urlSecurity');
const { createRateLimiter, createLoginRateLimiters } = require('../middleware/rateLimit');
const { requireCustomer } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const customers = require('../repositories/customerRepository');
const privacy = require('../repositories/privacyRepository');
const { env } = require('../config/env');
const { ValidationError, ConflictError } = require('../utils/errors');
const { formatBdt } = require('../utils/money');
const d7 = require('../repositories/d7Repository');
const upload = require('../middleware/upload');
const customerReturnEvidence = require('../middleware/customerReturnEvidence');
const fs = require('node:fs');
const path = require('node:path');
const phase08 = require('../repositories/phase08Repository');
const router = express.Router();
const customerLoginLimiters = createLoginRateLimiters({ keyPrefix: 'customer-login', identifierFields: ['phone'], windowMs: 15 * 60 * 1000, maxPerIp: 2000, maxPerIpAccount: 10 });
const registerLimiter = createRateLimiter({ keyPrefix: 'customer-register', windowMs: 60 * 60 * 1000, max: 5 });
const isEn = (req) => req.locale === 'en';
function formPage(req, res, title, error = '', extras = {}) { return res.status(error ? 400 : 200).render('customer/account-form', { title, error, isEn: isEn(req), customer: req.session.customerUser || null, ...extras }); }
function statusLabel(value, english) {
  const labels = {
    pending: ['অপেক্ষমাণ', 'Pending'], confirmed: ['নিশ্চিত', 'Confirmed'], processing: ['প্রক্রিয়াধীন', 'Processing'],
    packed: ['প্যাক করা হয়েছে', 'Packed'], ready_for_pickup: ['পিকআপের জন্য প্রস্তুত', 'Ready for pickup'],
    shipped: ['পাঠানো হয়েছে', 'Shipped'], in_transit: ['পথে আছে', 'In transit'], delivered: ['ডেলিভারি সম্পন্ন', 'Delivered'],
    cancelled: ['বাতিল', 'Cancelled'], return_requested: ['রিটার্ন অনুরোধ', 'Return requested'], returned: ['ফেরত হয়েছে', 'Returned'],
    requested: ['অনুরোধ জমা হয়েছে', 'Requested'], accepted: ['গৃহীত', 'Accepted'], approved: ['অনুমোদিত', 'Approved'],
    rejected: ['প্রত্যাখ্যাত', 'Rejected'], escalated: ['পর্যালোচনায়', 'Under review'], inspected: ['পরিদর্শিত', 'Inspected'],
    completed: ['সম্পন্ন', 'Completed'], processing_refund: ['রিফান্ড প্রক্রিয়াধীন', 'Refund processing'],
    succeeded: ['সম্পন্ন', 'Succeeded'], failed: ['ব্যর্থ', 'Failed'],
  };
  const pair = labels[String(value || '').toLowerCase()];
  return pair ? pair[english ? 1 : 0] : String(value || '—');
}
function evidenceDate(value, locale) { return dateLabel(value, locale); }
function auditEvidence(req) { return { ip: req.ip || '', userAgent: req.get('user-agent') || '' }; }
router.get('/customer/register', asyncHandler(async (req, res) => {
  const policy = env.db.client === 'mysql' ? await privacy.getCurrentPolicy(req.locale) : { version: 'legacy' };
  return formPage(req, res, isEn(req) ? 'Create account' : 'অ্যাকাউন্ট তৈরি করুন', '', { policyVersion: policy.version });
}));
router.post('/customer/register', registerLimiter, requireCsrf, asyncHandler(async (req, res) => {
  if (req.body.privacy_notice_acknowledged !== 'yes' || !req.body.privacy_policy_version) {
    const policy = await privacy.getCurrentPolicy(req.locale);
    return formPage(req, res, isEn(req) ? 'Create account' : 'অ্যাকাউন্ট তৈরি করুন', isEn(req) ? 'Review and acknowledge the privacy notice to continue.' : 'চালিয়ে যেতে গোপনীয়তা নীতিটি পড়ে সম্মতি নিশ্চিত করুন।', { policyVersion: policy.version });
  }
  const guestCart = Array.isArray(req.session.cart) ? req.session.cart : [];
  const title = isEn(req) ? 'Create account' : 'অ্যাকাউন্ট তৈরি করুন';
  let account;
  try {
    account = await customers.registerCustomer({ ...req.body, policyVersion: req.body.privacy_policy_version, evidence: { ip: req.ip || '', userAgent: req.get('user-agent') || '' } });
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return formPage(req, res, title, err.message, { policyVersion: req.body.privacy_policy_version });
  }
  await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  req.session.customerUser = account;
  req.session.analyticsConsent = false;
  req.session.analyticsConsentChoice = '';
  await customers.mergeCart(account.id, guestCart);
  req.session.cart = await customers.listCart(account.id, req.locale);
  return res.redirect('/customer/account');
}));
router.get('/customer/login', (req, res) => formPage(req, res, isEn(req) ? 'Customer login' : 'কাস্টমার লগইন'));
router.post('/customer/login', ...customerLoginLimiters, requireCsrf, asyncHandler(async (req, res) => {
  let customer = null;
  try { customer = await customers.authenticateCustomer(req.body.phone, req.body.password); } catch (err) { if (err.code !== 'VALIDATION_ERROR') throw err; }
  if (!customer) return formPage(req, res, isEn(req) ? 'Customer login' : 'কাস্টমার লগইন', isEn(req) ? 'Phone or password is incorrect.' : 'ফোন নম্বর অথবা পাসওয়ার্ড সঠিক নয়।');
  const guestCart = Array.isArray(req.session.cart) ? req.session.cart : [];
  await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  req.session.customerUser = customer;
  const consentState = env.db.client === 'mysql' ? await privacy.listConsents(customer.id) : [];
  const analyticsConsent = consentState.find((item) => item.consent_key === 'analytics');
  req.session.analyticsConsent = Number(analyticsConsent?.granted) === 1;
  req.session.analyticsConsentChoice = req.session.analyticsConsent ? 'accepted' : 'rejected';
  await customers.mergeCart(customer.id, guestCart);
  req.session.cart = await customers.listCart(customer.id, req.locale);
  return res.redirect('/customer/account');
}));
router.post('/customer/logout', requireCsrf, asyncHandler(async (req, res) => {
  await new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
  res.clearCookie('pholbazar_sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: env.isProduction });
  return res.redirect('/customer/login');
}));
function moneyLabel(paisa, locale) {
  const value = Number(paisa);
  if (!Number.isSafeInteger(value) || value < 0) return locale === 'en' ? 'Unavailable' : 'উপলভ্য নয়';
  return formatBdt(value, { locale });
}
function dateLabel(value, locale) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value || '');
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-BD' : 'bn-BD', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
router.post('/customer/account/profile', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  await customers.updateProfile(req.session.customerUser.id, req.body, auditEvidence(req));
  req.flash('success', isEn(req) ? 'Your profile was updated.' : 'আপনার প্রোফাইল আপডেট হয়েছে।');
  return res.redirect('/customer/account');
}));
router.post('/customer/account/password', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  if (req.body.new_password !== req.body.confirm_password) throw new ValidationError(isEn(req) ? 'New password confirmation does not match.' : 'নতুন পাসওয়ার্ড নিশ্চিতকরণ মেলেনি।');
  await customers.changePassword(req.session.customerUser.id, req.body, req.sessionID, auditEvidence(req));
  req.flash('success', isEn(req) ? 'Password changed. Other signed-in sessions were revoked.' : 'পাসওয়ার্ড পরিবর্তিত হয়েছে। অন্য সক্রিয় সেশন বন্ধ করা হয়েছে।');
  return res.redirect('/customer/account');
}));

router.get('/customer/account', requireCustomer, asyncHandler(async (req, res) => {
  const id = req.session.customerUser.id;
  const [profile, addresses, consents, consentHistory, requests, acceptances, consentOptions] = await Promise.all([
    customers.getProfile(id), customers.listAddresses(id), privacy.listConsents(id), privacy.listConsentHistory(id), privacy.listCustomerRequests(id), privacy.listPolicyAcceptances(id), privacy.getEnabledConsentOptions(req.locale),
  ]);
  return res.render('customer/account', { profile, addresses, consents, consentHistory, requests, acceptances, consentOptions, isEn: isEn(req) });
}));

router.get('/customer/account/referrals', requireCustomer, asyncHandler(async (req, res) => {
  const referralService = require('../services/referralService');
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const referralStats = await referralService.getCustomerWalletAndReferralStats(req.session.customerUser.id, baseUrl);
  return res.render('customer/referral', {
    referralStats,
    isEn: isEn(req),
    customer: req.session.customerUser || null,
  });
}));

router.get('/privacy-policy', asyncHandler(async (req, res) => {
  if (env.db.client !== 'mysql') return res.redirect('/page/privacy-policy');
  const policy = await privacy.getCurrentPolicy(req.locale);
  return res.render('store/privacy-policy', { policy, isEn: isEn(req) });
}));

router.get('/customer/account/privacy/data', requireCustomer, asyncHandler(async (req, res) => {
  const id = req.session.customerUser.id;
  const [profile, addresses, history, acceptances, consents, requests] = await Promise.all([
    customers.getProfile(id), customers.listAddresses(id), customers.listOrders(id, req.query.page || 1), privacy.listPolicyAcceptances(id), privacy.listConsentHistory(id), privacy.listCustomerRequests(id),
  ]);
  return res.json({ data: { profile, addresses, order_history: history, policy_acceptances: acceptances, consent_history: consents, privacy_requests: requests } });
}));

router.get('/customer/account/privacy-requests', requireCustomer, asyncHandler(async (req, res) => {
  const [requests, options, consents, history, acceptances, policy] = await Promise.all([
    privacy.listCustomerRequests(req.session.customerUser.id), privacy.getEnabledConsentOptions(req.locale), privacy.listConsents(req.session.customerUser.id), privacy.listConsentHistory(req.session.customerUser.id), privacy.listPolicyAcceptances(req.session.customerUser.id), privacy.getCurrentPolicy(req.locale),
  ]);
  return res.render('customer/privacy-requests', { requests, options, consents, history, acceptances, policy, isEn: isEn(req) });
}));

router.post('/customer/account/privacy-requests', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  const requestedData = Object.fromEntries(Object.entries({ name: req.body.correct_name, email: req.body.correct_email, phone: req.body.correct_phone }).filter(([, value]) => typeof value === 'string' && value.trim()));
  await privacy.createPrivacyRequest(req.session.customerUser.id, { request_type: req.body.request_type, customer_message: req.body.customer_message, consent_key: req.body.consent_key, requested_data: requestedData }, { ip: req.ip || '', userAgent: req.get('user-agent') || '' });
  return res.redirect('/customer/account/privacy-requests');
}));

router.post('/customer/account/privacy-requests/:id/cancel', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  await privacy.cancelCustomerRequest(req.session.customerUser.id, req.params.id, { ip: req.ip || '', userAgent: req.get('user-agent') || '' });
  return res.redirect('/customer/account/privacy-requests');
}));

router.post('/customer/account/privacy/accept-policy', requireCustomer, requireCsrf, asyncHandler(async (req,res)=>{
  if(req.body.acknowledged!=='yes') throw Object.assign(new Error('Policy acknowledgement is required'),{status:400});
  await privacy.recordPolicyAcceptance(req.session.customerUser.id,String(req.body.policy_version||''),{ip:req.ip||'',userAgent:req.get('user-agent')||''},null,'policy_update');
  return res.redirect('/customer/account/privacy-requests');
}));

router.post('/customer/account/privacy/consents', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  const key=String(req.body.consent_key||''), action=String(req.body.action||'');
  await privacy.setConsent(req.session.customerUser.id,key,action,{ip:req.ip||'',userAgent:req.get('user-agent')||''});
  if(key==='analytics'){
    req.session.analyticsConsent=action==='grant';
    req.session.analyticsConsentChoice=action==='grant'?'accepted':'withdrawn';
    if(action!=='grant')delete req.session.analyticsAttribution;
  }
  return res.redirect('/customer/account/privacy-requests');
}));

const recoveryLimiter = createRateLimiter({ keyPrefix: 'customer-recovery', windowMs: 60 * 60 * 1000, max: 5 });
router.get('/customer/recovery', (req, res) => res.render('customer/recovery', { isEn: isEn(req) }));
router.post('/customer/recovery', recoveryLimiter, requireCsrf, (_req, res) => res.status(503).render('customer/recovery', { isEn: isEn(_req), disabled: true }));
router.get('/customer/account/orders', requireCustomer, asyncHandler(async (req, res) => {
  const history = await customers.listOrders(req.session.customerUser.id, req.query.page || 1);
  const orders = history.orders.map((order) => ({ ...order, totalLabel: moneyLabel(order.total_paisa, req.locale), dateLabel: dateLabel(order.created_at, req.locale) }));
  return res.render('customer/orders', { ...history, orders, isEn: isEn(req) });
}));
router.get('/customer/account/orders/:id', requireCustomer, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  const details = await customers.getOrderSelfServiceDetails(req.session.customerUser.id, id);
  const order = { ...details.order, statusLabel: statusLabel(details.order.order_status, isEn(req)), subtotalLabel: moneyLabel(details.order.subtotal_paisa, req.locale), discountLabel: moneyLabel(details.order.discount_paisa, req.locale), shippingLabel: moneyLabel(details.order.shipping_paisa, req.locale), totalLabel: moneyLabel(details.order.total_paisa, req.locale), paidLabel: moneyLabel(details.order.paid_paisa || 0, req.locale), dateLabel: dateLabel(details.order.created_at, req.locale) };
  const items = details.items.map((item) => ({ ...item, unitPriceLabel: moneyLabel(item.unit_price_paisa, req.locale), lineTotalLabel: moneyLabel(item.line_total_paisa, req.locale) }));
  const tracking = details.tracking[0] || ((details.order.courier_code || details.order.courier_tracking_id) ? { courier_code: details.order.courier_code, tracking_code: details.order.courier_tracking_id, consignment_id: '', courier_status: '' } : null);
  const shipments = (details.shipments || []).map((shipment) => ({ ...shipment, deliveryStatusLabel: statusLabel(shipment.delivery_status, isEn(req)), bookingStatusLabel: shipment.booking_status ? statusLabel(shipment.booking_status, isEn(req)) : '' }));
  const d7Settings = await d7.getSettings();
  let cancelStates = ['pending', 'confirmed', 'processing'];
  try { const parsed = JSON.parse(d7Settings.d7_cancel_states || JSON.stringify(cancelStates)); if (Array.isArray(parsed)) cancelStates = parsed; } catch (_error) { cancelStates = []; }
  const canCancel = cancelStates.includes(details.order.order_status) && details.cancellations.length === 0;
  const refunds = details.refunds.map((refund) => ({ ...refund, amountLabel: moneyLabel(refund.amount_paisa, req.locale), statusLabel: statusLabel(refund.status, isEn(req)), history: details.refundEvents.filter((event) => Number(event.refund_id) === Number(refund.id)).map((event) => ({ ...event, fromLabel: statusLabel(event.from_status, isEn(req)), toLabel: statusLabel(event.to_status, isEn(req)), dateLabel: evidenceDate(event.created_at, req.locale) })) }));
  const reservedRefundStates = new Set(['requested', 'pending', 'approved', 'processing', 'succeeded', 'completed']);
  const reservedRefundPaisa = details.refunds.filter((refund) => reservedRefundStates.has(String(refund.status))).reduce((sum, refund) => sum + Number(refund.amount_paisa || 0), 0);
  const refundRemainingPaisa = Math.max(0, Number(details.order.paid_paisa || 0) - reservedRefundPaisa);
  const refundable = ['cancelled', 'delivered', 'returned'].includes(details.order.order_status) && String(details.order.payment_method || '').toLowerCase() !== 'cod' && refundRemainingPaisa > 0;
  const refundRequestKey = require('node:crypto').randomBytes(24).toString('hex');
  const returns = details.returns.map((item) => ({ ...item, evidenceAvailable: /^return-evidence\/[A-Za-z0-9-]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(String(item.evidence_path || '')), statusLabel: statusLabel(item.status, isEn(req)), dateLabel: evidenceDate(item.created_at, req.locale), history: details.returnEvents.filter((event) => Number(event.return_request_id) === Number(item.id)).map((event) => ({ ...event, fromLabel: statusLabel(event.from_status, isEn(req)), toLabel: statusLabel(event.to_status, isEn(req)), dateLabel: evidenceDate(event.created_at, req.locale) })) }));
  return res.render('customer/order-detail', { order, items, statusHistory: details.statusHistory.map((event) => ({ ...event, statusLabel: statusLabel(event.to_status, isEn(req)), dateLabel: evidenceDate(event.created_at, req.locale) })), tracking, shipments, canCancel, cancellations: details.cancellations.map((item) => ({ ...item, statusLabel: statusLabel(item.status, isEn(req)), dateLabel: evidenceDate(item.created_at, req.locale) })), returns, refunds, refundRemainingPaisa, refundRemainingLabel: moneyLabel(refundRemainingPaisa, req.locale), refundable, refundRequestKey, isEn: isEn(req) });
}));
router.get('/customer/account/orders/:id/invoice', requireCustomer, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  const { order: rawOrder, items: rawItems } = await customers.getOrderDetails(req.session.customerUser.id, id);
  const order = { ...rawOrder, dateLabel: dateLabel(rawOrder.created_at, req.locale), subtotalLabel: moneyLabel(rawOrder.subtotal_paisa, req.locale), discountLabel: moneyLabel(rawOrder.discount_paisa, req.locale), shippingLabel: moneyLabel(rawOrder.shipping_paisa, req.locale), totalLabel: moneyLabel(rawOrder.total_paisa, req.locale) };
  const items = rawItems.map((item) => ({ ...item, unitPriceLabel: moneyLabel(item.unit_price_paisa, req.locale), lineTotalLabel: moneyLabel(item.line_total_paisa, req.locale) }));
  return res.render('customer/invoice', { order, items, isEn: isEn(req) });
}));
router.post('/customer/account/addresses', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  await customers.saveAddress(req.session.customerUser.id, req.body, { ip:req.ip||'', userAgent:req.get('user-agent')||'' });
  return res.redirect('/customer/account');
}));
router.post('/customer/account/addresses/:id', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  await customers.updateAddress(req.session.customerUser.id, id, req.body, auditEvidence(req));
  req.flash('success', isEn(req) ? 'Address updated.' : 'ঠিকানা আপডেট হয়েছে।');
  return res.redirect('/customer/account');
}));
router.post('/customer/account/addresses/:id/default', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  await customers.setDefaultAddress(req.session.customerUser.id, id, auditEvidence(req));
  req.flash('success', isEn(req) ? 'Default address updated.' : 'ডিফল্ট ঠিকানা আপডেট হয়েছে।');
  return res.redirect('/customer/account');
}));
router.post('/customer/account/addresses/:id/delete', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  await customers.deleteAddress(req.session.customerUser.id, id, { ip:req.ip||'', userAgent:req.get('user-agent')||'' });
  return res.redirect('/customer/account');
}));

router.post('/customer/account/orders/:id/cancel', requireCustomer, requireCsrf, asyncHandler(async (req,res)=>{
  await d7.cancelOrder(req.params.id,req.session.customerUser.id,req.body.reason||'Customer requested cancellation',{ip:req.ip||'',userAgent:req.get('user-agent')||''});
  req.flash('success',isEn(req)?'Your pre-dispatch cancellation was recorded.':'ডিসপ্যাচের আগের বাতিলের অনুরোধ গ্রহণ করা হয়েছে।');
  return res.redirect(`/customer/account/orders/${encodeURIComponent(req.params.id)}`);
}));
function requireCsrfAfterEvidenceUpload(req, res, next) {
  return requireCsrf(req, res, (error) => {
    if (error && req.file) customerReturnEvidence.removeUploadedEvidence(req.file);
    return next(error);
  });
}

router.post('/customer/account/orders/:id/returns', requireCustomer, customerReturnEvidence.single, requireCsrfAfterEvidenceUpload, asyncHandler(async(req,res)=>{
  let evidencePath='';
  let persisted=false;
  try {
    evidencePath=customerReturnEvidence.evidenceKey(req.file);
    let items;try{items=JSON.parse(String(req.body.items_json||'[]'));}catch{throw new ValidationError('Return items are invalid.');}
    const result=await d7.requestReturn(req.session.customerUser.id,req.params.id,{claimType:req.body.claim_type,reason:req.body.reason,items,evidencePath});
    persisted=true;
    req.flash('success',isEn(req)?`Return request #${result.id} submitted for review.`:`রিটার্ন অনুরোধ #${result.id} পর্যালোচনার জন্য জমা হয়েছে।`);
    return res.redirect(`/customer/account/orders/${encodeURIComponent(req.params.id)}`);
  } catch(error) { if(req.file && !persisted)upload.safeUnlink(req.file.path); throw error; }
}));
router.get('/customer/account/returns/:id/evidence', requireCustomer, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  const evidence = await customers.getReturnEvidence(req.session.customerUser.id, id);
  if (!evidence || !evidence.evidence_path) return res.sendStatus(404);
  let fullPath;
  try { fullPath = customerReturnEvidence.resolveEvidencePath(evidence.evidence_path); } catch (_error) { return res.sendStatus(404); }
  if (!fs.existsSync(fullPath)) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="return-evidence-${id}${path.extname(fullPath)}"`);
  return new Promise((resolve, reject) => res.sendFile(fullPath, (error) => error ? reject(error) : resolve()));
}));
router.get('/customer/account/returns', requireCustomer, asyncHandler(async (req, res) => {
  const rows = await d7.listCustomerReturns(req.session.customerUser.id);
  const returns = rows.map((item) => ({ ...item, statusLabel: statusLabel(item.status, isEn(req)), dateLabel: evidenceDate(item.created_at, req.locale), evidenceAvailable: /^return-evidence\/[A-Za-z0-9-]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(String(item.evidence_path || '')) }));
  return res.render('customer/returns', { returns, isEn: isEn(req) });
}));
router.post('/customer/account/orders/:id/refunds', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const amountRaw = String(req.body.amount_paisa || '');
  const amount = Number(amountRaw);
  if (!Number.isSafeInteger(id) || id < 1 || !/^[1-9][0-9]*$/.test(amountRaw) || !Number.isSafeInteger(amount)) throw new ValidationError('Order ID or refund amount is invalid.');
  const requestKey = String(req.body.request_key || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey)) throw new ValidationError('Refresh the page and submit the refund request again.');
  const order = await customers.getOrderDetails(req.session.customerUser.id, id);
  const method = String(order.order.payment_method || '').toLowerCase();
  if (method === 'cod') throw new ConflictError('COD refunds are unavailable until a verified refund destination is configured.');
  const result = await phase08.requestRefund(id, amount, req.body.reason, requestKey, { id: null, type: 'customer' });
  req.flash('success', isEn(req) ? `Refund request #${result.id} ${result.replayed ? 'was already received' : 'was submitted'}. No payment was sent.` : `রিফান্ড অনুরোধ #${result.id} ${result.replayed ? 'আগেই জমা হয়েছে' : 'জমা হয়েছে'}। কোনো অর্থ পাঠানো হয়নি।`);
  return res.redirect(`/customer/account/orders/${encodeURIComponent(id)}`);
}));
function wantsJson(req) {
  return req.xhr || (req.headers.accept && req.headers.accept.includes("application/json")) || req.is("application/json");
}

router.get("/customer/account/wishlist", requireCustomer, asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.session.wishlist) ? req.session.wishlist.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
  let wishlistItems = [];
  if (ids.length) {
    if (env.db.client === "mysql") {
      const mysql = require("../db/mysqlPool");
      const db = mysql.createQueryClient(mysql.getPool());
      const placeholders = ids.map(() => "?").join(",");
      const rows = await db.queryAll(
        `SELECT p.id, p.sku, p.slug, p.name_bn, p.name_en, p.image_url,
                p.regular_price_paisa, p.sale_price_paisa, p.stock_on_hand, p.stock_reserved,
                p.status, p.is_archived
         FROM products p
         WHERE p.id IN (${placeholders}) AND p.status = 'active' AND p.is_archived = 0`,
        ids
      );
      wishlistItems = rows.map((p) => {
        const price = (Number(p.sale_price_paisa) > 0 ? Number(p.sale_price_paisa) : Number(p.regular_price_paisa)) / 100;
        const available = Math.max(0, Number(p.stock_on_hand || 0) - Number(p.stock_reserved || 0));
        return {
          id: p.id,
          sku: p.sku,
          slug: p.slug,
          name: isEn(req) ? (p.name_en || p.name_bn) : (p.name_bn || p.name_en),
          image: p.image_url || "/uploads/brand/mrtumi-placeholder-logo.svg",
          price,
          inStock: available > 0,
          stockQty: available,
        };
      });
    } else {
      const sqlite = require("../db/sqlite");
      const placeholders = ids.map(() => "?").join(",");
      const rows = sqlite.prepare(`SELECT * FROM products WHERE id IN (${placeholders}) AND status = 'active'`).all(...ids);
      wishlistItems = rows.map((p) => ({
        id: p.id,
        sku: p.sku || "",
        slug: p.slug || p.id,
        name: p.name || p.name_bn || "",
        image: p.image || "/uploads/brand/mrtumi-placeholder-logo.svg",
        price: Number(p.new_price || p.price || 0),
        inStock: Number(p.stock || 0) > 0,
        stockQty: Number(p.stock || 0),
      }));
    }
  }
  return res.render("customer/wishlist", {
    title: isEn(req) ? "My Wishlist" : "???? ??????? ??????",
    isEn: isEn(req),
    items: wishlistItems,
    csrfToken: req.csrfToken(),
  });
}));

router.post("/customer/account/wishlist/add", requireCsrf, asyncHandler(async (req, res) => {
  const productId = parseInt(req.body.product_id, 10);
  if (!productId || isNaN(productId)) {
    if (wantsJson(req)) return res.status(400).json({ success: false, message: "Invalid product ID" });
    req.flash("error", isEn(req) ? "Invalid product" : "???????? ????");
    return res.redirect(safeReferrer(req, "/customer/account/wishlist"));
  }
  if (!Array.isArray(req.session.wishlist)) {
    req.session.wishlist = [];
  }
  if (!req.session.wishlist.includes(productId)) {
    req.session.wishlist.push(productId);
  }
  if (wantsJson(req)) {
    return res.json({ success: true, count: req.session.wishlist.length, inWishlist: true });
  }
  req.flash("success", isEn(req) ? "Added to wishlist" : "??????? ???????? ??? ??? ??????");
  return res.redirect(safeReferrer(req, "/customer/account/wishlist"));
}));

router.post("/customer/account/wishlist/remove", requireCsrf, asyncHandler(async (req, res) => {
  const productId = parseInt(req.body.product_id, 10);
  if (Array.isArray(req.session.wishlist) && productId) {
    req.session.wishlist = req.session.wishlist.filter((id) => Number(id) !== Number(productId));
  }
  if (wantsJson(req)) {
    return res.json({ success: true, count: (req.session.wishlist || []).length, inWishlist: false });
  }
  req.flash("success", isEn(req) ? "Removed from wishlist" : "??????? ?????? ???? ????? ??????");
  return res.redirect(safeReferrer(req, "/customer/account/wishlist"));
}));

module.exports = router;
