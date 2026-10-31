const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { env } = require('../config/env');
const adminBlogRepository = require('../repositories/adminBlogRepository');
const hrmEmployeeRepository = require('../repositories/hrmEmployeeRepository');
const adminComplaintRepository = require('../repositories/adminComplaintRepository');
const adminFinanceReadRepository = require('../repositories/adminFinanceReadRepository');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireAdmin } = require('../middleware/auth');
const { ConflictError } = require('../utils/errors');

const router = express.Router();
router.use('/admin', requireAdmin);

function slugify(str) {
  return (
    String(str || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}-]+/gu, '') || `post-${Date.now()}`
  );
}

// ─── Blog Module ───
async function renderBlogs(req, res, openModal = false) {
  const rows = env.db.client === 'mysql'
    ? await adminBlogRepository.listBlogs()
    : db.all('SELECT * FROM blogs ORDER BY id DESC');
  return res.render('admin/crud-module', {
    pageTitle: 'Blog Management',
    subtitle: 'ফল ও স্বাস্থ্য বিষয়ক ব্লগ আর্টিকেল প্রকাশ ও সম্পাদনা করুন',
    createAction: '/admin/blog/create',
    deletePrefix: '/admin/blog/delete',
    autoOpenModal: openModal,
    columns: [
      { key: 'id', label: '#' },
      { key: 'image', label: 'Image', type: 'image' },
      { key: 'title', label: 'Blog Title' },
      { key: 'category', label: 'Category' },
      { key: 'author', label: 'Author' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'created_at', label: 'Published' },
    ],
    fields: [
      { name: 'title', label: 'Blog Title', type: 'text', required: true },
      { name: 'category', label: 'Category', type: 'text', value: 'ফল ও স্বাস্থ্য' },
      { name: 'image', label: 'Banner Image Path / URL', type: 'text', value: '/uploads/banner/banner-1.jpg' },
      { name: 'excerpt', label: 'Short Summary', type: 'text' },
      { name: 'content', label: 'Full Content', type: 'textarea', required: true },
    ],
    rows,
  });
}

router.get('/admin/blogs', asyncHandler((req, res) => renderBlogs(req, res, false)));
router.get('/admin/blog/create', asyncHandler((req, res) => renderBlogs(req, res, true)));
router.post('/admin/blog/create', asyncHandler(async (req, res) => {
  const { title, category, image, excerpt, content } = req.body;
  if (env.db.client === 'mysql') {
    await adminBlogRepository.createBlog(req.body, {
      id: req.adminUser?.id || null,
      ip: req.ip || '',
      userAgent: req.get('user-agent') || '',
    });
    req.adminDomainAudit = true;
  } else {
    db.run(
      'INSERT INTO blogs (title, slug, category, image, excerpt, content) VALUES (?, ?, ?, ?, ?, ?)',
      title,
      `${slugify(title)}-${Date.now().toString().slice(-3)}`,
      category || 'ফল ও স্বাস্থ্য',
      image || '/uploads/banner/banner-1.jpg',
      excerpt || '',
      content || ''
    );
  }
  req.flash('success', 'নতুন ব্লগ পোস্ট প্রকাশিত হয়েছে!');
  res.redirect('/admin/blogs');
}));
router.post('/admin/blog/delete/:id', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    await adminBlogRepository.deleteBlog(req.params.id, {
      id: req.adminUser?.id || null,
      ip: req.ip || '',
      userAgent: req.get('user-agent') || '',
    });
    req.adminDomainAudit = true;
  } else db.run('DELETE FROM blogs WHERE id = ?', req.params.id);
  req.flash('success', 'ব্লগ পোস্ট ডিলিট হয়েছে।');
  res.redirect('/admin/blogs');
}));

// ─── Purchases & Suppliers ───
router.get('/admin/suppliers/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM suppliers ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Suppliers / Orchard Partners',
    subtitle: 'বাগান মালিক ও পাইকারি সরবরাহকারীদের তালিকা ও বকেয়া হিসাব',
    createAction: '/admin/suppliers/create',
    deletePrefix: '/admin/suppliers/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Supplier Name' },
      { key: 'company', label: 'Orchard / Company' },
      { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' },
      { key: 'balance_due', label: 'Due Balance', type: 'currency' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Supplier Name', type: 'text', required: true },
      { name: 'company', label: 'Company / Orchard Name', type: 'text' },
      { name: 'phone', label: 'Phone Number', type: 'text', required: true },
      { name: 'address', label: 'Address', type: 'text' },
      { name: 'balance_due', label: 'Opening Due (৳)', type: 'number', value: '0' },
    ],
    rows,
  });
});

router.post('/admin/suppliers/create', (req, res) => {
  const { name, company, phone, address, balance_due } = req.body;
  db.run(
    'INSERT INTO suppliers (name, company, phone, address, balance_due) VALUES (?, ?, ?, ?, ?)',
    name,
    company || '',
    phone,
    address || '',
    Number(balance_due || 0)
  );
  req.flash('success', 'সাপ্লায়ার যুক্ত হয়েছে!');
  res.redirect('/admin/suppliers/manage');
});

router.post('/admin/suppliers/delete/:id', (req, res) => {
  db.run('DELETE FROM suppliers WHERE id = ?', req.params.id);
  req.flash('success', 'সাপ্লায়ার ডিলিট হয়েছে।');
  res.redirect('/admin/suppliers/manage');
});

router.get('/admin/purchases/manage', (_req, res) => {
  const rows = db.all(
    `SELECT pu.*, s.name AS supplier_name, p.name AS product_name
     FROM purchases pu
     LEFT JOIN suppliers s ON s.id = pu.supplier_id
     LEFT JOIN products p ON p.id = pu.product_id
     ORDER BY pu.id DESC`
  );
  const suppliers = db.all('SELECT id, name FROM suppliers ORDER BY id ASC');
  const products = db.all('SELECT id, name FROM products ORDER BY id ASC');

  res.render('admin/crud-module', {
    pageTitle: 'Stock Purchases',
    subtitle: 'সাপ্লায়ার থেকে পণ্য ক্রয় এন্ট্রি করুন (স্বয়ংক্রিয়ভাবে প্রোডাক্ট স্টক বৃদ্ধি পাবে)',
    createAction: '/admin/purchases/create',
    deletePrefix: '/admin/purchases/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'reference_no', label: 'Ref No' },
      { key: 'supplier_name', label: 'Supplier' },
      { key: 'product_name', label: 'Product' },
      { key: 'qty', label: 'Qty Added' },
      { key: 'unit_cost', label: 'Unit Cost', type: 'currency' },
      { key: 'total_cost', label: 'Total Cost', type: 'currency' },
      { key: 'paid_amount', label: 'Paid', type: 'currency' },
      { key: 'purchase_date', label: 'Date' },
    ],
    fields: [
      {
        name: 'supplier_id',
        label: 'Supplier',
        type: 'select',
        options: suppliers.map((s) => ({ value: s.id, label: s.name })),
        required: true,
      },
      {
        name: 'product_id',
        label: 'Product',
        type: 'select',
        options: products.map((p) => ({ value: p.id, label: p.name })),
        required: true,
      },
      { name: 'qty', label: 'Quantity', type: 'number', value: '50', required: true },
      { name: 'unit_cost', label: 'Unit Cost (৳)', type: 'number', value: '850', required: true },
      { name: 'paid_amount', label: 'Paid Amount (৳)', type: 'number', value: '42500' },
      { name: 'purchase_date', label: 'Purchase Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
    ],
    rows,
  });
});

