'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const repo = require('../repositories/phase06Repository');
const router = express.Router();
router.use('/admin/phase06', requireAdmin);

function actor(req) {
  return { id: req.adminUser?.id || req.session?.adminUser?.id || null, ip: req.ip || '', userAgent: req.get('user-agent') || '' };
}
function wantsJson(req) { return req.accepts(['html','json']) === 'json' || req.is('application/json'); }
function asyncRoute(fn) { return (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next); }

router.get('/admin/phase06', asyncRoute(async (req,res) => {
  const [products, inventory, suppliers, purchases, ledger, taxonomy] = await Promise.all([
    repo.listProducts(), repo.listInventory(), repo.listSuppliers(), repo.listPurchases(), repo.listStockLedger(req.query.product_id || null), repo.listProductEditOptions(),
  ]);
  res.render('admin/phase06', { products, inventory, suppliers, purchases, ledger, categories:taxonomy.categories, brands:taxonomy.brands,
    pageTitle: req.locale === 'en' ? 'Products, Inventory & Purchasing' : 'পণ্য, ইনভেন্টরি ও পারচেজ', csrfToken: req.csrfToken() });
}));

router.get('/admin/phase06/products/:id/edit', asyncRoute(async (req,res) => {
  const [product, options, variants, gallery] = await Promise.all([repo.getProductForEdit(req.params.id), repo.listProductEditOptions(), repo.listProductVariants(req.params.id), repo.getProductGalleryForEdit(req.params.id)]);
  const { paisaToBdtString } = require('../utils/money');
  res.render('admin/phase06-product-edit', {
    product, categories:options.categories, brands:options.brands, variants, galleryPaths:gallery.paths, galleryBlockedCount:gallery.blockedCount, paisaToBdtString,
    pageTitle: req.locale === 'en' ? `Edit ${product.sku}` : `${product.sku} সম্পাদনা`, csrfToken:req.csrfToken(), locale:req.locale,
  });
}));

router.post('/admin/phase06/products/:id', requireCsrf, asyncRoute(async (req,res) => {
  const result = await repo.updateProduct(req.params.id, req.body, actor(req));
  if (wantsJson(req)) return res.json({ success:true, product:result });
  req.flash('success', req.locale === 'en' ? `Product ${result.sku} updated. Stock and variant records were not changed.` : `পণ্য ${result.sku} আপডেট হয়েছে। স্টক ও ভ্যারিয়েন্ট অপরিবর্তিত আছে।`);
  return res.redirect('/admin/phase06');
}));

router.post('/admin/phase06/products/:id/gallery', requireCsrf, asyncRoute(async (req,res) => {
  const gallery = await repo.updateProductGallery(req.params.id, req.body, actor(req));
  if (wantsJson(req)) return res.json({ success:true, gallery });
  req.flash('success', req.locale === 'en' ? 'Gallery order saved. Image files were not changed or deleted.' : 'গ্যালারির ক্রম সংরক্ষিত হয়েছে। কোনো ছবি ফাইল বদলানো বা মুছে ফেলা হয়নি।');
  return res.redirect(`/admin/phase06/products/${req.params.id}/edit#gallery`);
}));

router.post('/admin/phase06/products/:id/variants', requireCsrf, asyncRoute(async (req,res) => {
  const variant = await repo.createProductVariant(req.params.id, req.body, actor(req));
  if (wantsJson(req)) return res.status(201).json({ success:true, variant });
  req.flash('success', req.locale === 'en' ? `Variant ${variant.variantSku} created with zero stock.` : `ভ্যারিয়েন্ট ${variant.variantSku} তৈরি হয়েছে; স্টক শূন্য।`);
  return res.redirect(`/admin/phase06/products/${req.params.id}/edit#variants`);
}));

