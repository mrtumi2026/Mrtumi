'use strict';

// MySQL handlers for admin pages that previously only had SQLite code (and therefore
// returned 503 in production). In SQLite mode every request falls through to the old handlers.

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mysql = require('../db/mysqlPool');
const { env } = require('../config/env');
const { requireAdmin } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { asyncHandler } = require('../utils/asyncHandler');
const { recordAuditLog } = require('../repositories/auditLogRepository');
const input = require('../utils/adminInput');
const { ValidationError, ConflictError, NotFoundError } = require('../utils/errors');

const router = express.Router();
const mysqlOnly = (_req, _res, next) => (env.db.client === 'mysql' ? next() : next('route'));
const actor = (req) => ({ id: req.adminUser?.id || null, ip: req.ip || '', userAgent: req.get('user-agent') || '' });

const page = (path, load) => router.get(path, mysqlOnly, requireAdmin, asyncHandler(async (req, res) => {
  res.render('admin/crud-module', await load(req));
}));

// Every write is audited; user mistakes become a message on the same page instead of an error screen.
const action = (path, back, success, handler) => router.post(path, mysqlOnly, requireAdmin, requireCsrf, asyncHandler(async (req, res) => {
  const target = typeof back === 'function' ? back(req) : back;
  try {
    const message = await mysql.withTransaction(async (tx) => {
      const result = await handler(tx, req);
      await recordAuditLog({
        actorType: 'admin', actorId: actor(req).id, action: `admin.module.${req.route.path}`.slice(0, 120),
        entityType: 'admin_module', entityId: String(req.params.id || result?.id || ''), beforeState: {}, afterState: {},
        ipAddress: actor(req).ip, userAgent: actor(req).userAgent,
      }, tx);
      return result?.message;
    });
    req.flash('success', message || success);
  } catch (error) {
    if (error.code === 'DB_DUPLICATE_ENTRY' || error.code === 'ER_DUP_ENTRY') req.flash('error', 'এই তথ্যটি ইতিমধ্যে যুক্ত আছে।');
    else if (error.statusCode && error.statusCode < 500) req.flash('error', error.message);
    else throw error;
  }
  res.redirect(target);
}));

const removeById = (table) => async (tx, req) => {
  const done = await tx.execute(`DELETE FROM ${table} WHERE id=?`, [input.id(req.params.id)]);
  if (done.affectedRows !== 1) throw new NotFoundError('রেকর্ডটি পাওয়া যায়নি।');
};

const options = async (sql, label) => (await mysql.queryAll(sql)).map((row) => ({ value: row.id, label: label(row) }));
const employeeOptions = () => options('SELECT id,name FROM employees ORDER BY id', (row) => row.name);
async function requireRow(tx, table, id, message) {
  const row = await tx.queryOne(`SELECT id FROM ${table} WHERE id=?`, [id]);
  if (!row) throw new ValidationError(message);
}
async function employeeId(tx, value) {
  const id = input.id(value, 'Employee');
  await requireRow(tx, 'employees', id, 'আগে একজন কর্মচারী যুক্ত করে নির্বাচন করুন।');
  return id;
}
const col = (key, label, type) => ({ key, label, ...(type ? { type } : {}) });
const field = (name, label, type = 'text', extra = {}) => ({ name, label, type, ...extra });
const select = (name, label, list) => ({ name, label, type: 'select', options: list });

// ─── HR ───
page('/admin/attendances', async () => ({
  pageTitle: 'Employee Attendance', subtitle: 'দৈনিক হাজিরা ও অফিস সময় লগ',
  createAction: '/admin/attendances/create', deletePrefix: '/admin/attendances/delete',
  columns: [col('id', '#'), col('employee_name', 'Employee'), col('att_date', 'Date'), col('check_in', 'Check In'), col('check_out', 'Check Out'), col('status', 'Status', 'badge')],
  fields: [select('employee_id', 'Employee', await employeeOptions()), field('att_date', 'Date', 'date', { value: input.today() }),
    field('check_in', 'Check In', 'text', { value: '09:00 AM' }), field('check_out', 'Check Out', 'text', { value: '06:00 PM' }),
    select('status', 'Attendance Status', ['Present', 'Late', 'Absent'].map((v) => ({ value: v, label: v })))],
  rows: await mysql.queryAll(`SELECT a.id,e.name AS employee_name,DATE_FORMAT(a.att_date,'%Y-%m-%d') AS att_date,a.check_in,a.check_out,a.status
    FROM attendances a LEFT JOIN employees e ON e.id=a.employee_id ORDER BY a.id DESC LIMIT 500`),
}));
action('/admin/attendances/create', '/admin/attendances', 'হাজিরা রেকর্ড সংরক্ষিত হয়েছে।', async (tx, req) => {
  const b = req.body;
  await tx.execute('INSERT INTO attendances(employee_id,att_date,check_in,check_out,status) VALUES(?,?,?,?,?)', [
    await employeeId(tx, b.employee_id), input.date(b.att_date), input.optional(b.check_in, 16), input.optional(b.check_out, 16),
    input.choice(b.status, ['Present', 'Late', 'Absent'], 'Status')]);
});
action('/admin/attendances/delete/:id', '/admin/attendances', 'মুছে ফেলা হয়েছে।', removeById('attendances'));