router.post('/admin/purchases/create', (req, res) => {
  const { supplier_id, product_id, qty, unit_cost, paid_amount, purchase_date } = req.body;
  const q = Number(qty || 0);
  const uc = Number(unit_cost || 0);
  const total = q * uc;
  const paid = Number(paid_amount || 0);
  const ref = `PUR-${Date.now().toString().slice(-6)}`;

  db.run(
    `INSERT INTO purchases (reference_no, supplier_id, product_id, qty, unit_cost, total_cost, paid_amount, purchase_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ref,
    Number(supplier_id || 1),
    Number(product_id || 1),
    q,
    uc,
    total,
    paid,
    purchase_date || new Date().toISOString().slice(0, 10)
  );
  db.run('UPDATE products SET stock = stock + ? WHERE id = ?', q, Number(product_id || 1));
  if (total > paid) {
    db.run('UPDATE suppliers SET balance_due = balance_due + ? WHERE id = ?', total - paid, Number(supplier_id || 1));
  }
  req.flash('success', `পারচেজ #${ref} সম্পন্ন এবং স্টকে ${q} ইউনিট যোগ হয়েছে!`);
  res.redirect('/admin/purchases/manage');
});

router.post('/admin/purchases/delete/:id', (req, res) => {
  db.run('DELETE FROM purchases WHERE id = ?', req.params.id);
  req.flash('success', 'পারচেজ রেকর্ড ডিলিট হয়েছে।');
  res.redirect('/admin/purchases/manage');
});

// ─── CRM / HR Module ───
router.get('/admin/employees', asyncHandler(async (req, res) => {
  const rows = env.db.client === 'mysql'
    ? await hrmEmployeeRepository.listEmployees()
    : db.all('SELECT * FROM employees ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Employees (CRM / HR)',
    subtitle: 'প্রতিষ্ঠানের কর্মকর্তা ও কর্মচারীদের তালিকা',
    createAction: '/admin/employees/create',
    deletePrefix: '/admin/employees/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Name' },
      { key: 'designation', label: 'Designation' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'base_salary', label: 'Salary', type: 'currency' },
      { key: 'join_date', label: 'Joined' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Employee Name', type: 'text', required: true },
      { name: 'designation', label: 'Designation', type: 'text', required: true },
      { name: 'phone', label: 'Phone', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'base_salary', label: 'Monthly Base Salary (৳)', type: 'number', value: '15000', required: true },
      { name: 'join_date', label: 'Join Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
    ],
    rows,
  });
}));

router.post('/admin/employees/create', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    await hrmEmployeeRepository.createEmployee(req.body, {
      id: req.adminUser?.id ?? req.session?.adminUser?.id ?? null,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    req.adminDomainAudit = true;
  } else {
    const { name, designation, phone, email, base_salary, join_date } = req.body;
    db.run(
      'INSERT INTO employees (name, designation, phone, email, base_salary, join_date) VALUES (?, ?, ?, ?, ?, ?)',
      name, designation, phone, email || '', Number(base_salary || 15000), join_date || '2026-01-01'
    );
  }
  req.flash('success', 'নতুন এমপ্লয়ি যুক্ত হয়েছে।');
  res.redirect('/admin/employees');
}));

router.post('/admin/employees/delete/:id', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    await hrmEmployeeRepository.deactivateEmployee(req.params.id, {
      id: req.adminUser?.id ?? req.session?.adminUser?.id ?? null,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    req.adminDomainAudit = true;
  } else {
    db.run('DELETE FROM employees WHERE id = ?', req.params.id);
  }
  req.flash('success', env.db.client === 'mysql' ? 'কর্মচারী নিষ্ক্রিয় করা হয়েছে।' : 'এমপ্লয়ি ডিলিট হয়েছে।');
  res.redirect('/admin/employees');
}));

router.get('/admin/attendances', (_req, res) => {
  const rows = db.all(
    `SELECT a.*, e.name AS employee_name FROM attendances a
     LEFT JOIN employees e ON e.id = a.employee_id ORDER BY a.id DESC`
  );
  const emps = db.all('SELECT id, name FROM employees ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Employee Attendance',
    subtitle: 'দৈনিক হাজিরা ও অফিস সময় লগ',
    createAction: '/admin/attendances/create',
    deletePrefix: '/admin/attendances/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'employee_name', label: 'Employee' },
      { key: 'att_date', label: 'Date' },
      { key: 'check_in', label: 'Check In' },
      { key: 'check_out', label: 'Check Out' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'select', options: emps.map((e) => ({ value: e.id, label: e.name })) },
      { name: 'att_date', label: 'Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'check_in', label: 'Check In', type: 'text', value: '09:00 AM' },
      { name: 'check_out', label: 'Check Out', type: 'text', value: '06:00 PM' },
      {
        name: 'status',
        label: 'Attendance Status',
        type: 'select',
        options: [
          { value: 'Present', label: 'Present' },
          { value: 'Late', label: 'Late' },
          { value: 'Absent', label: 'Absent' },
        ],
      },
    ],
    rows,
  });
});

router.post('/admin/attendances/create', (req, res) => {
  const { employee_id, att_date, check_in, check_out, status } = req.body;
  db.run(
    'INSERT INTO attendances (employee_id, att_date, check_in, check_out, status) VALUES (?, ?, ?, ?, ?)',
    Number(employee_id || 1),
    att_date || new Date().toISOString().slice(0, 10),
    check_in || '09:00 AM',
    check_out || '06:00 PM',
    status || 'Present'
  );
  req.flash('success', 'হাজিরা রেকর্ড সংরক্ষিত হয়েছে।');
  res.redirect('/admin/attendances');
});

router.post('/admin/attendances/delete/:id', (req, res) => {
  db.run('DELETE FROM attendances WHERE id = ?', req.params.id);
  res.redirect('/admin/attendances');
});

