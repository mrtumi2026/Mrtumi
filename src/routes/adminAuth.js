'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { createRateLimiter, getClientIp } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/asyncHandler');
const {
  findActiveAdminByEmail,
  recordAdminLoginSuccess,
} = require('../repositories/authRepository');
const { recordAuditLog } = require('../repositories/auditLogRepository');
const { requireCsrf } = require('../middleware/csrf');
const { logger } = require('../utils/logger');

const router = express.Router();

const adminLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 12,
  keyPrefix: 'admin-login',
  message: 'অনেকবার ভুল চেষ্টা করা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।',
});

router.get('/admin', (req, res) => {
  if (req.session && req.session.adminUser) {
    return res.redirect('/admin/dashboard');
  }
  return res.redirect('/admin/login');
});

router.get('/admin/login', (req, res) => {
  if (req.session && req.session.adminUser) {
    return res.redirect('/admin/dashboard');
  }
  return res.render('admin/login', { error: null });
});

router.post(
  '/admin/login',
  adminLoginLimiter,
  requireCsrf,
  asyncHandler(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const user = await findActiveAdminByEmail(email);
    const matches = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!user || !matches) {
      await recordAuditLog({
        actorType: 'admin',
        actorId: user ? user.id : null,
        action: 'admin.login.failed',
        entityType: 'users',
        entityId: user ? user.id : null,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || '',
      }).catch((auditError) => {
        logger.error('Failed-login audit write failed',{code:auditError&&auditError.code||'AUDIT_WRITE_FAILED',requestId:req.id||''});
      });

      return res.status(401).render('admin/login', {
        error: 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়। আবার চেষ্টা করুন।',
      });
    }

    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    req.session.adminUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      role_slug: user.role_slug,
      permissions: user.permissions || [],
      avatar: user.avatar || '/uploads/default/user.svg',
    };

    await recordAdminLoginSuccess(user.id);
    try {
      await recordAuditLog({
        actorType: 'admin',
        actorId: user.id,
        action: 'admin.login.succeeded',
        entityType: 'users',
        entityId: user.id,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent'] || '',
      });
    } catch (auditError) {
      await new Promise((resolve,reject)=>req.session.destroy(err=>err?reject(err):resolve()));
      throw auditError;
    }

    if (typeof req.flash === 'function') {
      req.flash('success', `স্বাগতম, ${user.name}! অ্যাডমিন প্যানেলে সফলভাবে লগইন হয়েছে।`);
    }
    return res.redirect('/admin/dashboard');
  })
);

async function handleLogout(req, res) {
  const actor=req.session.adminUser;
  if(actor){
    try{await recordAuditLog({actorType:'admin',actorId:actor.id,action:'admin.logout',entityType:'session',entityId:req.sessionID,ipAddress:getClientIp(req),userAgent:req.headers['user-agent']||''});}
    catch(_err){logger.error('Admin logout audit write failed',{requestId:req.id||''});}
  }
  await new Promise((resolve,reject)=>req.session.destroy(err=>err?reject(err):resolve()));
  return res.redirect('/admin/login');
}

router.post('/logout', requireCsrf, asyncHandler(handleLogout));
router.get('/logout', (_req,res) => res.redirect('/admin/dashboard'));
router.get('/admin/logout', (_req,res) => res.redirect('/admin/dashboard'));

module.exports = router;