page('/admin/leaves', async () => ({
  pageTitle: 'Employee Leaves', subtitle: 'ছুটির আবেদন ও অনুমোদন ব্যবস্থাপনা',
  createAction: '/admin/leaves/create', deletePrefix: '/admin/leaves/delete', customActionPrefix: '/admin/leaves/approve', customActionLabel: 'Approve',
  columns: [col('id', '#'), col('employee_name', 'Employee'), col('leave_type', 'Leave Type'), col('from_date', 'From'), col('to_date', 'To'), col('reason', 'Reason'), col('status', 'Status', 'badge')],
  fields: [select('employee_id', 'Employee', await employeeOptions()), field('leave_type', 'Leave Type', 'text', { value: 'Casual Leave' }),
    field('from_date', 'From Date', 'date', { value: input.today() }), field('to_date', 'To Date', 'date', { value: input.today() }), field('reason', 'Reason')],
  rows: await mysql.queryAll(`SELECT l.id,e.name AS employee_name,l.leave_type,DATE_FORMAT(l.from_date,'%Y-%m-%d') AS from_date,
    DATE_FORMAT(l.to_date,'%Y-%m-%d') AS to_date,l.reason,l.status FROM leaves l LEFT JOIN employees e ON e.id=l.employee_id ORDER BY l.id DESC LIMIT 500`),
}));
action('/admin/leaves/create', '/admin/leaves', 'ছুটির আবেদন যুক্ত হয়েছে।', async (tx, req) => {
  const b = req.body;
  const from = input.date(b.from_date), to = input.date(b.to_date);
  if (to < from) throw new ValidationError('শেষের তারিখ শুরুর তারিখের আগে হতে পারে না।');
  await tx.execute("INSERT INTO leaves(employee_id,leave_type,from_date,to_date,reason,status) VALUES(?,?,?,?,?,'pending')",
    [await employeeId(tx, b.employee_id), input.required(b.leave_type, 48, 'Leave type'), from, to, input.optional(b.reason, 255)]);
});
action('/admin/leaves/approve/:id', '/admin/leaves', 'ছুটি অনুমোদিত হয়েছে।', async (tx, req) => {
  const done = await tx.execute("UPDATE leaves SET status='approved',approved_by_user_id=? WHERE id=? AND status='pending'", [actor(req).id, input.id(req.params.id)]);
  if (done.affectedRows !== 1) throw new ConflictError('শুধু অপেক্ষমাণ আবেদন অনুমোদন করা যায়।');
});
action('/admin/leaves/delete/:id', '/admin/leaves', 'মুছে ফেলা হয়েছে।', removeById('leaves'));

const salaryPage = (title) => async () => ({
  pageTitle: title, subtitle: 'মাসিক বেতন শিট ও পরিশোধের বিবরণী',
  createAction: '/admin/salaries/create', deletePrefix: '/admin/salaries/delete',
  columns: [col('id', '#'), col('employee_name', 'Employee'), col('month', 'Month'), col('basic_amount', 'Basic', 'currency'), col('bonus', 'Bonus', 'currency'), col('deduction', 'Deduction', 'currency'), col('net_salary', 'Net Paid', 'currency'), col('status', 'Status', 'badge')],
  fields: [select('employee_id', 'Employee', await options('SELECT id,name,base_salary_paisa FROM employees ORDER BY id', (e) => `${e.name} (৳${Number(e.base_salary_paisa) / 100})`)),
    field('month', 'Salary Month', 'text', { value: input.today().slice(0, 7), required: true }), field('basic_amount', 'Basic Salary (৳)', 'number', { required: true }),
    field('bonus', 'Bonus (৳)', 'number', { value: '0' }), field('deduction', 'Deduction (৳)', 'number', { value: '0' })],
  rows: await mysql.queryAll(`SELECT s.id,e.name AS employee_name,s.salary_month AS month,s.basic_paisa/100 AS basic_amount,s.bonus_paisa/100 AS bonus,
    s.deduction_paisa/100 AS deduction,s.net_salary_paisa/100 AS net_salary,s.status FROM salaries s LEFT JOIN employees e ON e.id=s.employee_id ORDER BY s.id DESC LIMIT 500`),
});
page('/admin/salaries', salaryPage('Salary Sheet'));
page('/admin/salary-payments', salaryPage('Salary Payments'));
action('/admin/salaries/create', '/admin/salaries', 'বেতন রেকর্ড হয়েছে।', async (tx, req) => {
  const b = req.body;
  const basic = input.taka(b.basic_amount, 'Basic salary'), bonus = input.taka(b.bonus || 0, 'Bonus'), deduction = input.taka(b.deduction || 0, 'Deduction');
  const net = basic + bonus - deduction;
  if (net < 0) throw new ValidationError('কর্তন মোট বেতনের চেয়ে বেশি হতে পারে না।');
  await tx.execute("INSERT INTO salaries(employee_id,salary_month,basic_paisa,bonus_paisa,deduction_paisa,net_salary_paisa,status,approved_by_user_id,paid_date) VALUES(?,?,?,?,?,?,'paid',?,?)",
    [await employeeId(tx, b.employee_id), input.required(b.month, 16, 'Month'), basic, bonus, deduction, net, actor(req).id, input.today()]);
});
action('/admin/salaries/delete/:id', '/admin/salaries', 'মুছে ফেলা হয়েছে।', removeById('salaries'));