router.get('/admin/leaves', (_req, res) => {
  const rows = db.all(
    `SELECT l.*, e.name AS employee_name FROM leaves l
     LEFT JOIN employees e ON e.id = l.employee_id ORDER BY l.id DESC`
  );
  const emps = db.all('SELECT id, name FROM employees ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Employee Leaves',
    subtitle: 'ছুটির আবেদন ও অনুমোদন ব্যবস্থাপনা',
    createAction: '/admin/leaves/create',
    deletePrefix: '/admin/leaves/delete',
    customActionPrefix: '/admin/leaves/approve',
    customActionLabel: 'Approve',
    columns: [
      { key: 'id', label: '#' },
      { key: 'employee_name', label: 'Employee' },
      { key: 'leave_type', label: 'Leave Type' },
      { key: 'from_date', label: 'From' },
      { key: 'to_date', label: 'To' },
      { key: 'reason', label: 'Reason' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'select', options: emps.map((e) => ({ value: e.id, label: e.name })) },
      { name: 'leave_type', label: 'Leave Type', type: 'text', value: 'Casual Leave' },
      { name: 'from_date', label: 'From Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'to_date', label: 'To Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
      { name: 'reason', label: 'Reason', type: 'text' },
    ],
    rows,
  });
});

router.post('/admin/leaves/create', (req, res) => {
  const { employee_id, leave_type, from_date, to_date, reason } = req.body;
  db.run(
    "INSERT INTO leaves (employee_id, leave_type, from_date, to_date, reason, status) VALUES (?, ?, ?, ?, ?, 'pending')",
    Number(employee_id || 1),
    leave_type || 'Casual Leave',
    from_date,
    to_date,
    reason || ''
  );
  req.flash('success', 'ছুটির আবেদন যুক্ত হয়েছে।');
  res.redirect('/admin/leaves');
});

router.post('/admin/leaves/approve/:id', (req, res) => {
  db.run("UPDATE leaves SET status = 'approved' WHERE id = ?", req.params.id);
  req.flash('success', 'ছুটি অনুমোদিত হয়েছে।');
  res.redirect('/admin/leaves');
});

router.post('/admin/leaves/delete/:id', (req, res) => {
  db.run('DELETE FROM leaves WHERE id = ?', req.params.id);
  res.redirect('/admin/leaves');
});

function renderSalaries(res, pageTitle) {
  const rows = db.all(
    `SELECT s.*, e.name AS employee_name FROM salaries s
     LEFT JOIN employees e ON e.id = s.employee_id ORDER BY s.id DESC`
  );
  const emps = db.all('SELECT id, name, base_salary FROM employees ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle,
    subtitle: 'মাসিক বেতন শিট ও পরিশোধের বিবরণী',
    createAction: '/admin/salaries/create',
    deletePrefix: '/admin/salaries/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'employee_name', label: 'Employee' },
      { key: 'month', label: 'Month' },
      { key: 'basic_amount', label: 'Basic', type: 'currency' },
      { key: 'bonus', label: 'Bonus', type: 'currency' },
      { key: 'deduction', label: 'Deduction', type: 'currency' },
      { key: 'net_salary', label: 'Net Paid', type: 'currency' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'select', options: emps.map((e) => ({ value: e.id, label: `${e.name} (৳${e.base_salary})` })) },
      { name: 'month', label: 'Salary Month', type: 'text', value: 'October 2026', required: true },
      { name: 'basic_amount', label: 'Basic Salary (৳)', type: 'number', value: '16000', required: true },
      { name: 'bonus', label: 'Bonus (৳)', type: 'number', value: '0' },
      { name: 'deduction', label: 'Deduction (৳)', type: 'number', value: '0' },
    ],
    rows,
  });
}

router.get('/admin/salaries', (_req, res) => renderSalaries(res, 'Salary Sheet'));
router.get('/admin/salary-payments', (_req, res) => renderSalaries(res, 'Salary Payments'));

router.post('/admin/salaries/create', (req, res) => {
  const { employee_id, month, basic_amount, bonus, deduction } = req.body;
  const basic = Number(basic_amount || 0);
  const bon = Number(bonus || 0);
  const ded = Number(deduction || 0);
  const net = Math.max(0, basic + bon - ded);
  db.run(
    "INSERT INTO salaries (employee_id, month, basic_amount, bonus, deduction, net_salary, status) VALUES (?, ?, ?, ?, ?, ?, 'paid')",
    Number(employee_id || 1),
    month || 'October 2026',
    basic,
    bon,
    ded,
    net
  );
  req.flash('success', `বেতন ৳${net} সফলভাবে রেকর্ড হয়েছে।`);
  res.redirect('/admin/salaries');
});

router.post('/admin/salaries/delete/:id', (req, res) => {
  db.run('DELETE FROM salaries WHERE id = ?', req.params.id);
  res.redirect('/admin/salaries');
});

router.get('/admin/bonuses', (_req, res) => {
  const rows = db.all(
    `SELECT b.*, e.name AS employee_name FROM bonuses b
     LEFT JOIN employees e ON e.id = b.employee_id ORDER BY b.id DESC`
  );
  const emps = db.all('SELECT id, name FROM employees ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Festival & Performance Bonuses',
    subtitle: 'কর্মচারীদের উৎসব ও পারফরম্যান্স বোনাস তালিকা',
    createAction: '/admin/bonuses/create',
    deletePrefix: '/admin/bonuses/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'employee_name', label: 'Employee' },
      { key: 'title', label: 'Bonus Title' },
      { key: 'amount', label: 'Amount', type: 'currency' },
      { key: 'bonus_date', label: 'Date' },
    ],
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'select', options: emps.map((e) => ({ value: e.id, label: e.name })) },
      { name: 'title', label: 'Bonus Title', type: 'text', required: true },
      { name: 'amount', label: 'Amount (৳)', type: 'number', required: true },
    ],
    rows,
  });
});

router.post('/admin/bonuses/create', (req, res) => {
  db.run(
    'INSERT INTO bonuses (employee_id, title, amount) VALUES (?, ?, ?)',
    Number(req.body.employee_id || 1),
    req.body.title,
    Number(req.body.amount || 0)
  );
  req.flash('success', 'বোনাস যুক্ত হয়েছে।');
  res.redirect('/admin/bonuses');
});

router.post('/admin/bonuses/delete/:id', (req, res) => {
  db.run('DELETE FROM bonuses WHERE id = ?', req.params.id);
  res.redirect('/admin/bonuses');
});

