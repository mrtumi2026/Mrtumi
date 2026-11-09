'use strict';

const express = require('express');
const { requireCsrf } = require('../middleware/csrf');
const { createRateLimiter, createLoginRateLimiters } = require('../middleware/rateLimit');
const { ValidationError, ConflictError } = require('../utils/errors');
const affiliateService = require('../services/affiliateService');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const affiliateAuthLimiters = createLoginRateLimiters({
  keyPrefix: 'affiliate_auth',
  identifierFields: ['identifier'],
  windowMs: 15 * 60 * 1000,
  maxPerIp: 2000,
  maxPerIpAccount: 8,
});

function activeAffiliateSession(req) {
  return req.session && req.session.affiliateUser ? req.session.affiliateUser : null;
}

function requireAffiliate(req, res, next) {
  const aff = activeAffiliateSession(req);
  if (!aff) {
    return res.redirect('/affiliate/login');
  }
  next();
}

function establishAffiliateSession(req, aff, callback) {
  const preserved = { cart: Array.isArray(req.session.cart) ? req.session.cart : [], locale: req.session.locale };
  req.session.regenerate((error) => {
    if (error) return callback(error);
    Object.assign(req.session, preserved);
    req.session.affiliateUser = {
      id: Number(aff.id),
      affiliate_code: aff.affiliate_code,
      name: aff.name,
      phone: aff.phone,
      email: aff.email,
    };
    req.session.save(callback);
  });
}

// ─── Public Affiliate Auth Routes ───
router.get('/affiliate', (req, res) => {
  return res.redirect(activeAffiliateSession(req) ? '/affiliate/dashboard' : '/affiliate/login');
});

router.get('/affiliate/login', (req, res) => {
  if (activeAffiliateSession(req)) return res.redirect('/affiliate/dashboard');
  res.render('affiliate/auth', { mode: 'login', error: null });
});

router.post('/affiliate/login', ...affiliateAuthLimiters, requireCsrf, asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) {
    return res.status(400).render('affiliate/auth', { mode: 'login', error: 'মোবাইল নম্বর ও পাসওয়ার্ড লিখুন।' });
  }

  const aff = await affiliateService.authenticateAffiliate(identifier, password);
  if (!aff) {
    return res.status(400).render('affiliate/auth', { mode: 'login', error: 'মোবাইল নম্বর অথবা পাসওয়ার্ড সঠিক নয়।' });
  }

  return establishAffiliateSession(req, aff, (err) => {
    if (err) throw err;
    req.flash('success', `স্বাগতম, ${aff.name}! এফিলিয়েট ড্যাশবোর্ডে আপনাকে স্বাগতম।`);
    return res.redirect('/affiliate/dashboard');
  });
}));

router.get('/affiliate/register', (req, res) => {
  if (activeAffiliateSession(req)) return res.redirect('/affiliate/dashboard');
  const parentCode = req.query.sub_of || '';
  res.render('affiliate/auth', { mode: 'register', error: null, parentCode });
});

router.post('/affiliate/register', requireCsrf, asyncHandler(async (req, res) => {
  try {
    const newAff = await affiliateService.registerAffiliate(req.body);
    const authAff = await affiliateService.getAffiliateById(newAff.id);
    return establishAffiliateSession(req, authAff, (err) => {
      if (err) throw err;
      req.flash('success', 'আপনার এফিলিয়েট অ্যাকাউন্ট সফলভাবে তৈরি হয়েছে!');
      return res.redirect('/affiliate/dashboard');
    });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ConflictError) {
      return res.status(400).render('affiliate/auth', {
        mode: 'register',
        error: err.message,
        parentCode: req.body.parent_code || '',
      });
    }
    throw err;
  }
}));

router.post('/affiliate/logout', requireCsrf, (req, res) => {
  delete req.session.affiliateUser;
  res.redirect('/affiliate/login');
});

// ─── Protected Affiliate Dashboard & Actions ───
router.use('/affiliate', requireAffiliate);

router.get('/affiliate/dashboard', asyncHandler(async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const data = await affiliateService.getAffiliateDashboardData(req.session.affiliateUser.id, baseUrl);
  res.render('affiliate/dashboard', { ...data });
}));

router.get('/affiliate/links', asyncHandler(async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const data = await affiliateService.getAffiliateDashboardData(req.session.affiliateUser.id, baseUrl);
  res.render('affiliate/links', { ...data });
}));

router.post('/affiliate/links/create', requireCsrf, asyncHandler(async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const { target_url, target_type, target_id } = req.body;
  await affiliateService.createAffiliateLink(
    req.session.affiliateUser.id,
    { targetUrl: target_url, targetType: target_type || 'custom', targetId: target_id },
    baseUrl
  );
  req.flash('success', 'নতুন এফিলিয়েট লিংক সফলভাবে তৈরি হয়েছে!');
  res.redirect('/affiliate/links');
}));

router.get('/affiliate/commissions', asyncHandler(async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const data = await affiliateService.getAffiliateDashboardData(req.session.affiliateUser.id, baseUrl);
  res.render('affiliate/commissions', { ...data });
}));

router.get('/affiliate/withdrawals', asyncHandler(async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const data = await affiliateService.getAffiliateDashboardData(req.session.affiliateUser.id, baseUrl);
  res.render('affiliate/withdrawals', { ...data });
}));

router.post('/affiliate/withdrawals/create', requireCsrf, asyncHandler(async (req, res) => {
  const amountBdt = Number(req.body.amount);
  if (!amountBdt || amountBdt < 500) {
    req.flash('error', 'উত্তোলনের সর্বনিম্ন পরিমাণ ৫০০ টাকা।');
    return res.redirect('/affiliate/withdrawals');
  }

  const amountPaisa = Math.round(amountBdt * 100);
  try {
    await affiliateService.requestWithdrawal(req.session.affiliateUser.id, {
      amountPaisa,
      payoutMethod: req.body.payout_method,
      payoutAccount: req.body.payout_account,
    });
    req.flash('success', `৳${amountBdt} উত্তোলনের অনুরোধ সফলভাবে জমা হয়েছে। অ্যাডমিন পর্যালোচনা শেষে পেমেন্ট সম্পন্ন হবে।`);
  } catch (err) {
    req.flash('error', err.message);
  }
  return res.redirect('/affiliate/withdrawals');
}));

module.exports = router;
