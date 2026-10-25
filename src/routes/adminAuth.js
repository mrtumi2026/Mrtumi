const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');

const router = express.Router();

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
  res.render('admin/login', { error: null });
});

router.post('/admin/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const user = db.get('SELECT * FROM users WHERE LOWER(email) = ? AND status = 1', email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('admin/login', {
      error: 'ইমেইল অথবা পাসওয়ার্ড সঠিক নয়। আবার চেষ্টা করুন।',
    });
  }

  req.session.adminUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar || '/uploads/default/user.svg',
  };
  req.flash('success', `স্বাগতম, ${user.name}! অ্যাডমিন প্যানেলে সফলভাবে লগইন হয়েছে।`);
  return res.redirect('/admin/dashboard');
});

router.post('/logout', (req, res) => {
  delete req.session.adminUser;
  res.redirect('/admin/login');
});

router.get('/logout', (req, res) => {
  delete req.session.adminUser;
  res.redirect('/admin/login');
});

module.exports = router;