// ─── Complaints, Contact Messages, Newsletter ───
router.get('/admin/complaints', asyncHandler(async (_req, res) => {
  const rows = env.db.client === 'mysql'
    ? await adminComplaintRepository.listComplaints()
    : db.all('SELECT * FROM complaints ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Customer Complaints',
    subtitle: 'ওয়েবসাইটের লাইভ সাপোর্ট উইজেট থেকে জমা পড়া অভিযোগসমূহ',
    createAction: '/admin/complaints/create',
    deletePrefix: env.db.client === 'mysql' ? '' : '/admin/complaints/delete',
    customActionPrefix: '/admin/complaints/resolve',
    customActionLabel: 'Mark Resolved',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Customer Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'invoice_id', label: 'Invoice #' },
      { key: 'details', label: 'Complaint Details' },
      { key: 'status', label: 'Status', type: 'badge' },
      { key: 'created_at', label: 'Submitted' },
    ],
    fields: [
      { name: 'name', label: 'Customer Name', type: 'text', required: true },
      { name: 'phone', label: 'Phone', type: 'text', required: true },
      { name: 'invoice_id', label: 'Invoice ID (Optional)', type: 'text' },
      { name: 'details', label: 'Complaint Details', type: 'textarea', required: true },
    ],
    rows,
  });
}));

router.post('/admin/complaints/create', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    await adminComplaintRepository.createComplaint(req.body, {
      id: req.adminUser?.id ?? null, ip: req.ip, userAgent: req.get('user-agent'),
    });
    req.adminDomainAudit = true;
  } else {
    db.run(
      'INSERT INTO complaints (name, phone, invoice_id, details) VALUES (?, ?, ?, ?)',
      req.body.name, req.body.phone, req.body.invoice_id || '', req.body.details
    );
  }
  req.flash('success', 'অভিযোগ রেকর্ড করা হয়েছে।');
  res.redirect('/admin/complaints');
}));

router.post('/admin/complaints/resolve/:id', asyncHandler(async (req, res) => {
  if (env.db.client === 'mysql') {
    await adminComplaintRepository.resolveComplaint(req.params.id, {
      id: req.adminUser?.id ?? null, ip: req.ip, userAgent: req.get('user-agent'),
    });
    req.adminDomainAudit = true;
  } else {
    db.run("UPDATE complaints SET status = 'resolved' WHERE id = ?", req.params.id);
  }
  req.flash('success', 'অভিযোগ সমাধান (Resolved) হিসেবে মার্ক করা হয়েছে!');
  res.redirect('/admin/complaints');
}));

router.post('/admin/complaints/delete/:id', (req, res, next) => {
  if (env.db.client === 'mysql') {
    return next(new ConflictError('Complaint deletion is disabled pending an approved data-retention policy.'));
  }
  db.run('DELETE FROM complaints WHERE id = ?', req.params.id);
  res.redirect('/admin/complaints');
});

router.get('/admin/contact-messages', asyncHandler(async (_req, res) => {
  const rows = env.db.client === 'mysql'
    ? await adminComplaintRepository.listContactMessages()
    : db.all('SELECT * FROM contact_messages ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Contact Messages',
    subtitle: 'কাস্টমারদের পাঠানো যোগাযোগ বার্তাসমূহ',
    deletePrefix: env.db.client === 'mysql' ? '' : '/admin/contact-messages/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'subject', label: 'Subject' },
      { key: 'message', label: 'Message' },
      { key: 'created_at', label: 'Date' },
    ],
    fields: [],
    rows,
  });
}));

router.post('/admin/contact-messages/delete/:id', (req, res, next) => {
  if (env.db.client === 'mysql') {
    return next(new ConflictError('Contact-message deletion is disabled pending an approved data-retention policy.'));
  }
  db.run('DELETE FROM contact_messages WHERE id = ?', req.params.id);
  res.redirect('/admin/contact-messages');
});

router.get('/admin/newsletter-subscribers', (_req, res) => {
  const rows = db.all('SELECT * FROM newsletter_subscribers ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Newsletter Subscribers',
    subtitle: 'অফার ও আপডেট পেতে সাবস্ক্রাইব করা গ্রাহকদের তালিকা',
    createAction: '/admin/newsletter-subscribers/create',
    deletePrefix: '/admin/newsletter-subscribers/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'email_or_phone', label: 'Email / Phone' },
      { key: 'status', label: 'Status', type: 'status' },
      { key: 'created_at', label: 'Subscribed At' },
    ],
    fields: [{ name: 'email_or_phone', label: 'Email or Phone', type: 'text', required: true }],
    rows,
  });
});

router.post('/admin/newsletter-subscribers/create', (req, res) => {
  try {
    db.run('INSERT INTO newsletter_subscribers (email_or_phone) VALUES (?)', req.body.email_or_phone);
    req.flash('success', 'সাবস্ক্রাইবার যুক্ত হয়েছে।');
  } catch (_e) {
    req.flash('error', 'এই ইমেইল/নম্বর ইতিমধ্যে যুক্ত আছে।');
  }
  res.redirect('/admin/newsletter-subscribers');
});

router.post('/admin/newsletter-subscribers/delete/:id', (req, res) => {
  db.run('DELETE FROM newsletter_subscribers WHERE id = ?', req.params.id);
  res.redirect('/admin/newsletter-subscribers');
});

// ─── Fund / Account & Expenses ───
router.get('/admin/payment-records', asyncHandler(async (req, res) => {
  if(env.db.client!=='mysql') return res.redirect('/admin/orders');
  const status=String(req.query.status||'all');
  const search=String(req.query.search||'');
  const rows=await adminFinanceReadRepository.listPaymentRecords({status,search});
  return res.render('admin/payment-records',{rows,status,search});
}));

router.get('/admin/fund', asyncHandler(async (req, res) => {
  if(env.db.client==='mysql'){
    const [rows,summary]=await Promise.all([adminFinanceReadRepository.listFundTransactions(),adminFinanceReadRepository.getFundSummary()]);
    return res.render('admin/crud-module',{
      pageTitle:`Fund / Account Ledger (Balance: ৳${summary.balance})`,
      subtitle:`Credits ৳${summary.credits} · Debits ৳${summary.debits}`,
      columns:[{key:'id',label:'#'},{key:'account_name',label:'Account'},{key:'type',label:'Type',type:'badge'},
        {key:'amount',label:'Amount (৳)',type:'currency'},{key:'note',label:'Note / Particulars'},{key:'tx_date',label:'Date'}],rows,fields:[],
    });
  }
  const rows = db.all('SELECT * FROM fund_transactions ORDER BY id DESC');
  const credits = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM fund_transactions WHERE type = 'credit'").s;
  const debits = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM fund_transactions WHERE type = 'debit'").s;
  res.render('admin/crud-module', {
    pageTitle: `Fund / Account Ledger (Balance: ৳${(credits - debits).toLocaleString('en-IN')})`,
    subtitle: 'ব্যবসায়িক ক্যাশ ও ব্যাংক ফান্ডে টাকা জমা (Credit) এবং উত্তোলন (Debit) হিসাব',
    createAction: '/admin/fund/create',
    deletePrefix: '/admin/fund/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'account_name', label: 'Account' },
      { key: 'type', label: 'Type', type: 'badge' },
      { key: 'amount', label: 'Amount', type: 'currency' },
      { key: 'note', label: 'Note / Particulars' },
      { key: 'tx_date', label: 'Date' },
    ],
    fields: [
      { name: 'account_name', label: 'Account Name', type: 'text', value: 'Main Business Fund' },
      {
        name: 'type',
        label: 'Transaction Type',
        type: 'select',
        options: [
          { value: 'credit', label: 'Credit (জমা +)' },
          { value: 'debit', label: 'Debit (খরচ / উত্তোলন -)' },
        ],
      },
      { name: 'amount', label: 'Amount (৳)', type: 'number', required: true },
      { name: 'note', label: 'Note', type: 'text', required: true },
      { name: 'tx_date', label: 'Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
    ],
    rows,
  });
}));

