'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { asyncHandler } = require('../utils/asyncHandler');
const { createRateLimiter } = require('../middleware/rateLimit');
const { requireCustomer } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const customers = require('../repositories/customerRepository');
const router = express.Router();
const loginLimiter = createRateLimiter({ keyPrefix: 'customer-login', windowMs: 15 * 60 * 1000, max: 10 });
const registerLimiter = createRateLimiter({ keyPrefix: 'customer-register', windowMs: 60 * 60 * 1000, max: 5 });
const isEn = (req) => req.locale === 'en';
function formPage(req, res, title, error = '') { return res.status(error ? 400 : 200).render('customer/account-form', { title, error, isEn: isEn(req), customer: req.session.customerUser || null }); }
router.get('/customer/register', (req, res) => formPage(req, res, isEn(req) ? 'Create account' : 'অ্যাকাউন্ট তৈরি করুন'));
router.post('/customer/register', registerLimiter, requireCsrf, asyncHandler(async (req, res) => {
  const account = await customers.registerCustomer(req.body);
  await new Promise((resolve, reject) => req.session.regenerate((err) => err ? reject(err) : resolve()));
  req.session.customerUser = account;
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
  req.session.cart = guestCart;
  await customers.mergeCart(customer.id, guestCart);
  return res.redirect('/customer/account');
}));
router.post('/customer/logout', requireCsrf, (req, res) => req.session.destroy(() => res.redirect('/customer/login')));
router.get('/customer/account', requireCustomer, asyncHandler(async (req, res) => res.render('customer/account', { addresses: await customers.listAddresses(req.session.customerUser.id), isEn: isEn(req) })));
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
