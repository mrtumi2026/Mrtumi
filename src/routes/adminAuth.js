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
        metadata: { email },
      }).catch(() => {});

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
    await recordAuditLog({
      actorType: 'admin',
      actorId: user.id,
      action: 'admin.login.succeeded',
      entityType: 'users',
      entityId: user.id,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
    }).catch(() => {});

    if (typeof req.flash === 'function') {
      req.flash('success', `স্বাগতম, ${user.name}! অ্যাডমিন প্যানেলে সফলভাবে লগইন হয়েছে।`);
    }
    return res.redirect('/admin/dashboard');
  })
);

function handleLogout(req, res) {
  delete req.session.adminUser;
  return res.redirect('/admin/login');
}

router.post('/logout', handleLogout);
router.get('/logout', handleLogout);
router.get('/admin/logout', handleLogout);

module.exports = router;