router.post('/admin/fund/create', (req, res) => {
  const { account_name, type, amount, note, tx_date } = req.body;
  db.run(
    'INSERT INTO fund_transactions (account_name, type, amount, note, tx_date) VALUES (?, ?, ?, ?, ?)',
    account_name || 'Main Business Fund',
    type || 'credit',
    Number(amount || 0),
    note || '',
    tx_date || new Date().toISOString().slice(0, 10)
  );
  req.flash('success', 'ফান্ড ট্রানজেকশন সংরক্ষিত হয়েছে!');
  res.redirect('/admin/fund');
});

router.post('/admin/fund/delete/:id', (req, res) => {
  db.run('DELETE FROM fund_transactions WHERE id = ?', req.params.id);
  res.redirect('/admin/fund');
});

router.get('/admin/expenses', asyncHandler(async (_req, res) => {
  if(env.db.client==='mysql'){
    const rows=await adminFinanceReadRepository.listExpenses();
    return res.render('admin/crud-module',{
      pageTitle:'Daily & Monthly Expenses',subtitle:'Read-only expenses recorded in integer paisa.',
      columns:[{key:'id',label:'#'},{key:'title',label:'Expense Title'},{key:'category',label:'Category'},
        {key:'amount',label:'Amount (৳)',type:'currency'},{key:'note',label:'Note'},{key:'expense_date',label:'Date'}],rows,fields:[],
    });
  }
  const rows = db.all('SELECT * FROM expenses ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Daily & Monthly Expenses',
    subtitle: 'প্যাকেজিং, মার্কেটিং, পরিবহন ও অফিস খরচের হিসাব',
    createAction: '/admin/expenses/create',
    deletePrefix: '/admin/expenses/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'title', label: 'Expense Title' },
      { key: 'category', label: 'Category' },
      { key: 'amount', label: 'Amount', type: 'currency' },
      { key: 'note', label: 'Note' },
      { key: 'expense_date', label: 'Date' },
    ],
    fields: [
      { name: 'title', label: 'Expense Title', type: 'text', required: true },
      { name: 'category', label: 'Category (প্যাকেজিং / অফিস / বিজ্ঞাপন)', type: 'text', value: 'প্যাকেজিং' },
      { name: 'amount', label: 'Amount (৳)', type: 'number', required: true },
      { name: 'note', label: 'Note', type: 'text' },
      { name: 'expense_date', label: 'Date', type: 'date', value: new Date().toISOString().slice(0, 10) },
    ],
    rows,
  });
}));

router.post('/admin/expenses/create', (req, res) => {
  const { title, category, amount, note, expense_date } = req.body;
  const amt = Number(amount || 0);
  const dt = expense_date || new Date().toISOString().slice(0, 10);
  db.run(
    'INSERT INTO expenses (title, category, amount, note, expense_date) VALUES (?, ?, ?, ?, ?)',
    title,
    category || 'অপারেশন',
    amt,
    note || '',
    dt
  );
  db.run(
    "INSERT INTO fund_transactions (account_name, type, amount, note, tx_date) VALUES ('Main Business Fund', 'debit', ?, ?, ?)",
    amt,
    `Expense: ${title}`,
    dt
  );
  req.flash('success', 'খরচ যুক্ত হয়েছে এবং ফান্ড ব্যালেন্স সমন্বয় করা হয়েছে!');
  res.redirect('/admin/expenses');
});

router.post('/admin/expenses/delete/:id', (req, res) => {
  db.run('DELETE FROM expenses WHERE id = ?', req.params.id);
  res.redirect('/admin/expenses');
});

// ─── Vendors & Resellers ───
router.get('/admin/vendors', (_req, res) => renderVendors(res, false));
router.get('/admin/vendor-verifications', (_req, res) => renderVendors(res, true));

function renderVendors(res, pendingOnly) {
  const rows = pendingOnly
    ? db.all('SELECT * FROM vendors WHERE verified = 0 ORDER BY id DESC')
    : db.all('SELECT * FROM vendors ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: pendingOnly ? 'Vendor Verifications' : 'All Vendors',
    subtitle: 'মাল্টি-ভেন্ডর সেলার অ্যাকাউন্ট, কমিশন রেট এবং ভেরিফিকেশন',
    createAction: '/admin/vendors/create',
    deletePrefix: '/admin/vendors/delete',
    customActionPrefix: '/admin/vendors/verify',
    customActionLabel: 'Verify Vendor',
    columns: [
      { key: 'id', label: '#' },
      { key: 'shop_name', label: 'Shop Name' },
      { key: 'owner_name', label: 'Owner' },
      { key: 'phone', label: 'Phone' },
      { key: 'commission_rate', label: 'Commission (%)' },
      { key: 'balance', label: 'Wallet Balance', type: 'currency' },
      { key: 'verified', label: 'Verified', type: 'status' },
    ],
    fields: [
      { name: 'shop_name', label: 'Shop Name', type: 'text', required: true },
      { name: 'owner_name', label: 'Owner Name', type: 'text', required: true },
      { name: 'phone', label: 'Phone Number', type: 'text', required: true },
      { name: 'address', label: 'Address', type: 'text' },
      { name: 'commission_rate', label: 'Commission (%)', type: 'number', value: '10' },
    ],
    rows,
  });
}

router.post('/admin/vendors/create', (req, res) => {
  const { shop_name, owner_name, phone, address, commission_rate, password } = req.body;
  const initialPassword =
    password && String(password).trim().length >= 8
      ? String(password).trim()
      : crypto.randomBytes(9).toString('base64url');
  const vHash = bcrypt.hashSync(initialPassword, 10);
  db.run(
    'INSERT INTO vendors (shop_name, owner_name, phone, address, commission_rate, password_hash, verified) VALUES (?, ?, ?, ?, ?, ?, 1)',
    shop_name,
    owner_name,
    phone,
    address || '',
    Number(commission_rate || 10),
    vHash
  );
  req.flash('success', `নতুন ভেন্ডর তৈরি হয়েছে (অস্থায়ী পাসওয়ার্ড: ${initialPassword})।`);
  res.redirect('/admin/vendors');
});

