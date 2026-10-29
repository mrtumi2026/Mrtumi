'use strict';

const crypto = require('crypto');
const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const repo = require('../repositories/phase06Repository');
const upload = require('../middleware/upload');
const csvRepo = require('../repositories/phase06ProductCsvRepository');
const { recordAuditLog } = require('../repositories/auditLogRepository');
const { ConflictError, ValidationError } = require('../utils/errors');
const router = express.Router();
router.use('/admin/phase06', requireAdmin);

function actor(req) {
  return { id: req.adminUser?.id || req.session?.adminUser?.id || null, ip: req.ip || '', userAgent: req.get('user-agent') || '' };
}
function wantsJson(req) { return req.accepts(['html','json']) === 'json' || req.is('application/json'); }
function asyncRoute(fn) { return (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next); }
function parseGalleryMultipart(req,res,next){
  upload.array('gallery_images',6)(req,res,(err)=>{
    if(!err)return next();
    if(err.name==='MulterError'){
      const message=err.code==='LIMIT_FILE_SIZE'?'Each gallery image must be within the configured upload size limit.':'Upload no more than 6 gallery images in one request.';
      return next(new ValidationError(message));
    }
    return next(err);
  });
}
function verifyGalleryUploadCsrf(req,res,next){
  requireCsrf(req,res,(err)=>{
    if(err){for(const file of req.files||[])upload.safeUnlink(file.path);return next(err);}
    return next();
  });
}

const CSV_PREVIEW_TTL_MS = 15 * 60 * 1000;
function sha256(value) { return crypto.createHash('sha256').update(String(value),'utf8').digest('hex'); }
function matchingDigest(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const actualDigest=Buffer.from(sha256(actual),'hex');
  const expectedDigest=Buffer.from(expected,'hex');
  return crypto.timingSafeEqual(actualDigest,expectedDigest);
}
function renderCsvPreview(req,res,preview,csvText,previewId,status=200) {
  return res.status(status).render('admin/phase06-product-import-preview',{
    preview,csvText,previewId,csrfToken:req.csrfToken(),locale:req.locale,
    pageTitle:req.locale==='en'?'Product CSV Import Preview':'পণ্য CSV আমদানি প্রিভিউ',
  });
}

router.get('/admin/phase06', asyncRoute(async (req,res) => {
  const [products, inventory, suppliers, purchases, ledger, taxonomy] = await Promise.all([
    repo.listProducts(), repo.listInventory(), repo.listSuppliers(), repo.listPurchases(), repo.listStockLedger(req.query.product_id || null), repo.listProductEditOptions(),
  ]);
  res.render('admin/phase06', { products, inventory, suppliers, purchases, ledger, categories:taxonomy.categories, brands:taxonomy.brands,
    pageTitle: req.locale === 'en' ? 'Products, Inventory & Purchasing' : 'পণ্য, ইনভেন্টরি ও পারচেজ', csrfToken: req.csrfToken() });
}));

router.get('/admin/phase06/products/export.csv', asyncRoute(async (req,res) => {
  const exported=await csvRepo.exportProductsCsv();
  await recordAuditLog({actorType:'admin',actorId:actor(req).id,action:'product.csv.export',entityType:'product_csv_export',
    afterState:{rowCount:exported.rowCount,format:'csv'},ipAddress:actor(req).ip,userAgent:actor(req).userAgent});
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="products.csv"');
  return res.send(exported.csv);
}));

router.post('/admin/phase06/products/import/preview', requireCsrf, asyncRoute(async (req,res) => {
  const csvText=req.body?.csv_text;
  if(typeof csvText!=='string')throw new ValidationError('CSV text is required.');
  delete req.session.phase06ProductCsvPreview;
  const preview=await csvRepo.previewProductCsv(csvText);
  let previewId=null;
  if(preview.valid){
    previewId=crypto.randomBytes(32).toString('hex');
    req.session.phase06ProductCsvPreview={tokenHash:sha256(previewId),csvHash:sha256(csvText),createdAt:Date.now(),totalRows:preview.totalRows};
  }
  res.setHeader('Cache-Control','no-store');
  if(wantsJson(req))return res.json({success:preview.valid,previewId,preview});
  return renderCsvPreview(req,res,preview,csvText,previewId);
}));

