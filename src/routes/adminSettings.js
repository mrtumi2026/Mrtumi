const express = require('express');
const path = require('path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const db = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const upload = require('../middleware/upload');
const { env } = require('../config/env');
const settingsRepository = require('../repositories/settingsRepository');
const adminFinanceReadRepository = require('../repositories/adminFinanceReadRepository');
const { asyncHandler } = require('../utils/asyncHandler');
const { ValidationError } = require('../utils/errors');
const { getPool, createQueryClient } = require('../db/mysqlPool');

const router = express.Router();
router.use('/admin', requireAdmin);

function requireCsrfAndCleanupBannerFile(req, res, next) {
  return requireCsrf(req, res, (error) => {
    if (error && req.file) upload.safeUnlink(req.file.path);
    next(error);
  });
}

// ─── Landing Page / Campaigns ───
function renderCampaigns(res, openModal = false) {
  const rows = db.all(
    `SELECT c.*, p.name AS product_name
     FROM campaigns c
     LEFT JOIN products p ON p.id = c.product_id
     ORDER BY c.id DESC`
  );
  const products = db.all('SELECT id, name, new_price FROM products ORDER BY id ASC');

  res.render('admin/crud-module', {
    pageTitle: 'Landing Page Campaigns',
    subtitle: 'সিঙ্গেল প্রোডাক্ট হাই-কনভার্টিং ল্যান্ডিং পেজ তৈরি ও লাইভ লিংক কপি করুন',
    createAction: '/admin/campaign/create',
    deletePrefix: '/admin/campaign/delete',
    publicLinkPrefix: '/campaign',
    publicLinkKey: 'slug',
    autoOpenModal: openModal,
    columns: [
      { key: 'id', label: '#' },
      { key: 'title', label: 'Campaign Title' },
      { key: 'product_name', label: 'Linked Product' },
      { key: 'slug', label: 'URL Slug' },
      { key: 'offer_price', label: 'Offer Price', type: 'currency' },
      { key: 'status', label: 'Status', type: 'status' },
    ],
    fields: [
      { name: 'title', label: 'Campaign Title', type: 'text', required: true },
      { name: 'slug', label: 'Landing Page Slug (e.g. mango-fest)', type: 'text', required: true },
      {
        name: 'product_id',
        label: 'Target Product',
        type: 'select',
        options: products.map((p) => ({ value: p.id, label: `${p.name} (৳${p.new_price})` })),
      },
      { name: 'headline', label: 'Hero Headline (বাংলা)', type: 'text', required: true },
      { name: 'subheadline', label: 'Subheadline', type: 'text' },
      { name: 'regular_price', label: 'Regular Price (৳)', type: 'number', value: '1900' },
      { name: 'offer_price', label: 'Offer Price (৳)', type: 'number', value: '1300', required: true },
      {
        name: 'benefits',
        label: 'Key Benefits (separate with |)',
        type: 'textarea',
        value: 'শতভাগ ফরমালিনমুক্ত বাগানের তাজা ফল|সারা দেশে ক্যাশ অন ডেলিভারি|পণ্য দেখে মূল্য পরিশোধের সুবিধা',
      },
    ],
    rows,
  });
}

router.get('/admin/campaign/manage', (_req, res) => renderCampaigns(res, false));
router.get('/admin/campaign/create', (_req, res) => renderCampaigns(res, true));

router.post('/admin/campaign/create', (req, res) => {
  const b = req.body;
  const cleanSlug = String(b.slug || b.title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '') || `offer-${Date.now().toString().slice(-4)}`;
  db.run(
    `INSERT INTO campaigns (title, slug, product_id, headline, subheadline, regular_price, offer_price, benefits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    b.title,
    cleanSlug,
    Number(b.product_id || 1),
    b.headline || b.title,
    b.subheadline || '',
    Number(b.regular_price || 0),
    Number(b.offer_price || 1000),
    b.benefits || ''
  );
  req.flash('success', `ল্যান্ডিং পেজ তৈরি হয়েছে! ভিজিট করুন: /campaign/${cleanSlug}`);
  res.redirect('/admin/campaign/manage');
});

router.post('/admin/campaign/delete/:id', (req, res) => {
  db.run('DELETE FROM campaigns WHERE id = ?', req.params.id);
  res.redirect('/admin/campaign/manage');
});

// ─── Manual Fraud Check (/admin/manual-fraud-check) ───
router.get('/admin/manual-fraud-check', (req, res) => {
  const phone = String(req.query.phone || '').trim();
  const result = phone ? {
    phone,
    available: false,
    message: 'External fraud-provider verification is not configured. No courier history or risk score is available; review manually.',
  } : null;
  res.render('admin/fraud-check', { phone, result });
});

// ─── Send Custom SMS ───
router.get('/admin/sms/custom-send', (_req, res) => {
  const logs = db.all('SELECT * FROM sms_logs ORDER BY id DESC LIMIT 50');
  const customers = db.all('SELECT name, phone FROM customers ORDER BY id DESC LIMIT 100');
  res.render('admin/settings', {
    pageTitle: 'Send Custom SMS',
    section: 'custom_sms',
    logs,
    customers,
  });
});

router.post('/admin/sms/custom-send', (req, res) => {
  req.flash('error', 'SMS sending is disabled: no verified SMS provider is configured. No message was sent and no balance was changed.');
  return res.redirect('/admin/sms/custom-send');
});

function getDeliveryLocationChargeUpdates(changes) {
  const targets = [
    ['inside_dhaka_charge', 'Dhaka', 'Dhaka', 'ঢাকার ভিতরে (Inside Dhaka)'],
    ['outside_dhaka_charge', 'All', 'All', 'ঢাকার বাইরে (Outside Dhaka)'],
  ].filter(([key]) => Object.prototype.hasOwnProperty.call(changes, key));
  return targets.map(([key, division, district, upazila]) => {
    const amount = Number(changes[key]);
    if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100))) {
      throw new ValidationError('ডেলিভারি চার্জ সঠিকভাবে লিখুন।');
    }
    return { paisa: Math.round(amount * 100), division, district, upazila };
  });
}

async function syncDeliveryLocationCharges(updates) {
  if (!updates.length) return;
  const client = createQueryClient(getPool());
  for (const location of updates) {
    await client.execute(
      'UPDATE `delivery_locations` SET `delivery_charge_paisa` = ? WHERE `division` = ? AND `district` = ? AND `upazila` = ?',
      [location.paisa, location.division, location.district, location.upazila]
    );
  }
}

// ─── Universal Key-Value Settings Save Endpoint ───
router.post('/admin/settings/save', upload.single('logo_file'), asyncHandler(async (req, res) => {
  const redirectTo = req.body._redirect || req.get('Referrer') || '/admin/settings/manage';
  const changes = Object.fromEntries(Object.entries(req.body).filter(([key]) => !key.startsWith('_')));
  if (req.file) {
    const uploadedPath = `/uploads/custom/${req.file.filename}`;
    changes.logo_dark = uploadedPath;
    changes.logo_light = uploadedPath;
  }
  const deliveryChargeUpdates = env.db.client === 'mysql' ? getDeliveryLocationChargeUpdates(changes) : [];
  if (Object.keys(changes).length && env.db.client === 'mysql') {
    await settingsRepository.saveSettings(changes, {
      id: req.adminUser?.id || req.session?.adminUser?.id || null,
      ip: req.ip || '',
      userAgent: req.get('user-agent') || '',
    });
    await syncDeliveryLocationCharges(deliveryChargeUpdates);
  } else if (Object.keys(changes).length) {
    for (const [key, value] of Object.entries(changes)) db.setSetting(key, value);
  }
  req.flash('success', 'সেটিংস সফলভাবে সংরক্ষণ করা হয়েছে!');
  res.redirect(redirectTo);
}));

// ─── Site Settings & API Integrations Pages ───
const settingsPageMap = {
  '/admin/settings/manage': { title: 'General Site Settings', section: 'general' },
  '/admin/sale-notification': { title: 'Sales Notification Popup', section: 'sale_notification' },
  '/admin/contact/manage': { title: 'Contact Information', section: 'contact' },
  '/admin/email-setting': { title: 'SMTP & Email Settings', section: 'email' },
  '/admin/fraud-settings': { title: 'Fraud Check API Settings', section: 'fraud_api' },
  '/admin/order-restriction-settings': { title: 'Order Restriction & Anti-Spam', section: 'order_restriction' },
  '/admin/smsgeteway/manage': { title: 'SMS Gateway Configuration', section: 'sms_gateway' },
  '/admin/facebook-capi/settings': { title: 'Facebook Conversion API (CAPI)', section: 'fb_capi' },
  '/admin/gemini-ai/settings': { title: 'Gemini AI Assistant Settings', section: 'gemini_ai' },
  '/admin/social-login/settings': { title: 'Google & Facebook Social Login', section: 'social_login' },
  '/admin/cron-jobs': { title: 'Cron Jobs & Scheduled Tasks', section: 'cron_jobs' },
  '/admin/tag-manager/manage': { title: 'Google Tag Manager (GTM)', section: 'gtm' },
  '/admin/pixels/manage': { title: 'Facebook Pixel Manage', section: 'fb_pixel' },
  '/admin/tiktok-pixels/manage': { title: 'TikTok Pixel Configuration', section: 'tiktok_pixel' },
  '/admin/facebook-page/settings': { title: 'Facebook Page Auto-Post', section: 'fb_page' },
  '/admin/popup': { title: 'Promotional Popup Offer', section: 'popup_offer' },
  '/admin/seo-settings': { title: 'SEO & Meta Tags Settings', section: 'seo' },
  '/admin/sitemap': { title: 'XML Sitemap Settings', section: 'sitemap' },
  '/admin/license-info': { title: 'System Information & License', section: 'license' },
  '/admin/updates': { title: 'System Version & Updates', section: 'updates' },
};

for (const [routePath, cfg] of Object.entries(settingsPageMap)) {
  router.get(routePath, (_req, res) => {
    res.render('admin/settings', {
      pageTitle: cfg.title,
      section: cfg.section,
      logs: [],
      customers: [],
    });
  });
}

// ─── Social Media, Feature Bar, CMS Pages, Banners, Payment Gateways, Couriers ───
router.get('/admin/social-media/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM social_links ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Social Media Links',
    subtitle: 'ওয়েবসাইটের হেডার ও ফুটারে প্রদর্শিত সোশ্যাল মিডিয়া লিংকসমূহ',
    createAction: '/admin/social-media/create',
    deletePrefix: '/admin/social-media/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'platform', label: 'Platform' },
      { key: 'url', label: 'Profile URL' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'platform', label: 'Platform (Facebook / WhatsApp / YouTube)', type: 'text', required: true },
      { name: 'url', label: 'URL', type: 'text', required: true },
    ],
    rows,
  });
});

router.post('/admin/social-media/create', (req, res) => {
  db.run('INSERT INTO social_links (platform, url) VALUES (?, ?)', req.body.platform, req.body.url);
  res.redirect('/admin/social-media/manage');
});
router.post('/admin/social-media/delete/:id', (req, res) => {
  db.run('DELETE FROM social_links WHERE id = ?', req.params.id);
  res.redirect('/admin/social-media/manage');
});

router.get('/admin/features/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM features ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Storefront Feature Bar',
    subtitle: 'হোমপেজ ও ফুটারের ট্রাস্ট ব্যাজ ফিচার বার',
    createAction: '/admin/features/create',
    deletePrefix: '/admin/features/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'title', label: 'Title' },
      { key: 'subtitle', label: 'Subtitle' },
      { key: 'icon', label: 'Feather Icon' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true },
      { name: 'subtitle', label: 'Subtitle', type: 'text', required: true },
      { name: 'icon', label: 'Icon Name (shield / truck / check-circle)', type: 'text', value: 'shield' },
    ],
    rows,
  });
});

router.post('/admin/features/create', (req, res) => {
  db.run('INSERT INTO features (title, subtitle, icon) VALUES (?, ?, ?)', req.body.title, req.body.subtitle, req.body.icon || 'shield');
  res.redirect('/admin/features/manage');
});
router.post('/admin/features/delete/:id', (req, res) => {
  db.run('DELETE FROM features WHERE id = ?', req.params.id);
  res.redirect('/admin/features/manage');
});

router.get('/admin/page/manage', (_req, res) => {
  const rows = db.all('SELECT * FROM cms_pages ORDER BY id ASC');
  res.render('admin/crud-module', {
    pageTitle: 'Custom Pages (CMS)',
    subtitle: 'প্রাইভেসি পলিসি, রিটার্ন পলিসি ও আমাদের সম্পর্কে পেজ তৈরি করুন',
    createAction: '/admin/page/create',
    deletePrefix: '/admin/page/delete',
    publicLinkPrefix: '/page',
    publicLinkKey: 'slug',
    columns: [
      { key: 'id', label: '#' },
      { key: 'title', label: 'Page Title' },
      { key: 'slug', label: 'URL Slug' },
      { key: 'status', label: 'Active', type: 'status' },
    ],
    fields: [
      { name: 'title', label: 'Page Title', type: 'text', required: true },
      { name: 'slug', label: 'URL Slug (e.g. refund-policy)', type: 'text', required: true },
      { name: 'content', label: 'Page Content', type: 'textarea', required: true },
    ],
    rows,
  });
});

router.post('/admin/page/create', (req, res) => {
  const slug = String(req.body.slug || req.body.title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  db.run('INSERT INTO cms_pages (title, slug, content) VALUES (?, ?, ?)', req.body.title, slug, req.body.content || '');
  req.flash('success', 'পেজ তৈরি হয়েছে।');
  res.redirect('/admin/page/manage');
});
router.post('/admin/page/delete/:id', (req, res) => {
  db.run('DELETE FROM cms_pages WHERE id = ?', req.params.id);
  res.redirect('/admin/page/manage');
});

// Priority integrations use the async MySQL client in production; SQLite remains a local fallback.
const integrationsMysql = () => env.db.client === 'mysql';
const integrationsClient = () => createQueryClient(getPool());
const safeBannerLink = (value) => {
  const link = String(value || '/all-products').trim();
  return ((link.startsWith('/') && !link.startsWith('//') && !link.includes('..')) || /^https?:\/\//i.test(link)) ? link : '/all-products';
};
const validBannerImageUrl = (value) => {
  const image = String(value || '').trim();
  return (image.startsWith('/') && !image.startsWith('//') && !image.includes('..')) || /^https?:\/\//i.test(image);
};
const cleanBannerText = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const safeSortOrder = (value) => {
  const order = Number(value);
  return Number.isSafeInteger(order) && order >= 0 && order <= 2147483647 ? order : 0;
};
const removeManagedBannerImage = (image) => {
  const value = String(image || '');
  if (!value.startsWith('/uploads/custom/')) return;
  const base = path.resolve(upload.resolveUploadBase());
  const candidate = path.resolve(base, path.basename(value));
  if (path.dirname(candidate) === base) upload.safeUnlink(candidate);
};
const saveBannerBase64 = async (value) => {
  const dataUrl = String(value || '').trim();
  if (!dataUrl) return null;
  const match = /^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
  if (!match) throw new ValidationError('Select a valid raster image and wait for compression to finish.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 180 * 1024 || buffer.toString('base64') !== match[2]) {
    throw new ValidationError('Compressed banner image must be smaller than 180 KB.');
  }
  const mime = match[1].toLowerCase();
  const signatures = {
    jpeg: { ext: '.jpg', valid: buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9 },
    jpg: { ext: '.jpg', valid: buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9 },
    png: { ext: '.png', valid: buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
    webp: { ext: '.webp', valid: buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
    gif: { ext: '.gif', valid: buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)) },
  };
  const signature = signatures[mime];
  if (!signature || !signature.valid) throw new ValidationError('Banner image data does not match its raster image type.');
  const filename = `banner-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${signature.ext}`;
  const base = path.resolve(upload.resolveUploadBase());
  const target = path.resolve(base, filename);
  if (path.dirname(target) !== base) throw new ValidationError('Invalid banner image destination.');
  await fs.writeFile(target, buffer, { flag: 'wx', mode: 0o644 });
  return `/uploads/custom/${filename}`;
};

// Banner & Sliders
router.get('/admin/banner/manage', asyncHandler(async (req, res) => {
  const rows = integrationsMysql()
    ? await integrationsClient().queryAll('SELECT id,title,subtitle,badge,position,image_url AS image,link_url AS link,sort_order,status,created_at FROM banners ORDER BY sort_order ASC,id DESC')
    : db.all('SELECT * FROM banners ORDER BY sort_order ASC, id DESC');
  res.render('admin/crud-module', {
    pageTitle: 'Banner & Sliders', subtitle: 'হোমপেজের মেইন স্লাইডার ও প্রোমো ব্যানার পরিচালনা করুন',
    createAction: '/admin/banner/create', updatePrefix: '/admin/banner/update', multipartForm: true, deletePrefix: '/admin/banner/delete', autoOpenModal: req.query.create === '1',
    columns: [{key:'id',label:'#'},{key:'image',label:'Preview',type:'image'},{key:'title',label:'Banner Title'},{key:'position',label:'Position',type:'badge'},{key:'link',label:'Target Link'},{key:'status',label:'Active',type:'status'}],
    fields: [{name:'title',label:'Banner Headline',type:'text',required:true},{name:'subtitle',label:'Subtitle',type:'text'},{name:'badge',label:'Badge',type:'text'},
      {name:'position',label:'Placement',type:'select',options:[{value:'hero',label:'Hero Slider (Top)'},{value:'promo_mid',label:'Middle Promo Banner'}]},
      {name:'image_file',label:'Upload raster image (optional)',type:'file'},{name:'image_url',label:'Image URL / Path fallback',type:'text'},
      {name:'link_url',label:'Target URL',type:'text',value:'/all-products'},{name:'sort_order',label:'Display order',type:'number',value:'0'}], rows,
  });
}));
router.get('/admin/banner/create', (_req, res) => res.redirect('/admin/banner/manage?create=1'));
router.post('/admin/banner/create', upload.single('image_file'), requireCsrfAndCleanupBannerFile, asyncHandler(async (req, res) => {
  let image;
  let generatedImage = null;
  try {
    image = req.file ? upload.validateUploadedImageFile(req.file) : await saveBannerBase64(req.body.image_base64);
    generatedImage = req.file ? null : image;
    if (!image) image = String(req.body.image_url || req.body.image || '').trim();
    if (!validBannerImageUrl(image)) throw new ValidationError('Provide a valid banner image upload or an HTTP(S)/site-relative image URL.');
    const b=req.body, position=['hero','promo_mid'].includes(b.position)?b.position:'hero';
    if (integrationsMysql()) await integrationsClient().execute('INSERT INTO banners (title,subtitle,badge,position,image_url,link_url,sort_order,status) VALUES (?,?,?,?,?,?,?,1)', [cleanBannerText(b.title,191),cleanBannerText(b.subtitle,255),cleanBannerText(b.badge,100),position,image,safeBannerLink(b.link_url||b.link),safeSortOrder(b.sort_order)]);
    else db.run('INSERT INTO banners (title,subtitle,badge,position,image,link,sort_order) VALUES (?,?,?,?,?,?,?)',cleanBannerText(b.title,191),cleanBannerText(b.subtitle,255),cleanBannerText(b.badge,100),position,image,safeBannerLink(b.link_url||b.link),safeSortOrder(b.sort_order));
  } catch (err) {
    if (req.file) upload.safeUnlink(req.file.path);
    if (generatedImage) removeManagedBannerImage(generatedImage);
    if (err instanceof ValidationError) {
      req.flash('error', err.message);
      return res.redirect('/admin/banner/manage?create=1');
    }
    throw err;
  }
  req.flash('success','ব্যানার যুক্ত হয়েছে!'); res.redirect('/admin/banner/manage');
}));
router.post('/admin/banner/update/:id', upload.single('image_file'), requireCsrfAndCleanupBannerFile, asyncHandler(async (req,res)=>{
 let newImage=null, oldImage='', generatedImage=null;
 try {
   const b=req.body, id=Number(req.params.id);
   if(!Number.isSafeInteger(id)||id<1) throw new ValidationError('Invalid banner identifier.');
   const current=integrationsMysql()
     ? await integrationsClient().queryOne('SELECT id,image_url AS image FROM banners WHERE id=?',[id])
     : db.get('SELECT id,image AS image FROM banners WHERE id=?',id);
   if(!current) throw new ValidationError('Banner was not found.');
   oldImage=String(current.image||'');
   if(req.file) newImage=upload.validateUploadedImageFile(req.file);
   else if(b.image_base64) { newImage=await saveBannerBase64(b.image_base64); generatedImage=newImage; }
   const submittedImage=String(b.image_url||'').trim();
   const image=newImage || (validBannerImageUrl(submittedImage)?submittedImage:oldImage);
   const title=cleanBannerText(b.title,191), subtitle=cleanBannerText(b.subtitle,255), badge=cleanBannerText(b.badge,100);
   const position=['hero','promo_mid'].includes(b.position)?b.position:'hero';
   const link=safeBannerLink(b.link_url||b.link), sortOrder=safeSortOrder(b.sort_order);
   if(integrationsMysql()) await integrationsClient().execute('UPDATE banners SET title=?,subtitle=?,badge=?,position=?,image_url=?,link_url=?,sort_order=? WHERE id=?',[title,subtitle,badge,position,image,link,sortOrder,id]);
   else db.run('UPDATE banners SET title=?,subtitle=?,badge=?,position=?,image=?,link=?,sort_order=? WHERE id=?',title,subtitle,badge,position,image,link,sortOrder,id);
   if(image!==oldImage) removeManagedBannerImage(oldImage);
 } catch(err) {
   if(req.file) upload.safeUnlink(req.file.path);
   if(generatedImage) removeManagedBannerImage(generatedImage);
   if(err instanceof ValidationError) { req.flash('error',err.message); return res.redirect('/admin/banner/manage'); }
   throw err;
 }
 req.flash('success','ব্যানার সফলভাবে আপডেট হয়েছে!');
 res.redirect('/admin/banner/manage');
}));
router.post('/admin/banner/delete/:id', asyncHandler(async (req,res)=>{
  if(integrationsMysql()) await integrationsClient().execute('DELETE FROM banners WHERE id=?',[req.params.id]);
  else db.run('DELETE FROM banners WHERE id = ?',req.params.id);
  res.redirect('/admin/banner/manage');
}));

// Payment Gateways (Auto & Manual)
router.get('/admin/paymentgeteway/manage', asyncHandler(async (_req,res)=>renderGateways(res,'auto')));
router.get('/admin/paymentgeteway/manual-manage', asyncHandler(async (_req,res)=>renderGateways(res,'manual')));
async function renderGateways(res,type) {
  const rows=integrationsMysql()
    ? await integrationsClient().queryAll('SELECT id,name,code,gateway_type AS type,account_number,instructions,status,sandbox,updated_at FROM payment_gateways WHERE gateway_type=? ORDER BY id ASC',[type])
    : db.all('SELECT * FROM payment_gateways WHERE type = ? ORDER BY id ASC',type);
  res.render('admin/crud-module',{pageTitle:type==='manual'?'Manual Payment Methods (bKash / Nagad / Rocket)':'Automatic Payment Gateways',subtitle:'চেকআউট পেজের পেমেন্ট গেটওয়ে ও অ্যাকাউন্ট নম্বর পরিচালনা করুন',createAction:`/admin/paymentgeteway/${type}/create`,updatePrefix:'/admin/paymentgeteway/update',customActionPrefix:'/admin/paymentgeteway/toggle',customActionLabel:'Toggle Active',deletePrefix:'/admin/paymentgeteway/delete',
    columns:[{key:'id',label:'#'},{key:'name',label:'Gateway Name'},{key:'code',label:'Code'},{key:'account_number',label:'Merchant / Personal No'},{key:'instructions',label:'Checkout Instructions'},{key:'status',label:'Status',type:'status'}],
    fields:[{name:'name',label:'Method Name',type:'text',required:true},{name:'code',label:'Unique Code',type:'text',required:true},{name:'account_number',label:'Account / Merchant Number',type:'text'},{name:'api_key',label:'API credential',type:'password'},{name:'secret_key',label:'Secret credential',type:'password'},{name:'instructions',label:'Customer Instructions',type:'textarea'},{name:'sandbox',label:'Sandbox (1/0)',type:'number',value:'1'}],rows});
}
router.post('/admin/paymentgeteway/:type/create',asyncHandler(async(req,res)=>{
 const t=req.params.type==='manual'?'manual':'auto',b=req.body;
 if(integrationsMysql()) await integrationsClient().execute('INSERT INTO payment_gateways (name,code,gateway_type,account_number,api_key,secret_key,instructions,sandbox,status) VALUES (?,?,?,?,?,?,?,?,1)',[b.name,b.code,t,b.account_number||'',b.api_key||null,b.secret_key||null,b.instructions||'',b.sandbox==='0'?0:1]);
 else db.run('INSERT INTO payment_gateways (name,code,type,account_number,instructions,status) VALUES (?,?,?,?,?,1)',b.name,b.code,t,b.account_number||'',b.instructions||'');
 req.flash('success','পেমেন্ট মেথড যুক্ত হয়েছে।');res.redirect(t==='manual'?'/admin/paymentgeteway/manual-manage':'/admin/paymentgeteway/manage');
}));
router.post('/admin/paymentgeteway/update/:id',asyncHandler(async(req,res)=>{
 const b=req.body,name=cleanBannerText(b.name,100),code=cleanBannerText(b.code,48),account=cleanBannerText(b.account_number,100),instructions=String(b.instructions||'').trim().slice(0,4000),sandbox=b.sandbox==='0'?0:1;
 if(!name||!/^[a-zA-Z0-9_-]{1,48}$/.test(code)) throw new ValidationError('Gateway name and a valid unique code are required.');
 if(integrationsMysql()) await integrationsClient().execute("UPDATE payment_gateways SET name=?,code=?,account_number=?,api_key=COALESCE(NULLIF(?,''),api_key),secret_key=COALESCE(NULLIF(?,''),secret_key),instructions=?,sandbox=? WHERE id=?",[name,code,account,String(b.api_key||''),String(b.secret_key||''),instructions,sandbox,req.params.id]);
 else db.run("UPDATE payment_gateways SET name=?,code=?,account_number=?,app_key=CASE WHEN ?<>'' THEN ? ELSE app_key END,app_secret=CASE WHEN ?<>'' THEN ? ELSE app_secret END,instructions=?,sandbox=? WHERE id=?",name,code,account,String(b.api_key||''),String(b.api_key||''),String(b.secret_key||''),String(b.secret_key||''),instructions,sandbox,req.params.id);
 req.flash('success','পেমেন্ট গেটওয়ে সফলভাবে আপডেট হয়েছে।');
 res.redirect('/admin/paymentgeteway/manage');
}));
router.post('/admin/paymentgeteway/toggle/:id',asyncHandler(async(req,res)=>{
 if(integrationsMysql()) await integrationsClient().execute('UPDATE payment_gateways SET status=1-status WHERE id=?',[req.params.id]);
 else {const gw=db.get('SELECT id,status FROM payment_gateways WHERE id=?',req.params.id);if(gw)db.run('UPDATE payment_gateways SET status=? WHERE id=?',gw.status?0:1,gw.id);}
 req.flash('success','পেমেন্ট গেটওয়ে স্ট্যাটাস আপডেট হয়েছে।');res.redirect(req.get('Referrer')||'/admin/paymentgeteway/manage');
}));
router.post('/admin/paymentgeteway/delete/:id',asyncHandler(async(req,res)=>{if(integrationsMysql())await integrationsClient().execute('DELETE FROM payment_gateways WHERE id=?',[req.params.id]);else db.run('DELETE FROM payment_gateways WHERE id=?',req.params.id);res.redirect(req.get('Referrer')||'/admin/paymentgeteway/manage');}));

// Courier API Manage
router.get('/admin/courierapi/manage',asyncHandler(async(_req,res)=>{
 const rows=integrationsMysql()?await integrationsClient().queryAll('SELECT id,name,code,api_key,secret_key,client_id,base_url,status,sandbox,updated_at FROM courier_apis ORDER BY id ASC'):db.all('SELECT * FROM courier_apis ORDER BY id ASC');
 res.render('admin/crud-module',{pageTitle:'Courier API Integration (Steadfast / Pathao / RedX)',subtitle:'কুরিয়ার API কী ও ব্যালেন্স কনফিগারেশন',createAction:'/admin/courierapi/create',updatePrefix:'/admin/courierapi/update',customActionPrefix:'/admin/courierapi/toggle',customActionLabel:'Toggle Active',deletePrefix:'/admin/courierapi/delete',columns:[{key:'id',label:'#'},{key:'name',label:'Courier Service'},{key:'code',label:'Code'},{key:'api_key',label:'API Key'},{key:'base_url',label:'Endpoint URL'},{key:'status',label:'Active',type:'status'}],fields:[{name:'name',label:'Courier Name',type:'text',required:true},{name:'code',label:'Code',type:'text',required:true},{name:'api_key',label:'API Key / Token',type:'password',required:true},{name:'secret_key',label:'Secret Key',type:'password'},{name:'client_id',label:'Client ID',type:'text'},{name:'base_url',label:'Base API URL',type:'text'},{name:'sandbox',label:'Sandbox (1/0)',type:'number',value:'1'}],rows});
}));
router.post('/admin/courierapi/create',asyncHandler(async(req,res)=>{const b=req.body;if(integrationsMysql())await integrationsClient().execute('INSERT INTO courier_apis (name,code,base_url,api_key,secret_key,client_id,status,sandbox) VALUES (?,?,?,?,?,?,0,?)',[b.name,b.code,b.base_url||'',b.api_key||null,b.secret_key||null,b.client_id||'',b.sandbox==='0'?0:1]);else db.run('INSERT INTO courier_apis (name,code,api_key,secret_key,base_url,client_id) VALUES (?,?,?,?,?,?)',b.name,b.code,b.api_key,b.secret_key||'',b.base_url||'',b.client_id||'');res.redirect('/admin/courierapi/manage');}));
router.post('/admin/courierapi/update/:id',asyncHandler(async(req,res)=>{
 const b=req.body,name=cleanBannerText(b.name,100),code=cleanBannerText(b.code,48),baseUrl=String(b.base_url||'').trim().slice(0,255),apiKey=String(b.api_key||''),secretKey=String(b.secret_key||''),clientId=cleanBannerText(b.client_id,191),sandbox=b.sandbox==='0'?0:1;
 if(!name||!/^[a-zA-Z0-9_-]{1,48}$/.test(code)) throw new ValidationError('Courier name and a valid unique code are required.');
 if(integrationsMysql()) await integrationsClient().execute("UPDATE courier_apis SET name=?,code=?,base_url=?,api_key=CASE WHEN ?<>'' THEN ? ELSE api_key END,secret_key=CASE WHEN ?<>'' THEN ? ELSE secret_key END,client_id=?,sandbox=? WHERE id=?",[name,code,baseUrl,apiKey,apiKey,secretKey,secretKey,clientId,sandbox,req.params.id]);
 else db.run("UPDATE courier_apis SET name=?,code=?,base_url=?,api_key=CASE WHEN ?<>'' THEN ? ELSE api_key END,secret_key=CASE WHEN ?<>'' THEN ? ELSE secret_key END,client_id=?,sandbox=? WHERE id=?",name,code,baseUrl,apiKey,apiKey,secretKey,secretKey,clientId,sandbox,req.params.id);
 req.flash('success','কুরিয়ার API সফলভাবে আপডেট হয়েছে।');
 res.redirect('/admin/courierapi/manage');
}));
router.post('/admin/courierapi/toggle/:id',asyncHandler(async(req,res)=>{if(integrationsMysql())await integrationsClient().execute('UPDATE courier_apis SET status=1-status WHERE id=?',[req.params.id]);else{const c=db.get('SELECT id,status FROM courier_apis WHERE id=?',req.params.id);if(c)db.run('UPDATE courier_apis SET status=? WHERE id=?',c.status?0:1,c.id);}res.redirect('/admin/courierapi/manage');}));
router.post('/admin/courierapi/delete/:id',asyncHandler(async(req,res)=>{if(integrationsMysql())await integrationsClient().execute('DELETE FROM courier_apis WHERE id=?',[req.params.id]);else db.run('DELETE FROM courier_apis WHERE id=?',req.params.id);res.redirect('/admin/courierapi/manage');}));

// ─── Live Ads Result (/admin/ads-analytics) ───
router.get('/admin/ads-analytics', (_req, res) => renderAds(res, 'overview'));
router.get('/admin/ads-analytics/:channel', (req, res) => renderAds(res, req.params.channel));

function renderAds(res, channel) {
  const s = db.getSettings();
  const fbOrders = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS rev FROM orders WHERE traffic_source = 'Facebook'");
  const directOrders = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS rev FROM orders WHERE traffic_source = 'Direct'");
  const otherOrders = db.get("SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS rev FROM orders WHERE traffic_source NOT IN ('Facebook', 'Direct')");

  res.render('admin/ads-analytics', {
    channel,
    fbOrders,
    directOrders,
    otherOrders,
    adSettings: s,
  });
}

// ─── Reports (/admin/reports/:type) ───
router.get('/admin/reports/:type', asyncHandler(async (req, res) => {
  const type = req.params.type;
  const format = req.query.export;
  if(env.db.client==='mysql'){
    const report=await adminFinanceReadRepository.getReport(type);
    if(format==='csv'){
      const lines=[report.columns.join(',')];
      for(const row of report.rows)lines.push(report.columns.map((column)=>`"${String(row[column]??'').replace(/"/g,'""')}"`).join(','));
      res.setHeader('Content-Type','text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',`attachment; filename="${type}-report.csv"`);
      return res.send('\uFEFF'+lines.join('\n'));
    }
    return res.render('admin/reports',{type,reportTitle:report.reportTitle,rows:report.rows,columns:report.columns,summary:report.summary});
  }

  const totalSales = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM orders WHERE status != 'cancelled'").s;
  const completedSales = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM orders WHERE status = 'completed'").s;
  const totalPurchases = db.get('SELECT COALESCE(SUM(total_cost), 0) AS s FROM purchases').s;
  const totalExpenses = db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM expenses').s;
  const stockValue = db.get('SELECT COALESCE(SUM(stock * purchase_price), 0) AS cost_val, COALESCE(SUM(stock * new_price), 0) AS retail_val FROM products');

  let rows = [];
  let columns = [];
  let reportTitle = 'Order Report';

  if (type === 'orders') {
    reportTitle = 'Order Report';
    rows = db.all('SELECT invoice_id, customer_name, phone, amount, status, traffic_source, created_at FROM orders ORDER BY id DESC');
    columns = ['invoice_id', 'customer_name', 'phone', 'amount', 'status', 'traffic_source', 'created_at'];
  } else if (type === 'purchases') {
    reportTitle = 'Purchase Report';
    rows = db.all(
      `SELECT pu.reference_no, s.name AS supplier, p.name AS product, pu.qty, pu.unit_cost, pu.total_cost, pu.purchase_date
       FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN products p ON p.id = pu.product_id ORDER BY pu.id DESC`
    );
    columns = ['reference_no', 'supplier', 'product', 'qty', 'unit_cost', 'total_cost', 'purchase_date'];
  } else if (type === 'expenses') {
    reportTitle = 'Expense Report';
    rows = db.all('SELECT id, title, category, amount, note, expense_date FROM expenses ORDER BY id DESC');
    columns = ['id', 'title', 'category', 'amount', 'note', 'expense_date'];
  } else if (type === 'stock') {
    reportTitle = 'Inventory & Stock Report';
    rows = db.all(
      `SELECT p.code, p.name, c.name AS category, p.purchase_price, p.new_price, p.stock, p.sold_count
       FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.stock ASC`
    );
    columns = ['code', 'name', 'category', 'purchase_price', 'new_price', 'stock', 'sold_count'];
  } else {
    reportTitle = 'Profit & Loss Statement';
    rows = [
      { metric: 'Total Gross Order Value (Active Orders)', amount: totalSales },
      { metric: 'Completed / Delivered Order Revenue', amount: completedSales },
      { metric: 'Total Stock Purchases Cost', amount: totalPurchases },
      { metric: 'Total Operational Expenses', amount: totalExpenses },
      { metric: 'Current Inventory Valuation (Retail)', amount: stockValue.retail_val },
      { metric: 'Net Estimated Operating Profit (Gross Orders - Expenses)', amount: totalSales - totalExpenses },
    ];
    columns = ['metric', 'amount'];
  }

  if (format === 'csv') {
    const csvLines = [columns.join(',')];
    for (const r of rows) {
      csvLines.push(columns.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report.csv"`);
    return res.send('\uFEFF' + csvLines.join('\n'));
  }

  res.render('admin/reports', {
    type,
    reportTitle,
    rows,
    columns,
    summary: {
      totalSales,
      completedSales,
      totalPurchases,
      totalExpenses,
      stockCostVal: stockValue.cost_val,
      stockRetailVal: stockValue.retail_val,
    },
  });
}));

