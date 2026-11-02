'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { requirePermission } = require('../middleware/rbac');
const { env } = require('../config/env');
const repo = require('../repositories/adminResellerCommerceRepository');
const settlementRepo = require('../repositories/partnerSettlementRepository');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const actor = (req) => ({ id: req.adminUser?.id || null, ip: req.ip || '', userAgent: req.get('user-agent') || '' });
router.use('/admin/reseller-commerce', requireAdmin, requirePermission('resellers.manage'));
const write = (handler) => [requireCsrf, asyncHandler(handler)];

router.get('/admin/reseller-commerce', asyncHandler(async (req, res) => {
  if (env.db.client !== 'mysql') return res.status(503).render('admin/error', { message: 'Reseller commerce administration requires MySQL.' });
  const settings = await repo.getCommerceSettings();
  const [products, resellers, subOrders, codShipments, wallets, settlements, withdrawals, audit] = await Promise.all([
    repo.listProducts({ search: String(req.query.product || '').slice(0, 80) }), repo.listResellers(),
    repo.listVendorSubOrders(), repo.listCodShipments(), repo.getWalletSummary(),
    repo.previewMaturedSettlements(Number(settings.return_window_days)), repo.listWithdrawalRequests(),
    repo.listAuditTrail({ orderId: req.query.orderId || '', resellerId: req.query.resellerId || '', reference: req.query.reference || '' }),
  ]);
  res.render('admin/reseller-commerce', { title: 'Reseller Commerce Operations', settings, products, resellers, subOrders, codShipments, wallets, settlements, withdrawals, audit,
    csrfToken: req.csrfToken ? req.csrfToken() : '', query: req.query, flash: req.session?.flash || null });
}));

router.post('/admin/reseller-commerce/settings', ...write(async (req, res) => {
  await repo.updateCommerceSettings(req.body, actor(req));
  req.session.flash = { type: 'success', message: 'Reseller pricing settings saved.' }; res.redirect('/admin/reseller-commerce#pricing');
}));
router.post('/admin/reseller-commerce/products/:id/eligibility', ...write(async (req, res) => {
  await repo.setProductEligibility(req.params.id, req.body, actor(req));
  req.session.flash = { type: 'success', message: 'Product eligibility updated.' }; res.redirect('/admin/reseller-commerce#pricing');
}));
router.post('/admin/reseller-commerce/resellers/:id/status', ...write(async (req, res) => {
  await repo.setResellerStatus(req.params.id, req.body.action, actor(req));
  req.session.flash = { type: 'success', message: 'Reseller status updated.' }; res.redirect('/admin/reseller-commerce#partners');
}));
router.post('/admin/reseller-commerce/resellers/:id/branding', ...write(async (req, res) => {
  await repo.reviewBranding(req.params.id, req.body, actor(req));
  req.session.flash = { type: 'success', message: 'Co-branding review saved.' }; res.redirect('/admin/reseller-commerce#partners');
}));
router.post('/admin/reseller-commerce/settlements/release-matured', ...write(async (req, res) => {
  const settings = await repo.getCommerceSettings();
  const result = await settlementRepo.processMaturedSettlements({ returnWindowDays: Number(settings.return_window_days), actor: actor(req) });
  req.session.flash = { type: 'success', message: `Released ${result.releasedCount} matured sub-orders (${result.maturedCount} eligible).` };
  res.redirect('/admin/reseller-commerce#wallets');
}));
router.post('/admin/reseller-commerce/withdrawals/:type/:id', ...write(async (req, res) => {
  await repo.decideWithdrawal({ partnerType: req.params.type, requestId: req.params.id, decision: req.body.decision, reason: req.body.reason }, actor(req));
  req.session.flash = { type: 'success', message: 'Withdrawal decision recorded.' }; res.redirect('/admin/reseller-commerce#wallets');
}));

module.exports = router;
