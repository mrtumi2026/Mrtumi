'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { env } = require('../config/env');
const repo = require('../repositories/adminAffiliateRepository');
const { asyncHandler } = require('../utils/asyncHandler');

// Permissions are enforced centrally by legacyAdminRbac (finance.view / finance.manage).
const router = express.Router();
const actor = (req) => ({ id: req.adminUser?.id || null, ip: req.ip || '', userAgent: req.get('user-agent') || '' });
const unavailable = (res) => res.status(503).render('admin/error', { message: 'Affiliate administration requires MySQL.' });

router.use('/admin/affiliates', requireAdmin, (req, res, next) => (env.db.client === 'mysql' ? next() : unavailable(res)));

router.get('/admin/affiliates', asyncHandler(async (req, res) => {
  const data = await repo.getOverview();
  res.render('admin/affiliates', data);
}));

const write = (anchor, message, handler) => [requireCsrf, asyncHandler(async (req, res) => {
  try {
    await handler(req);
    req.session.flash = { type: 'success', message };
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) throw error;
    req.session.flash = { type: 'error', message: error.message };
  }
  res.redirect(`/admin/affiliates${anchor}`);
})];

router.post('/admin/affiliates/referral-settings', ...write('#referral', 'Referral settings saved.', (req) => repo.saveReferralSettings(req.body, actor(req))));
router.post('/admin/affiliates/wallet-settings', ...write('#wallet', 'Wallet payment limit saved.', (req) => repo.saveWalletSettings(req.body, actor(req))));
router.post('/admin/affiliates/:id/update', ...write('#partners', 'Affiliate updated.', (req) => repo.updateAffiliate(req.params.id, req.body, actor(req))));
router.post('/admin/affiliates/withdrawals/:id', ...write('#withdrawals', 'Withdrawal decision recorded.', (req) => repo.decideWithdrawal(req.params.id, req.body.decision, req.body.note, actor(req))));

module.exports = router;