router.post('/admin/vendors/verify/:id', (req, res) => {
  db.run('UPDATE vendors SET verified = 1 WHERE id = ?', req.params.id);
  req.flash('success', 'ভেন্ডর ভেরিফাই করা হয়েছে!');
  res.redirect(req.get('Referrer') || '/admin/vendors');
});

router.post('/admin/vendors/delete/:id', (req, res) => {
  db.run('DELETE FROM vendors WHERE id = ?', req.params.id);
  res.redirect('/admin/vendors');
});

router.get('/admin/vendor-withdrawals', (_req, res) => {
  const rows = db.all(
    `SELECT vw.*, v.shop_name FROM vendor_withdrawals vw
     LEFT JOIN vendors v ON v.id = vw.vendor_id ORDER BY vw.id DESC`
  );
  const vendors = db.all('SELECT id, shop_name FROM vendors');
  res.render('admin/crud-module', {
    pageTitle: 'Vendor Withdrawals',
    subtitle: 'ভেন্ডরদের পেমেন্ট উত্তোলন রিকোয়েস্ট',
    createAction: '/admin/vendor-withdrawals/create',
    customActionPrefix: '/admin/vendor-withdrawals/approve',
    customActionLabel: 'Mark Paid',
    deletePrefix: '/admin/vendor-withdrawals/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'shop_name', label: 'Vendor Shop' },
      { key: 'amount', label: 'Amount', type: 'currency' },
      { key: 'method', label: 'Method' },
      { key: 'account_number', label: 'Account No' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    fields: [
      { name: 'vendor_id', label: 'Vendor', type: 'select', options: vendors.map((v) => ({ value: v.id, label: v.shop_name })) },
      { name: 'amount', label: 'Amount (৳)', type: 'number', required: true },
      { name: 'method', label: 'Method (bKash/Nagad/Bank)', type: 'text', value: 'bKash' },
      { name: 'account_number', label: 'Account Number', type: 'text', required: true },
    ],
    rows,
  });
});

router.post('/admin/vendor-withdrawals/create', (req, res) => {
  db.run(
    'INSERT INTO vendor_withdrawals (vendor_id, amount, method, account_number) VALUES (?, ?, ?, ?)',
    Number(req.body.vendor_id || 1),
    Number(req.body.amount || 0),
    req.body.method || 'bKash',
    req.body.account_number
  );
  res.redirect('/admin/vendor-withdrawals');
});

router.post('/admin/vendor-withdrawals/approve/:id', (req, res) => {
  db.run("UPDATE vendor_withdrawals SET status = 'paid' WHERE id = ?", req.params.id);
  req.flash('success', 'ভেন্ডর উইথড্রয়াল পরিশোধিত মার্ক করা হয়েছে।');
  res.redirect('/admin/vendor-withdrawals');
});

router.post('/admin/vendor-withdrawals/delete/:id', (req, res) => {
  db.run('DELETE FROM vendor_withdrawals WHERE id = ?', req.params.id);
  res.redirect('/admin/vendor-withdrawals');
});

// Resellers
router.get('/admin/resellers', (_req, res) => renderResellers(res, false));
router.get('/admin/reseller-verifications', (_req, res) => renderResellers(res, true));

function renderResellers(res, unverifiedOnly) {
  const rows = unverifiedOnly
    ? db.all('SELECT * FROM resellers WHERE verified = 0 ORDER BY id DESC')
    : db.all('SELECT * FROM resellers ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: unverifiedOnly ? 'Reseller Verifications' : 'All Resellers',
    subtitle: 'রিসেলার পার্টনার অ্যাকাউন্ট ও ব্যালেন্স ব্যবস্থাপনা',
    createAction: '/admin/resellers/create',
    customActionPrefix: '/admin/resellers/verify',
    customActionLabel: 'Verify',
    deletePrefix: '/admin/resellers/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Reseller Name' },
      { key: 'shop_name', label: 'Page / Shop' },
      { key: 'phone', label: 'Phone' },
      { key: 'balance', label: 'Commission Balance', type: 'currency' },
      { key: 'verified', label: 'Verified', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Reseller Name', type: 'text', required: true },
      { name: 'shop_name', label: 'FB Page / Shop Name', type: 'text' },
      { name: 'phone', label: 'Phone', type: 'text', required: true },
      { name: 'balance', label: 'Opening Balance (৳)', type: 'number', value: '0' },
    ],
    rows,
  });
}

router.post('/admin/resellers/create', (req, res) => {
  const initialPassword =
    req.body.password && String(req.body.password).trim().length >= 8
      ? String(req.body.password).trim()
      : crypto.randomBytes(9).toString('base64url');
  const rHash = bcrypt.hashSync(initialPassword, 10);
  db.run(
    'INSERT INTO resellers (name, shop_name, phone, balance, password_hash, verified) VALUES (?, ?, ?, ?, ?, 1)',
    req.body.name,
    req.body.shop_name || '',
    req.body.phone,
    Number(req.body.balance || 0),
    rHash
  );
  req.flash('success', `রিসেলার যুক্ত হয়েছে (অস্থায়ী পাসওয়ার্ড: ${initialPassword})।`);
  res.redirect('/admin/resellers');
});

router.post('/admin/resellers/verify/:id', (req, res) => {
  db.run('UPDATE resellers SET verified = 1 WHERE id = ?', req.params.id);
  res.redirect('/admin/resellers');
});

router.post('/admin/resellers/delete/:id', (req, res) => {
  db.run('DELETE FROM resellers WHERE id = ?', req.params.id);
  res.redirect('/admin/resellers');
});

router.get('/admin/reseller-deposits', (_req, res) => renderResellerTx(res, 'deposit', 'Reseller Deposits'));
router.get('/admin/reseller-withdrawals', (_req, res) => renderResellerTx(res, 'withdrawal', 'Reseller Withdrawals'));

