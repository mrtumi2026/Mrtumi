'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { asyncHandler } = require('../utils/asyncHandler');
const { createRateLimiter } = require('../middleware/rateLimit');
const { requireCustomer } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const customers = require('../repositories/customerRepository');
const privacy = require('../repositories/privacyRepository');
const { env } = require('../config/env');
const { formatBdt } = require('../utils/money');
const router = express.Router();
const loginLimiter = createRateLimiter({ keyPrefix: 'customer-login', windowMs: 15 * 60 * 1000, max: 10 });
const registerLimiter = createRateLimiter({ keyPrefix: 'customer-register', windowMs: 60 * 60 * 1000, max: 5 });
const isEn = (req) => req.locale === 'en';
function formPage(req, res, title, error = '', extras = {}) { return res.status(error ? 400 : 200).render('customer/account-form', { title, error, isEn: isEn(req), customer: req.session.customerUser || null, ...extras }); }
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
  const account = await customers.registerCustomer({ ...req.body, policyVersion: req.body.privacy_policy_version, evidence: { ip: req.ip || '', userAgent: req.get('user-agent') || '' } });
  await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  req.session.customerUser = account;
  req.session.analyticsConsent = false;
  req.session.analyticsConsentChoice = '';
  await customers.mergeCart(account.id, guestCart);
  req.session.cart = await customers.listCart(account.id, req.locale);
  return res.redirect('/customer/account');
}));
router.get('/customer/login', (req, res) => formPage(req, res, isEn(req) ? 'Customer login' : 'কাস্টমার লগইন'));
router.post('/customer/login', loginLimiter, requireCsrf, asyncHandler(async (req, res) => {
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
router.post('/customer/logout', requireCsrf, (req, res) => req.session.destroy(() => res.redirect('/customer/login')));
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
router.get('/customer/account', requireCustomer, asyncHandler(async (req, res) => {
  const id = req.session.customerUser.id;
  const [profile, addresses, consents, consentHistory, requests, acceptances, consentOptions] = await Promise.all([
    customers.getProfile(id), customers.listAddresses(id), privacy.listConsents(id), privacy.listConsentHistory(id), privacy.listCustomerRequests(id), privacy.listPolicyAcceptances(id), privacy.getEnabledConsentOptions(req.locale),
  ]);
  return res.render('customer/account', { profile, addresses, consents, consentHistory, requests, acceptances, consentOptions, isEn: isEn(req) });
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
  const details = await customers.getOrderDetails(req.session.customerUser.id, id);
  const order = { ...details.order, subtotalLabel: moneyLabel(details.order.subtotal_paisa, req.locale), discountLabel: moneyLabel(details.order.discount_paisa, req.locale), shippingLabel: moneyLabel(details.order.shipping_paisa, req.locale), totalLabel: moneyLabel(details.order.total_paisa, req.locale), dateLabel: dateLabel(details.order.created_at, req.locale) };
  const items = details.items.map((item) => ({ ...item, unitPriceLabel: moneyLabel(item.unit_price_paisa, req.locale), lineTotalLabel: moneyLabel(item.line_total_paisa, req.locale) }));
  return res.render('customer/order-detail', { order, items, isEn: isEn(req) });
}));
router.post('/customer/account/addresses', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  await customers.saveAddress(req.session.customerUser.id, req.body, { ip:req.ip||'', userAgent:req.get('user-agent')||'' });
  return res.redirect('/customer/account');
}));
router.post('/customer/account/addresses/:id/delete', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  await customers.deleteAddress(req.session.customerUser.id, id, { ip:req.ip||'', userAgent:req.get('user-agent')||'' });
  return res.redirect('/customer/account');
}));
module.exports = router;