page('/admin/bonuses', async () => ({
  pageTitle: 'Festival & Performance Bonuses', subtitle: 'কর্মচারীদের উৎসব ও পারফরম্যান্স বোনাস তালিকা',
  createAction: '/admin/bonuses/create', deletePrefix: '/admin/bonuses/delete',
  columns: [col('id', '#'), col('employee_name', 'Employee'), col('title', 'Bonus Title'), col('amount', 'Amount', 'currency'), col('bonus_date', 'Date')],
  fields: [select('employee_id', 'Employee', await employeeOptions()), field('title', 'Bonus Title', 'text', { required: true }), field('amount', 'Amount (৳)', 'number', { required: true })],
  rows: await mysql.queryAll(`SELECT b.id,e.name AS employee_name,b.title,b.amount_paisa/100 AS amount,DATE_FORMAT(b.bonus_date,'%Y-%m-%d') AS bonus_date
    FROM bonuses b LEFT JOIN employees e ON e.id=b.employee_id ORDER BY b.id DESC LIMIT 500`),
}));
action('/admin/bonuses/create', '/admin/bonuses', 'বোনাস যুক্ত হয়েছে।', async (tx, req) => {
  await tx.execute('INSERT INTO bonuses(employee_id,title,amount_paisa,bonus_date) VALUES(?,?,?,?)',
    [await employeeId(tx, req.body.employee_id), input.required(req.body.title, 191, 'Title'), input.positiveTaka(req.body.amount), input.today()]);
});
action('/admin/bonuses/delete/:id', '/admin/bonuses', 'মুছে ফেলা হয়েছে।', removeById('bonuses'));

// ─── Newsletter ───
page('/admin/newsletter-subscribers', async () => ({
  pageTitle: 'Newsletter Subscribers', subtitle: 'অফার ও আপডেট পেতে সাবস্ক্রাইব করা গ্রাহকদের তালিকা',
  createAction: '/admin/newsletter-subscribers/create', deletePrefix: '/admin/newsletter-subscribers/delete',
  columns: [col('id', '#'), col('email_or_phone', 'Email / Phone'), col('status', 'Status', 'status'), col('created_at', 'Subscribed At')],
  fields: [field('email_or_phone', 'Email or Phone', 'text', { required: true })],
  rows: await mysql.queryAll("SELECT id,email_or_phone,status,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i') AS created_at FROM newsletter_subscribers ORDER BY id DESC LIMIT 1000"),
}));
action('/admin/newsletter-subscribers/create', '/admin/newsletter-subscribers', 'সাবস্ক্রাইবার যুক্ত হয়েছে।', async (tx, req) => {
  await tx.execute('INSERT INTO newsletter_subscribers(email_or_phone,status) VALUES(?,1)', [input.required(req.body.email_or_phone, 191, 'Email or phone')]);
});
action('/admin/newsletter-subscribers/delete/:id', '/admin/newsletter-subscribers', 'মুছে ফেলা হয়েছে।', removeById('newsletter_subscribers'));

// ─── Delivery riders, rider payouts, delivery areas ───
page('/admin/delivery-boys', async () => ({
  pageTitle: 'Delivery Persons / Riders', subtitle: 'নিজস্ব ডেলিভারি রাইডার ও কমিশন ব্যবস্থাপনা',
  createAction: '/admin/delivery-boys/create', deletePrefix: '/admin/delivery-boys/delete',
  columns: [col('id', '#'), col('name', 'Rider Name'), col('phone', 'Phone'), col('area', 'Assigned Zone'), col('vehicle_type', 'Vehicle'), col('commission_per_order', 'Per Order (৳)', 'currency'), col('balance', 'Wallet', 'currency'), col('status', 'Status', 'status')],
  fields: [field('name', 'Rider Name', 'text', { required: true }), field('phone', 'Phone Number', 'text', { required: true }),
    field('area', 'Delivery Zone', 'text', { value: 'ঢাকা সিটি' }), field('vehicle_type', 'Vehicle', 'text', { value: 'মোটরসাইকেল' }),
    field('commission_per_order', 'Commission Per Order (৳)', 'number', { value: '50' })],
  rows: await mysql.queryAll('SELECT id,name,phone,area,vehicle_type,commission_per_order_paisa/100 AS commission_per_order,balance_paisa/100 AS balance,status FROM delivery_boys ORDER BY id DESC'),
}));
action('/admin/delivery-boys/create', '/admin/delivery-boys', 'ডেলিভারি রাইডার যুক্ত হয়েছে।', async (tx, req) => {
  const b = req.body;
  await tx.execute('INSERT INTO delivery_boys(name,phone,area,vehicle_type,commission_per_order_paisa) VALUES(?,?,?,?,?)',
    [input.required(b.name, 191, 'Name'), input.required(b.phone, 32, 'Phone'), input.optional(b.area, 120), input.optional(b.vehicle_type, 64), input.taka(b.commission_per_order || 0, 'Commission')]);
});
action('/admin/delivery-boys/delete/:id', '/admin/delivery-boys', 'মুছে ফেলা হয়েছে।', removeById('delivery_boys'));