function renderResellerTx(res, type, pageTitle) {
  const rows = db.all(
    `SELECT rt.*, r.name AS reseller_name FROM reseller_transactions rt
     LEFT JOIN resellers r ON r.id = rt.reseller_id
     WHERE rt.type = ? ORDER BY rt.id DESC`,
    type
  );
  const resellers = db.all('SELECT id, name FROM resellers');
  res.render('admin/crud-module', {
    pageTitle,
    subtitle: `রিসেলার ${type === 'deposit' ? 'ডিপোজিট' : 'উইথড্রয়াল'} লেনদেন`,
    createAction: `/admin/reseller-tx/${type}/create`,
    customActionPrefix: '/admin/reseller-tx/approve',
    customActionLabel: 'Approve',
    deletePrefix: '/admin/reseller-tx/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'reseller_name', label: 'Reseller' },
      { key: 'amount', label: 'Amount', type: 'currency' },
      { key: 'method', label: 'Method' },
      { key: 'trx_id', label: 'TrxID / Account' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    fields: [
      { name: 'reseller_id', label: 'Reseller', type: 'select', options: resellers.map((r) => ({ value: r.id, label: r.name })) },
      { name: 'amount', label: 'Amount (৳)', type: 'number', required: true },
      { name: 'method', label: 'Method', type: 'text', value: 'bKash' },
      { name: 'trx_id', label: 'Transaction ID / Account No', type: 'text', required: true },
    ],
    rows,
  });
}

router.post('/admin/reseller-tx/:type/create', (req, res) => {
  const type = req.params.type === 'deposit' ? 'deposit' : 'withdrawal';
  db.run(
    'INSERT INTO reseller_transactions (reseller_id, type, amount, method, trx_id) VALUES (?, ?, ?, ?, ?)',
    Number(req.body.reseller_id || 1),
    type,
    Number(req.body.amount || 0),
    req.body.method || 'bKash',
    req.body.trx_id || ''
  );
  res.redirect(type === 'deposit' ? '/admin/reseller-deposits' : '/admin/reseller-withdrawals');
});

router.post('/admin/reseller-tx/approve/:id', (req, res) => {
  const tx = db.get('SELECT * FROM reseller_transactions WHERE id = ?', req.params.id);
  if (tx && tx.status !== 'approved') {
    db.run("UPDATE reseller_transactions SET status = 'approved' WHERE id = ?", tx.id);
    if (tx.type === 'deposit') {
      db.run('UPDATE resellers SET deposit_amount = deposit_amount + ? WHERE id = ?', Number(tx.amount || 0), tx.reseller_id);
    }
  }
  req.flash('success', 'অনুমোদিত হয়েছে এবং ব্যালেন্স সমন্বয় করা হয়েছে।');
  res.redirect(req.get('Referrer') || '/admin/resellers');
});

router.post('/admin/reseller-tx/delete/:id', (req, res) => {
  db.run('DELETE FROM reseller_transactions WHERE id = ?', req.params.id);
  res.redirect(req.get('Referrer') || '/admin/resellers');
});

// ─── Users, Roles, Permissions, Customers ───
router.get('/admin/users/manage', (_req, res) => {
  const rows = db.all('SELECT id, name, email, phone, role, status, created_at FROM users ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Admin Users',
    subtitle: 'অ্যাডমিন প্যানেল ব্যবহারকারী ও রোল অ্যাক্সেস ব্যবস্থাপনা',
    createAction: '/admin/users/create',
    deletePrefix: '/admin/users/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'role', label: 'Role', type: 'badge' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Full Name', type: 'text', required: true },
      { name: 'email', label: 'Login Email', type: 'email', required: true },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'password', label: 'Password', type: 'password', required: true },
      { name: 'role', label: 'Role', type: 'text', value: 'Manager' },
    ],
    rows,
  });
});

router.post('/admin/users/create', (req, res) => {
  try {
    const rawPass = String(req.body.password || '').trim();
    if (rawPass.length < 8) {
      req.flash('error', 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।');
      return res.redirect('/admin/users/manage');
    }
    const hash = bcrypt.hashSync(rawPass, 10);
    db.run(
      'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      req.body.name,
      String(req.body.email || '').trim().toLowerCase(),
      req.body.phone || '',
      hash,
      req.body.role || 'Manager'
    );
    req.flash('success', 'নতুন অ্যাডমিন ইউজার তৈরি হয়েছে!');
  } catch (_e) {
    req.flash('error', 'এই ইমেইল দিয়ে ইতিমধ্যে ইউজার রয়েছে।');
  }
  res.redirect('/admin/users/manage');
});

router.post('/admin/users/delete/:id', (req, res) => {
  if (Number(req.params.id) === 1) {
    req.flash('error', 'প্রধান অ্যাডমিন অ্যাকাউন্ট ডিলিট করা যাবে না।');
    return res.redirect('/admin/users/manage');
  }
  db.run('DELETE FROM users WHERE id = ?', req.params.id);
  req.flash('success', 'ইউজার ডিলিট হয়েছে।');
  res.redirect('/admin/users/manage');
});

router.get('/admin/roles/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM roles ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'User Roles',
    subtitle: 'রোল ভিত্তিক অ্যাক্সেস কন্ট্রোল (RBAC)',
    createAction: '/admin/roles/create',
    deletePrefix: '/admin/roles/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Role Name' },
      { key: 'permissions', label: 'Permissions Scope' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Role Name', type: 'text', required: true },
      { name: 'permissions', label: 'Modules (comma separated)', type: 'text', value: 'orders,products,pos' },
    ],
    rows,
  });
});

router.post('/admin/roles/create', (req, res) => {
  db.run('INSERT INTO roles (name, permissions) VALUES (?, ?)', req.body.name, req.body.permissions || 'all');
  res.redirect('/admin/roles/manage');
});

router.post('/admin/roles/delete/:id', (req, res) => {
  db.run('DELETE FROM roles WHERE id = ?', req.params.id);
  res.redirect('/admin/roles/manage');
});

router.get('/admin/permissions/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM permissions ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'System Permissions',
    subtitle: 'মডিউল পারমিশন কি তালিকা',
    createAction: '/admin/permissions/create',
    deletePrefix: '/admin/permissions/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Permission Key' },
      { key: 'module', label: 'Module' },
    ],
    fields: [
      { name: 'name', label: 'Permission Key (e.g. coupons.manage)', type: 'text', required: true },
      { name: 'module', label: 'Module Name', type: 'text', required: true },
    ],
    rows,
  });
});

router.post('/admin/permissions/create', (req, res) => {
  db.run('INSERT INTO permissions (name, module) VALUES (?, ?)', req.body.name, req.body.module);
  res.redirect('/admin/permissions/manage');
});

router.post('/admin/permissions/delete/:id', (req, res) => {
  db.run('DELETE FROM permissions WHERE id = ?', req.params.id);
  res.redirect('/admin/permissions/manage');
});

router.get('/admin/customer', (_req, res) => {
  const rows = db.all('SELECT * FROM customers ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Registered & Order Customers',
    subtitle: 'স্টোরের সকল গ্রাহকের তালিকা ও মোট অর্ডার সংখ্যা',
    createAction: '/admin/customer/create',
    deletePrefix: '/admin/customer/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Customer Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' },
      { key: 'total_orders', label: 'Total Orders', type: 'badge' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Customer Name', type: 'text', required: true },
      { name: 'phone', label: 'Phone Number', type: 'text', required: true },
      { name: 'address', label: 'Address', type: 'text' },
    ],
    rows,
  });
});

