'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { asyncHandler } = require('../utils/asyncHandler');
const { createRateLimiter } = require('../middleware/rateLimit');
const { requireCustomer } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const customers = require('../repositories/customerRepository');
const { formatBdt } = require('../utils/money');
const router = express.Router();
const loginLimiter = createRateLimiter({ keyPrefix: 'customer-login', windowMs: 15 * 60 * 1000, max: 10 });
const registerLimiter = createRateLimiter({ keyPrefix: 'customer-register', windowMs: 60 * 60 * 1000, max: 5 });
const isEn = (req) => req.locale === 'en';
function formPage(req, res, title, error = '') { return res.status(error ? 400 : 200).render('customer/account-form', { title, error, isEn: isEn(req), customer: req.session.customerUser || null }); }
router.get('/customer/register', (req, res) => formPage(req, res, isEn(req) ? 'Create account' : 'অ্যাকাউন্ট তৈরি করুন'));
router.post('/customer/register', registerLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const guestCart = Array.isArray(req.session.cart) ? req.session.cart : [];
  const account = await customers.registerCustomer(req.body);
  await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  req.session.customerUser = account;
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
  const [profile, addresses] = await Promise.all([customers.getProfile(id), customers.listAddresses(id)]);
  return res.render('customer/account', { profile, addresses, isEn: isEn(req) });
}));
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
  await customers.saveAddress(req.session.customerUser.id, req.body);
  return res.redirect('/customer/account');
}));
router.post('/customer/account/addresses/:id/delete', requireCustomer, requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.sendStatus(404);
  await customers.deleteAddress(req.session.customerUser.id, id);
  return res.redirect('/customer/account');
}));
module.exports = router;