page('/admin/delivery-withdrawals', async () => ({
  pageTitle: 'Rider Withdrawals', subtitle: 'ডেলিভারি রাইডারদের কমিশন উত্তোলন',
  createAction: '/admin/delivery-withdrawals/create', customActionPrefix: '/admin/delivery-withdrawals/approve', customActionLabel: 'Mark Paid', customActionHideWhenPaid: true,
  deletePrefix: '/admin/delivery-withdrawals/delete',
  columns: [col('id', '#'), col('rider_name', 'Rider'), col('amount', 'Amount', 'currency'), col('method', 'Method'), col('account_number', 'Account No'), col('status', 'Status', 'badge')],
  fields: [select('delivery_boy_id', 'Rider', await options('SELECT id,name FROM delivery_boys ORDER BY id', (r) => r.name)),
    field('amount', 'Amount (৳)', 'number', { required: true }), field('method', 'Method', 'text', { value: 'bKash' }), field('account_number', 'Account No', 'text', { required: true })],
  rows: await mysql.queryAll(`SELECT w.id,d.name AS rider_name,w.amount_paisa/100 AS amount,w.method,w.account_number,w.status
    FROM delivery_withdrawals w LEFT JOIN delivery_boys d ON d.id=w.delivery_boy_id ORDER BY w.id DESC LIMIT 500`),
}));
action('/admin/delivery-withdrawals/create', '/admin/delivery-withdrawals', 'রেকর্ড যুক্ত হয়েছে।', async (tx, req) => {
  const rider = input.id(req.body.delivery_boy_id, 'Rider');
  await requireRow(tx, 'delivery_boys', rider, 'আগে একজন রাইডার যুক্ত করে নির্বাচন করুন।');
  await tx.execute("INSERT INTO delivery_withdrawals(delivery_boy_id,amount_paisa,method,account_number,status) VALUES(?,?,?,?,'pending')",
    [rider, input.positiveTaka(req.body.amount), input.required(req.body.method, 64, 'Method'), input.required(req.body.account_number, 100, 'Account number')]);
});
action('/admin/delivery-withdrawals/approve/:id', '/admin/delivery-withdrawals', 'পরিশোধিত হিসেবে চিহ্নিত হয়েছে।', async (tx, req) => {
  const done = await tx.execute("UPDATE delivery_withdrawals SET status='paid' WHERE id=? AND status='pending'", [input.id(req.params.id)]);
  if (done.affectedRows !== 1) throw new ConflictError('শুধু অপেক্ষমাণ রেকর্ড পরিশোধিত করা যায়।');
});
action('/admin/delivery-withdrawals/delete/:id', '/admin/delivery-withdrawals', 'মুছে ফেলা হয়েছে।', async (tx, req) => {
  const done = await tx.execute("DELETE FROM delivery_withdrawals WHERE id=? AND status<>'paid'", [input.id(req.params.id)]);
  if (done.affectedRows !== 1) throw new ConflictError('পরিশোধিত আর্থিক রেকর্ড মুছে ফেলা যায় না।');
});

page('/admin/delivery/divisions', async () => ({
  pageTitle: 'Delivery Locations (Division → District → Upazila)', subtitle: 'বিভাগ, জেলা ও উপজেলা ভিত্তিক ডেলিভারি চার্জ নির্ধারণ করুন',
  createAction: '/admin/delivery/divisions/create', deletePrefix: '/admin/delivery/divisions/delete',
  columns: [col('id', '#'), col('division', 'Division'), col('district', 'District'), col('upazila', 'Upazila / Thana'), col('delivery_charge', 'Delivery Charge', 'currency'), col('status', 'Active', 'status')],
  fields: [field('division', 'Division (বিভাগ)', 'text', { required: true }), field('district', 'District (জেলা)', 'text', { required: true }),
    field('upazila', 'Upazila (উপজেলা/থানা)', 'text', { required: true }), field('delivery_charge', 'Delivery Charge (৳)', 'number', { value: '120', required: true })],
  rows: await mysql.queryAll('SELECT id,division,district,upazila,delivery_charge_paisa/100 AS delivery_charge,status FROM delivery_locations ORDER BY id DESC'),
}));
action('/admin/delivery/divisions/create', '/admin/delivery/divisions', 'ডেলিভারি লোকেশন যুক্ত হয়েছে।', async (tx, req) => {
  const b = req.body;
  await tx.execute('INSERT INTO delivery_locations(division,district,upazila,delivery_charge_paisa,status) VALUES(?,?,?,?,1)',
    [input.required(b.division, 80, 'Division'), input.required(b.district, 80, 'District'), input.optional(b.upazila, 80), input.taka(b.delivery_charge, 'Delivery charge')]);
});
action('/admin/delivery/divisions/delete/:id', '/admin/delivery/divisions', 'মুছে ফেলা হয়েছে।', removeById('delivery_locations'));