router.post('/admin/phase06/products/import/commit', requireCsrf, asyncRoute(async (req,res) => {
  const csvText=req.body?.csv_text;
  if(typeof csvText!=='string')throw new ValidationError('CSV text is required.');
  const state=req.session.phase06ProductCsvPreview;
  if(!state||Date.now()-Number(state.createdAt)>CSV_PREVIEW_TTL_MS||!matchingDigest(String(req.body.preview_id||''),state.tokenHash)||!matchingDigest(csvText,state.csvHash)){
    delete req.session.phase06ProductCsvPreview;
    throw new ConflictError('This CSV preview is missing, expired, or does not match the submitted CSV. Preview and validate again.');
  }
  const result=await csvRepo.commitProductCsv(csvText,actor(req));
  res.setHeader('Cache-Control','no-store');
  if(!result.committed){
    delete req.session.phase06ProductCsvPreview;
    const preview={valid:false,totalRows:result.totalRows,errors:result.errors,rows:[]};
    if(wantsJson(req))return res.status(409).json({success:false,committed:false,preview});
    return renderCsvPreview(req,res,preview,csvText,null,409);
  }
  delete req.session.phase06ProductCsvPreview;
  if(wantsJson(req))return res.json({success:true,...result});
  req.flash('success',req.locale==='en'?`${result.updatedCount} product row(s) committed. Stock, variants, barcode, media and product state were preserved.`:`${result.updatedCount}টি পণ্যের সারি সংরক্ষিত হয়েছে। স্টক, ভ্যারিয়েন্ট, বারকোড, মিডিয়া ও পণ্যের অবস্থা অপরিবর্তিত আছে।`);
  return res.redirect('/admin/phase06#product-csv');
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

router.post('/admin/phase06/products/:id/gallery/upload',parseGalleryMultipart,verifyGalleryUploadCsrf,asyncRoute(async(req,res)=>{
  const files=req.files||[];
  let gallery;
  try{
    if(!files.length)throw new ValidationError('Choose at least one gallery image to upload.');
    const paths=files.map((file)=>upload.validateUploadedImageFile(file));
    gallery=await repo.appendProductGalleryImages(req.params.id,paths,actor(req));
  }catch(err){for(const file of files)upload.safeUnlink(file.path);throw err;}
  if(wantsJson(req))return res.json({success:true,gallery});
  req.flash('success',req.locale==='en'?`${gallery.addedPaths.length} gallery image(s) uploaded and assigned. Existing files were not deleted.`:`${gallery.addedPaths.length}টি গ্যালারি ছবি আপলোড ও যুক্ত হয়েছে। পুরোনো ফাইল মুছে ফেলা হয়নি।`);
  return res.redirect(`/admin/phase06/products/${gallery.productId}/edit#gallery`);
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

router.post('/admin/phase06/products/:id/variants/:variantId/stock', requireCsrf, asyncRoute(async (req,res) => {
  const movement=await repo.adjustVariantStock(req.params.id,req.params.variantId,req.body,actor(req));
  if(wantsJson(req))return res.json({success:true,movement});
  req.flash('success',req.locale==='en'?`Variant stock updated: ${movement.previousBalance} → ${movement.balanceAfter}.`:`ভ্যারিয়েন্ট স্টক সমন্বয় হয়েছে: ${movement.previousBalance} → ${movement.balanceAfter}।`);
  return res.redirect(`/admin/phase06/products/${movement.productId}/edit#variants`);
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

router.get('/admin/phase06/suppliers/:id/purchases', asyncRoute(async (req,res) => {
  const history=await repo.getSupplierPurchaseHistory(req.params.id,req.query.page||1);
  res.setHeader('Cache-Control','no-store');
  if(wantsJson(req))return res.json({success:true,...history});
  for(const purchase of history.purchases)purchase.receiptFormKey=crypto.randomBytes(24).toString('hex');
  return res.render('admin/phase06-supplier-purchases',{...history,csrfToken:req.csrfToken(),locale:req.locale,
    pageTitle:req.locale==='en'?`Purchase history — ${history.supplier.name}`:`ক্রয় ইতিহাস — ${history.supplier.name}`});
}));

router.get('/admin/phase06/suppliers/:id/edit', asyncRoute(async (req,res) => {
  const supplier=await repo.getSupplierForEdit(req.params.id);
  if(wantsJson(req))return res.json({success:true,supplier});
  return res.render('admin/phase06-supplier-edit',{supplier,csrfToken:req.csrfToken(),locale:req.locale,
    pageTitle:req.locale==='en'?`Edit supplier ${supplier.name}`:`সরবরাহকারী সম্পাদনা: ${supplier.name}`});
}));

router.post('/admin/phase06/suppliers/:id', requireCsrf, asyncRoute(async (req,res) => {
  const supplier=await repo.updateSupplier(req.params.id,req.body,actor(req));
  if(wantsJson(req))return res.json({success:true,supplier});
  req.flash('success',req.locale==='en'?'Supplier details and active status saved. Purchase history and balances were preserved.':'সরবরাহকারীর তথ্য ও সক্রিয় অবস্থা সংরক্ষিত। ক্রয় ইতিহাস ও ব্যালেন্স অপরিবর্তিত।');
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
  const requestedPage=String(req.body.history_page||'1');
  const historyPage=/^[1-9]\d{0,5}$/.test(requestedPage)?Number(requestedPage):1;
  return res.redirect(`/admin/phase06/suppliers/${receipt.supplierId}/purchases?page=${historyPage}`);
}));

router.get('/admin/phase06/inventory.json', asyncRoute(async (_req,res) => {
  const inventory = await repo.listInventory();
  res.json({ success:true, inventory });
}));

module.exports = router;