router.post('/admin/phase06/products/:id/variants/:variantId', requireCsrf, asyncRoute(async (req,res) => {
  const variant = await repo.updateProductVariant(req.params.id, req.params.variantId, req.body, actor(req));
  if (wantsJson(req)) return res.json({ success:true, variant });
  req.flash('success', req.locale === 'en' ? `Variant ${variant.variantSku} updated; inventory references were preserved.` : `ভ্যারিয়েন্ট ${variant.variantSku} আপডেট হয়েছে; ইনভেন্টরি রেফারেন্স অক্ষত আছে।`);
  return res.redirect(`/admin/phase06/products/${req.params.id}/edit#variants`);
}));

router.post('/admin/phase06/products', requireCsrf, asyncRoute(async (req,res) => {
  const created = await repo.createProduct(req.body, actor(req));
  if (wantsJson(req)) return res.status(201).json({ success:true, product:created });
  req.flash('success', req.locale === 'en' ? `Product ${created.product.sku} created.` : `পণ্য ${created.product.sku} তৈরি হয়েছে।`);
  return res.redirect('/admin/phase06');
}));

router.post('/admin/phase06/products/:id/archive', requireCsrf, asyncRoute(async (req,res) => {
  const result = await repo.archiveProduct(req.params.id, true, actor(req));
  if (wantsJson(req)) return res.json({ success:true, ...result });
  req.flash('success', req.locale === 'en' ? 'Product archived; historical order references retained.' : 'পণ্য আর্কাইভ করা হয়েছে; পুরোনো অর্ডার রেফারেন্স অক্ষত আছে।');
  return res.redirect('/admin/phase06');
}));

router.post('/admin/phase06/products/:id/restore', requireCsrf, asyncRoute(async (req,res) => {
  const result = await repo.archiveProduct(req.params.id, false, actor(req));
  if (wantsJson(req)) return res.json({ success:true, ...result });
  return res.redirect('/admin/phase06');
}));

router.post('/admin/phase06/inventory/adjust', requireCsrf, asyncRoute(async (req,res) => {
  const movement = await repo.adjustStock(req.body, actor(req));
  if (wantsJson(req)) return res.json({ success:true, movement });
  req.flash('success', req.locale === 'en' ? `Stock updated: ${movement.previousBalance} → ${movement.balanceAfter}.` : `স্টক সমন্বয় হয়েছে: ${movement.previousBalance} → ${movement.balanceAfter}।`);
  return res.redirect('/admin/phase06');
}));

router.post('/admin/phase06/suppliers', requireCsrf, asyncRoute(async (req,res) => {
  const supplier = await repo.createSupplier(req.body, actor(req));
  if (wantsJson(req)) return res.status(201).json({ success:true, supplier });
  req.flash('success', req.locale === 'en' ? 'Supplier created.' : 'সরবরাহকারী যুক্ত হয়েছে।');
  return res.redirect('/admin/phase06#suppliers');
}));

router.post('/admin/phase06/purchases', requireCsrf, asyncRoute(async (req,res) => {
  const purchase = await repo.createPurchase(req.body, actor(req));
  if (wantsJson(req)) return res.status(201).json({ success:true, purchase });
  req.flash('success', req.locale === 'en' ? `Purchase order ${purchase.referenceNo} created as Draft; no stock received.` : `পারচেজ অর্ডার ${purchase.referenceNo} Draft হিসেবে তৈরি হয়েছে; স্টকে যোগ হয়নি।`);
  return res.redirect('/admin/phase06#purchases');
}));

router.post('/admin/phase06/purchases/:id/receive', requireCsrf, asyncRoute(async (req,res) => {
  const receipt = await repo.receivePurchase(req.params.id, req.body, actor(req));
  if (wantsJson(req)) return res.json({ success:true, receipt });
  req.flash('success', req.locale === 'en' ? `Receipt recorded (${receipt.totalQty} units).` : `রিসিপ্ট রেকর্ড হয়েছে (${receipt.totalQty} ইউনিট)।`);
  return res.redirect('/admin/phase06#purchases');
}));

router.get('/admin/phase06/inventory.json', asyncRoute(async (_req,res) => {
  const inventory = await repo.listInventory();
  res.json({ success:true, inventory });
}));

module.exports = router;