// ─── Storefront content ───
page('/admin/social-media/manage', async () => ({
  pageTitle: 'Social Media Links', subtitle: 'ওয়েবসাইটের হেডার ও ফুটারে প্রদর্শিত সোশ্যাল মিডিয়া লিংকসমূহ',
  createAction: '/admin/social-media/create', deletePrefix: '/admin/social-media/delete',
  columns: [col('id', '#'), col('platform', 'Platform'), col('url', 'Profile URL'), col('status', 'Active', 'status')],
  fields: [field('platform', 'Platform (Facebook / WhatsApp / YouTube)', 'text', { required: true }), field('url', 'URL', 'text', { required: true })],
  rows: await mysql.queryAll('SELECT id,platform,url,status FROM social_links ORDER BY id'),
}));
action('/admin/social-media/create', '/admin/social-media/manage', 'লিংক যুক্ত হয়েছে।', async (tx, req) => {
  await tx.execute('INSERT INTO social_links(platform,url) VALUES(?,?)', [input.required(req.body.platform, 64, 'Platform'), input.httpUrl(req.body.url)]);
});
action('/admin/social-media/delete/:id', '/admin/social-media/manage', 'মুছে ফেলা হয়েছে।', removeById('social_links'));

page('/admin/features/manage', async () => ({
  pageTitle: 'Storefront Feature Bar', subtitle: 'হোমপেজ ও ফুটারের ট্রাস্ট ব্যাজ ফিচার বার',
  createAction: '/admin/features/create', deletePrefix: '/admin/features/delete',
  columns: [col('id', '#'), col('title', 'Title'), col('subtitle', 'Subtitle'), col('icon', 'Feather Icon'), col('status', 'Active', 'status')],
  fields: [field('title', 'Title', 'text', { required: true }), field('subtitle', 'Subtitle', 'text', { required: true }), field('icon', 'Icon Name (shield / truck / check-circle)', 'text', { value: 'shield' })],
  rows: await mysql.queryAll('SELECT id,title_bn AS title,subtitle_bn AS subtitle,icon,status FROM features ORDER BY id'),
}));
action('/admin/features/create', '/admin/features/manage', 'ফিচার যুক্ত হয়েছে।', async (tx, req) => {
  await tx.execute('INSERT INTO features(title_bn,subtitle_bn,icon) VALUES(?,?,?)',
    [input.required(req.body.title, 191, 'Title'), input.required(req.body.subtitle, 255, 'Subtitle'), input.optional(req.body.icon, 80) || 'shield']);
});
action('/admin/features/delete/:id', '/admin/features/manage', 'মুছে ফেলা হয়েছে।', removeById('features'));

page('/admin/page/manage', async () => ({
  pageTitle: 'Custom Pages (CMS)', subtitle: 'প্রাইভেসি পলিসি, রিটার্ন পলিসি ও আমাদের সম্পর্কে পেজ তৈরি করুন',
  createAction: '/admin/page/create', deletePrefix: '/admin/page/delete', publicLinkPrefix: '/page', publicLinkKey: 'slug',
  columns: [col('id', '#'), col('title', 'Page Title'), col('slug', 'URL Slug'), col('status', 'Active', 'status')],
  fields: [field('title', 'Page Title', 'text', { required: true }), field('slug', 'URL Slug (e.g. refund-policy)', 'text', { required: true }), field('content', 'Page Content', 'textarea', { required: true })],
  rows: await mysql.queryAll('SELECT id,title_bn AS title,slug,status FROM cms_pages ORDER BY id'),
}));
action('/admin/page/create', '/admin/page/manage', 'পেজ তৈরি হয়েছে।', async (tx, req) => {
  await tx.execute('INSERT INTO cms_pages(title_bn,slug,content_bn,status) VALUES(?,?,?,1)',
    [input.required(req.body.title, 255, 'Title'), input.slug(req.body.slug || req.body.title), input.required(req.body.content, 100000, 'Content')]);
});
action('/admin/page/delete/:id', '/admin/page/manage', 'মুছে ফেলা হয়েছে।', removeById('cms_pages'));