router.post('/admin/customer/create', (req, res) => {
  db.run(
    'INSERT INTO customers (name, phone, address, total_orders) VALUES (?, ?, ?, 0)',
    req.body.name,
    req.body.phone,
    req.body.address || ''
  );
  req.flash('success', 'গ্রাহক যুক্ত হয়েছে।');
  res.redirect('/admin/customer');
});

router.post('/admin/customer/delete/:id', (req, res) => {
  db.run('DELETE FROM customers WHERE id = ?', req.params.id);
  res.redirect('/admin/customer');
});

// ─── Delivery Module ───
router.get('/admin/delivery-boys', (_req, res) => {
  const rows = db.all('SELECT * FROM delivery_boys ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Delivery Persons / Riders',
    subtitle: 'নিজস্ব ডেলিভারি রাইডার ও কমিশন ব্যবস্থাপনা',
    createAction: '/admin/delivery-boys/create',
    deletePrefix: '/admin/delivery-boys/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'name', label: 'Rider Name' },
      { key: 'phone', label: 'Phone' },
      { key: 'area', label: 'Assigned Zone' },
      { key: 'vehicle_type', label: 'Vehicle' },
      { key: 'commission_per_order', label: 'Per Order (৳)', type: 'currency' },
      { key: 'balance', label: 'Wallet', type: 'currency' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'name', label: 'Rider Name', type: 'text', required: true },
      { name: 'phone', label: 'Phone Number', type: 'text', required: true },
      { name: 'area', label: 'Delivery Zone', type: 'text', value: 'ঢাকা সিটি' },
      { name: 'vehicle_type', label: 'Vehicle', type: 'text', value: 'মোটরসাইকেল' },
      { name: 'commission_per_order', label: 'Commission Per Order (৳)', type: 'number', value: '50' },
    ],
    rows,
  });
});

router.post('/admin/delivery-boys/create', (req, res) => {
  const { name, phone, area, vehicle_type, commission_per_order } = req.body;
  db.run(
    'INSERT INTO delivery_boys (name, phone, area, vehicle_type, commission_per_order) VALUES (?, ?, ?, ?, ?)',
    name,
    phone,
    area || 'ঢাকা সিটি',
    vehicle_type || 'মোটরসাইকেল',
    Number(commission_per_order || 50)
  );
  req.flash('success', 'ডেলিভারি রাইডার যুক্ত হয়েছে।');
  res.redirect('/admin/delivery-boys');
});

router.post('/admin/delivery-boys/delete/:id', (req, res) => {
  db.run('DELETE FROM delivery_boys WHERE id = ?', req.params.id);
  res.redirect('/admin/delivery-boys');
});

router.get('/admin/delivery-withdrawals', (_req, res) => {
  const rows = db.all(
    `SELECT dw.*, d.name AS rider_name FROM delivery_withdrawals dw
     LEFT JOIN delivery_boys d ON d.id = dw.delivery_boy_id ORDER BY dw.id DESC`
  );
  const riders = db.all('SELECT id, name FROM delivery_boys');
  res.render('admin/crud-module', {
    pageTitle: 'Rider Withdrawals',
    subtitle: 'ডেলিভারি রাইডারদের কমিশন উত্তোলন',
    createAction: '/admin/delivery-withdrawals/create',
    customActionPrefix: '/admin/delivery-withdrawals/approve',
    customActionLabel: 'Mark Paid',
    deletePrefix: '/admin/delivery-withdrawals/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'rider_name', label: 'Rider' },
      { key: 'amount', label: 'Amount', type: 'currency' },
      { key: 'method', label: 'Method' },
      { key: 'account_number', label: 'Account No' },
      { key: 'status', label: 'Status', type: 'badge' },
    ],
    fields: [
      { name: 'delivery_boy_id', label: 'Rider', type: 'select', options: riders.map((r) => ({ value: r.id, label: r.name })) },
      { name: 'amount', label: 'Amount (৳)', type: 'number', required: true },
      { name: 'method', label: 'Method', type: 'text', value: 'bKash' },
      { name: 'account_number', label: 'Account No', type: 'text', required: true },
    ],
    rows,
  });
});

router.post('/admin/delivery-withdrawals/create', (req, res) => {
  db.run(
    'INSERT INTO delivery_withdrawals (delivery_boy_id, amount, method, account_number) VALUES (?, ?, ?, ?)',
    Number(req.body.delivery_boy_id || 1),
    Number(req.body.amount || 0),
    req.body.method || 'bKash',
    req.body.account_number
  );
  res.redirect('/admin/delivery-withdrawals');
});

router.post('/admin/delivery-withdrawals/approve/:id', (req, res) => {
  db.run("UPDATE delivery_withdrawals SET status = 'paid' WHERE id = ?", req.params.id);
  res.redirect('/admin/delivery-withdrawals');
});

router.post('/admin/delivery-withdrawals/delete/:id', (req, res) => {
  db.run('DELETE FROM delivery_withdrawals WHERE id = ?', req.params.id);
  res.redirect('/admin/delivery-withdrawals');
});

router.get('/admin/delivery/divisions', (_req, res) => {
  const rows = db.all('SELECT * FROM delivery_locations ORDER BY id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Delivery Locations (Division → District → Upazila)',
    subtitle: 'বিভাগ, জেলা ও উপজেলা ভিত্তিক ডেলিভারি চার্জ নির্ধারণ করুন',
    createAction: '/admin/delivery/divisions/create',
    deletePrefix: '/admin/delivery/divisions/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'division', label: 'Division' },
      { key: 'district', label: 'District' },
      { key: 'upazila', label: 'Upazila / Thana' },
      { key: 'delivery_charge', label: 'Delivery Charge', type: 'currency' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'division', label: 'Division (বিভাগ)', type: 'text', required: true },
      { name: 'district', label: 'District (জেলা)', type: 'text', required: true },
      { name: 'upazila', label: 'Upazila (উপজেলা/থানা)', type: 'text', required: true },
      { name: 'delivery_charge', label: 'Delivery Charge (৳)', type: 'number', value: '120', required: true },
    ],
    rows,
  });
});

router.post('/admin/delivery/divisions/create', (req, res) => {
  const { division, district, upazila, delivery_charge } = req.body;
  db.run(
    'INSERT INTO delivery_locations (division, district, upazila, delivery_charge) VALUES (?, ?, ?, ?)',
    division,
    district,
    upazila,
    Number(delivery_charge || 120)
  );
  req.flash('success', 'ডেলিভারি লোকেশন যুক্ত হয়েছে।');
  res.redirect('/admin/delivery/divisions');
});

router.post('/admin/delivery/divisions/delete/:id', (req, res) => {
  db.run('DELETE FROM delivery_locations WHERE id = ?', req.params.id);
  res.redirect('/admin/delivery/divisions');
});

module.exports = router;