// ─── Clear Cache & Error Log ───
router.get('/admin/clear-cache', (_req,res) => res.status(405).send('Use the CSRF-protected POST form.'));
router.post('/admin/clear-cache', (req, res) => {
  db.run('INSERT INTO error_logs (level, message, context) VALUES (?, ?, ?)', 'INFO', 'Application & template cache cleared by Admin', 'cache');
  req.flash('success', 'সিস্টেম ক্যাশ সফলভাবে ক্লিয়ার করা হয়েছে!');
  res.redirect(req.get('Referrer') || '/admin/dashboard');
});

router.get('/admin/error-log', (_req, res) => {
  const rows = db.all('SELECT * FROM error_logs ORDER BY id DESC LIMIT 100');
  res.render('admin/crud-module', {
    pageTitle: 'System & Activity Logs',
    subtitle: 'সার্ভার ইভেন্ট ও সিস্টেম লগসমূহ',
    deletePrefix: '/admin/error-log/delete',
    columns: [
      { key: 'id', label: '#' },
      { key: 'level', label: 'Level', type: 'badge' },
      { key: 'message', label: 'Message' },
      { key: 'context', label: 'Context' },
      { key: 'created_at', label: 'Timestamp' },
    ],
    fields: [],
    rows,
  });
});

router.post('/admin/error-log/delete/:id', (req, res) => {
  db.run('DELETE FROM error_logs WHERE id = ?', req.params.id);
  res.redirect('/admin/error-log');
});

module.exports = router;