// ─── Landing page campaigns ───
const campaignPage = (openModal) => async () => ({
  pageTitle: 'Landing Page Campaigns', subtitle: 'সিঙ্গেল প্রোডাক্ট হাই-কনভার্টিং ল্যান্ডিং পেজ তৈরি ও লাইভ লিংক কপি করুন',
  createAction: '/admin/campaign/create', deletePrefix: '/admin/campaign/delete', publicLinkPrefix: '/campaign', publicLinkKey: 'slug', autoOpenModal: openModal,
  columns: [col('id', '#'), col('title', 'Campaign Title'), col('product_name', 'Linked Product'), col('slug', 'URL Slug'), col('offer_price', 'Offer Price', 'currency'), col('status', 'Status', 'status')],
  fields: [field('title', 'Campaign Title', 'text', { required: true }), field('slug', 'Landing Page Slug (e.g. mango-fest)', 'text', { required: true }),
    select('product_id', 'Target Product', await options("SELECT id,name_bn,sale_price_paisa,regular_price_paisa FROM products WHERE status=1 AND is_archived=0 AND approval_status='approved' ORDER BY id DESC LIMIT 500",
      (p) => `${p.name_bn} (৳${Number(p.sale_price_paisa || p.regular_price_paisa) / 100})`)),
    field('headline', 'Hero Headline (বাংলা)', 'text', { required: true }), field('subheadline', 'Subheadline'),
    field('regular_price', 'Regular Price (৳)', 'number'), field('offer_price', 'Offer Price (৳)', 'number', { required: true }),
    field('benefits', 'Key Benefits (separate with |)', 'textarea')],
  rows: await mysql.queryAll(`SELECT c.id,c.title,p.name_bn AS product_name,c.slug,c.offer_price_paisa/100 AS offer_price,c.status
    FROM campaigns c LEFT JOIN products p ON p.id=c.product_id ORDER BY c.id DESC`),
});
page('/admin/campaign/manage', campaignPage(false));
page('/admin/campaign/create', campaignPage(true));
action('/admin/campaign/create', '/admin/campaign/manage', 'ল্যান্ডিং পেজ তৈরি হয়েছে!', async (tx, req) => {
  const b = req.body;
  const productId = input.id(b.product_id, 'Product');
  await requireRow(tx, 'products', productId, 'একটি অনুমোদিত পণ্য নির্বাচন করুন।');
  const title = input.required(b.title, 255, 'Title');
  const slug = input.slug(b.slug || title);
  const benefits = input.optional(b.benefits, 4000).split('|').map((item) => item.trim()).filter(Boolean);
  await tx.execute(`INSERT INTO campaigns(title,slug,product_id,headline,subheadline,regular_price_paisa,offer_price_paisa,benefits_json,publish_state,status)
    VALUES(?,?,?,?,?,?,?,?,'published',1)`, [title, slug, productId, input.optional(b.headline, 255) || title, input.optional(b.subheadline, 2000),
    input.taka(b.regular_price || 0, 'Regular price'), input.positiveTaka(b.offer_price), JSON.stringify(benefits)]);
  return { message: `ল্যান্ডিং পেজ তৈরি হয়েছে! ভিজিট করুন: /campaign/${slug}` };
});
action('/admin/campaign/delete/:id', '/admin/campaign/manage', 'মুছে ফেলা হয়েছে।', removeById('campaigns'));

// ─── Ads results (real order totals only) ───
async function adsData(channel) {
  const totals = (where) => mysql.queryOne(`SELECT COUNT(*) AS c, COALESCE(SUM(total_paisa),0)/100 AS rev FROM orders WHERE order_status NOT IN ('cancelled','failed') AND ${where}`);
  const [fbOrders, directOrders, otherOrders, settings] = await Promise.all([
    totals("traffic_source='Facebook'"), totals("(traffic_source='Direct' OR traffic_source='' OR traffic_source IS NULL)"),
    totals("traffic_source NOT IN ('Facebook','Direct','')"),
    mysql.queryAll("SELECT setting_key,setting_value FROM settings WHERE setting_key LIKE '%\\_ads\\_%'"),
  ]);
  return { channel, fbOrders, directOrders, otherOrders, adSettings: Object.fromEntries(settings.map((s) => [s.setting_key, s.setting_value])) };
}
router.get(['/admin/ads-analytics', '/admin/ads-analytics/:channel'], mysqlOnly, requireAdmin, asyncHandler(async (req, res) => {
  const channel = ['facebook', 'google', 'tiktok'].includes(req.params.channel) ? req.params.channel : 'overview';
  res.render('admin/ads-analytics', await adsData(channel));
}));

// ─── Error log ───
page('/admin/error-log', async () => ({
  pageTitle: 'System & Activity Logs', subtitle: 'সার্ভার ইভেন্ট ও সিস্টেম লগসমূহ', deletePrefix: '/admin/error-log/delete',
  columns: [col('id', '#'), col('level', 'Level', 'badge'), col('message', 'Message'), col('context', 'Context'), col('created_at', 'Timestamp')], fields: [],
  rows: await mysql.queryAll("SELECT id,level,message,LEFT(COALESCE(context_json,''),300) AS context,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS created_at FROM error_logs ORDER BY id DESC LIMIT 100"),
}));
action('/admin/error-log/delete/:id', '/admin/error-log', 'মুছে ফেলা হয়েছে।', removeById('error_logs'));
action('/admin/clear-cache', (req) => req.get('Referrer') || '/admin/dashboard', 'সিস্টেম ক্যাশ ক্লিয়ার হয়েছে।', async (tx) => {
  await tx.execute("INSERT INTO error_logs(level,code,message,context_json) VALUES('INFO','CACHE_CLEAR','Application cache cleared by Admin','{}')");
});

// ─── Fund ledger & expenses ───
page('/admin/fund', async () => {
  const finance = require('../repositories/adminFinanceReadRepository');
  const [rows, summary] = await Promise.all([finance.listFundTransactions(), finance.getFundSummary()]);
  return {
    pageTitle: `Fund / Account Ledger (Balance: ৳${summary.balance})`, subtitle: `Credits ৳${summary.credits} · Debits ৳${summary.debits}`,
    createAction: '/admin/fund/create', deletePrefix: '/admin/fund/delete',
    columns: [col('id', '#'), col('account_name', 'Account'), col('type', 'Type', 'badge'), col('amount', 'Amount (৳)', 'currency'), col('note', 'Note / Particulars'), col('tx_date', 'Date')],
    rows: rows.map((r) => ({ ...r, tx_date: input.dateText(r.tx_date) })),
    fields: [field('account_name', 'Account', 'text', { value: 'Main Business Fund', required: true }),
      select('type', 'Type', [{ value: 'credit', label: 'Credit (জমা)' }, { value: 'debit', label: 'Debit (খরচ)' }]),
      field('amount', 'Amount (৳)', 'number', { required: true }), field('note', 'Note'), field('tx_date', 'Date', 'date', { value: input.today() })],
  };
});
action('/admin/fund/create', '/admin/fund', 'ফান্ড ট্রানজেকশন সংরক্ষিত হয়েছে!', async (tx, req) => {
  const b = req.body;
  await tx.execute('INSERT INTO fund_transactions(account_name,tx_type,amount_paisa,note,tx_date,created_by_user_id) VALUES(?,?,?,?,?,?)',
    [input.required(b.account_name, 100, 'Account'), input.choice(b.type, ['credit', 'debit'], 'Type'), input.positiveTaka(b.amount), input.optional(b.note, 255), input.date(b.tx_date || input.today()), actor(req).id]);
});
action('/admin/fund/delete/:id', '/admin/fund', 'মুছে ফেলা হয়েছে।', removeById('fund_transactions'));

page('/admin/expenses', async () => ({
  pageTitle: 'Daily & Monthly Expenses', subtitle: 'প্যাকেজিং, মার্কেটিং, পরিবহন ও অফিস খরচের হিসাব',
  createAction: '/admin/expenses/create', deletePrefix: '/admin/expenses/delete',
  columns: [col('id', '#'), col('title', 'Expense Title'), col('category', 'Category'), col('amount', 'Amount (৳)', 'currency'), col('note', 'Note'), col('expense_date', 'Date')],
  rows: (await require('../repositories/adminFinanceReadRepository').listExpenses()).map((r) => ({ ...r, expense_date: input.dateText(r.expense_date) })),
  fields: [field('title', 'Title', 'text', { required: true }), field('category', 'Category', 'text', { value: 'অপারেশন' }),
    field('amount', 'Amount (৳)', 'number', { required: true }), field('note', 'Note'), field('expense_date', 'Date', 'date', { value: input.today() })],
}));
action('/admin/expenses/create', '/admin/expenses', 'খরচ যুক্ত হয়েছে এবং ফান্ড ব্যালেন্স সমন্বয় করা হয়েছে!', async (tx, req) => {
  const b = req.body;
  const title = input.required(b.title, 191, 'Title'), amount = input.positiveTaka(b.amount), date = input.date(b.expense_date || input.today());
  await tx.execute('INSERT INTO expenses(title,category,amount_paisa,note,expense_date,created_by_user_id) VALUES(?,?,?,?,?,?)',
    [title, input.optional(b.category, 100) || 'অপারেশন', amount, input.optional(b.note, 255), date, actor(req).id]);
  await tx.execute("INSERT INTO fund_transactions(account_name,tx_type,amount_paisa,note,tx_date,created_by_user_id) VALUES('Main Business Fund','debit',?,?,?,?)",
    [amount, `Expense: ${title}`.slice(0, 255), date, actor(req).id]);
});
// Deleting an expense posts a matching credit so the fund balance stays correct and the history survives.
action('/admin/expenses/delete/:id', '/admin/expenses', 'খরচ মুছে ফেলা হয়েছে এবং ফান্ডে সমন্বয় করা হয়েছে।', async (tx, req) => {
  const id = input.id(req.params.id);
  const row = await tx.queryOne('SELECT title,amount_paisa FROM expenses WHERE id=? FOR UPDATE', [id]);
  if (!row) throw new NotFoundError('রেকর্ডটি পাওয়া যায়নি।');
  await tx.execute('DELETE FROM expenses WHERE id=?', [id]);
  await tx.execute("INSERT INTO fund_transactions(account_name,tx_type,amount_paisa,note,tx_date,created_by_user_id) VALUES('Main Business Fund','credit',?,?,?,?)",
    [row.amount_paisa, `Reversal of deleted expense: ${row.title}`.slice(0, 255), input.today(), actor(req).id]);
});

// ─── Resellers, reseller deposits and manual withdrawal requests ───
action('/admin/resellers/create', '/admin/resellers', 'রিসেলার যুক্ত হয়েছে।', async (tx, req) => {
  const b = req.body;
  if (Number(b.balance || 0) !== 0) throw new ValidationError('ওয়ালেট ব্যালেন্স হাতে বসানো যায় না। টাকা যোগ করতে "রিসেলার ডিপোজিট" ব্যবহার করুন।');
  const typed = String(b.password || '').trim();
  const password = typed.length >= 8 ? typed : crypto.randomBytes(9).toString('base64url');
  const phone = require('../utils/validator').normalizeBdPhone(b.phone);
  if (await tx.queryOne('SELECT id FROM resellers WHERE phone=?', [phone])) throw new ConflictError('এই নম্বরে ইতিমধ্যে একজন রিসেলার আছে।');
  const made = await tx.execute('INSERT INTO resellers(name,shop_name,phone,password_hash,verified,status) VALUES(?,?,?,?,1,1)',
    [input.required(b.name, 191, 'Name'), input.optional(b.shop_name, 191), phone, await bcrypt.hash(password, 10)]);
  return { id: made.insertId, message: typed.length >= 8 ? 'রিসেলার যুক্ত হয়েছে।' : `রিসেলার যুক্ত হয়েছে (অস্থায়ী পাসওয়ার্ড: ${password})।` };
});

const resellerOptions = () => options('SELECT id,name,phone FROM resellers WHERE status=1 ORDER BY id DESC LIMIT 500', (r) => `${r.name} · ${r.phone}`);
page('/admin/reseller-deposits', async () => ({
  pageTitle: 'Reseller Deposits', subtitle: 'রিসেলার ডিপোজিট লেনদেন',
  createAction: '/admin/reseller-tx/deposit/create', customActionPrefix: '/admin/reseller-deposits/approve', customActionLabel: 'Approve', customActionHideWhenPaid: true,
  deletePrefix: '/admin/reseller-tx/delete', rejectActionPrefix: '/admin/reseller-deposits/reject',
  columns: [col('id', '#'), col('reseller_name', 'Reseller'), col('amount', 'Amount', 'currency'), col('method', 'Method'), col('trx_id', 'TrxID / Account'), col('status', 'Status', 'badge')],
  fields: [select('reseller_id', 'Reseller', await resellerOptions()), field('amount', 'Amount (৳)', 'number', { required: true }),
    field('method', 'Method', 'text', { value: 'bKash' }), field('trx_id', 'Transaction ID / Account No', 'text', { required: true })],
  rows: await mysql.queryAll(`SELECT t.id,r.name AS reseller_name,t.amount_paisa/100 AS amount,t.method,t.trx_id,t.status
    FROM reseller_transactions t LEFT JOIN resellers r ON r.id=t.reseller_id WHERE t.tx_type='deposit' ORDER BY t.id DESC LIMIT 500`),
}));
action('/admin/reseller-tx/:type/create', (req) => (req.params.type === 'deposit' ? '/admin/reseller-deposits' : '/admin/reseller-withdrawals'), 'অনুরোধ যুক্ত হয়েছে।', async (tx, req) => {
  const type = input.choice(req.params.type, ['deposit', 'withdrawal'], 'Type');
  const reseller = input.id(req.body.reseller_id, 'Reseller');
  await requireRow(tx, 'resellers', reseller, 'একজন রিসেলার নির্বাচন করুন।');
  const amount = input.positiveTaka(req.body.amount);
  if (type === 'withdrawal') {
    const wallet = await tx.queryOne('SELECT available_balance FROM partner_wallets WHERE reseller_id=? FOR UPDATE', [reseller]);
    const held = await tx.queryOne("SELECT COALESCE(SUM(amount_paisa),0) AS s FROM reseller_transactions WHERE reseller_id=? AND tx_type='withdrawal' AND status='pending'", [reseller]);
    if (Number(wallet?.available_balance || 0) - Number(held?.s || 0) < amount) throw new ConflictError('রিসেলারের উত্তোলনযোগ্য ব্যালেন্স যথেষ্ট নয়।');
  }
  await tx.execute("INSERT INTO reseller_transactions(reseller_id,tx_type,amount_paisa,method,trx_id,status) VALUES(?,?,?,?,?,'pending')",
    [reseller, type, amount, input.optional(req.body.method, 64), input.required(req.body.trx_id, 120, 'Transaction ID / account')]);
});
action('/admin/reseller-deposits/approve/:id', '/admin/reseller-deposits', 'ডিপোজিট অনুমোদিত হয়েছে।', async (tx, req) => {
  const id = input.id(req.params.id);
  const row = await tx.queryOne("SELECT reseller_id,amount_paisa FROM reseller_transactions WHERE id=? AND tx_type='deposit' AND status='pending' FOR UPDATE", [id]);
  if (!row) throw new ConflictError('অপেক্ষমাণ ডিপোজিট পাওয়া যায়নি।');
  await tx.execute("UPDATE reseller_transactions SET status='completed' WHERE id=?", [id]);
  await tx.execute('UPDATE resellers SET deposit_paisa=deposit_paisa+? WHERE id=?', [row.amount_paisa, row.reseller_id]);
});
action('/admin/reseller-deposits/reject/:id', '/admin/reseller-deposits', 'ডিপোজিট বাতিল করা হয়েছে।', async (tx, req) => {
  const id = input.id(req.params.id);
  const reason = input.required(req.body.reason, 200, 'বাতিলের কারণ');
  const done = await tx.execute("UPDATE reseller_transactions SET status='rejected' WHERE id=? AND tx_type='deposit' AND status='pending'", [id]);
  if (done.affectedRows !== 1) throw new ConflictError('অপেক্ষমাণ ডিপোজিট পাওয়া যায়নি।');
  await tx.execute("INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,after_json) VALUES('admin',?,'reseller.deposit.rejected','reseller_transaction',?,?)", [actor(req).id, String(id), JSON.stringify({ reason })]);
});
action('/admin/reseller-tx/delete/:id', '/admin/reseller-deposits', 'মুছে ফেলা হয়েছে।', async (tx, req) => {
  const done = await tx.execute("DELETE FROM reseller_transactions WHERE id=? AND status IN ('pending','rejected')", [input.id(req.params.id)]);
  if (done.affectedRows !== 1) throw new ConflictError('অনুমোদিত আর্থিক রেকর্ড মুছে ফেলা যায় না।');
});

module.exports = router;
