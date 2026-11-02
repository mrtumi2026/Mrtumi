'use strict';

const express=require('express');
const upload=require('../middleware/upload');
const {requireCsrf}=require('../middleware/csrf');
const {requireVendor,requireAdmin}=require('../middleware/auth');
const {createRateLimiter}=require('../middleware/rateLimit');
const {env}=require('../config/env');
const {asyncHandler}=require('../utils/asyncHandler');
const {ConflictError,NotFoundError,ValidationError}=require('../utils/errors');
const onboarding=require('../repositories/vendorOnboardingRepository');
const documents=require('../utils/vendorDocuments');

const router=express.Router();
const mysqlActive=()=>env.db.client==='mysql';
const vendorOtpLimiter=createRateLimiter({keyPrefix:'vendor_otp',windowMs:60_000,max:4});
const vendorRegistrationLimiter=createRateLimiter({keyPrefix:'vendor_register',windowMs:15*60_000,max:8});
const applicationUpload=upload.fields([{name:'nid_front',maxCount:1},{name:'nid_back',maxCount:1},{name:'trade_license',maxCount:1},{name:'shop_logo',maxCount:1}]);
function allStaged(files){return documents.stagedUploads(files);}
async function persistDocumentSet(files,existing={}){
  const result={...existing},created=[];
  try{
    for(const name of ['nid_front','nid_back','trade_license','shop_logo']){
      const file=files&&files[name]&&files[name][0];
      if(file){result[name]=await documents.storeUploadedDocument(file);created.push(result[name]);}
    }
    return{result,created};
  }catch(error){documents.removeStaged(files);await documents.removePrivateDocuments(created);throw error;}
}
function vendorSession(req,vendor,callback){
  const keep={cart:Array.isArray(req.session.cart)?req.session.cart:[],locale:req.session.locale};
  req.session.regenerate(error=>{if(error)return callback(error);Object.assign(req.session,keep);req.session.vendorUser={id:Number(vendor.id),shop_name:vendor.shop_name,owner_name:vendor.owner_name,phone:vendor.phone,email:vendor.email};req.session.save(callback);});
}
function parseApplicationUpload(req,res,next){return applicationUpload(req,res,error=>{if(error){documents.removeStaged(req.files);return next(error);}return requireCsrf(req,res,csrfError=>{if(csrfError)documents.removeStaged(req.files);return next(csrfError);});});}
function flashAndRedirect(req,res,error,path='/vendor/onboarding'){
  if(error instanceof ConflictError||error instanceof ValidationError||error instanceof NotFoundError){req.flash('error',error.message);return res.redirect(path);}
  throw error;
}
function actor(req,type='admin'){return{type,id:req.adminUser?.id||req.session?.adminUser?.id||null,ip:req.ip||'',userAgent:req.get('user-agent')||''};}

// MySQL onboarding supersedes the legacy short registration form; SQLite keeps its fallback.
router.get('/vendor/register',asyncHandler(async(req,res,next)=>{
  if(!mysqlActive())return next();
  if(req.session?.vendorUser)return res.redirect('/vendor/onboarding');
  return res.render('vendor/onboarding-register',{application:null,error:null});
}));
router.post('/vendor/register',vendorRegistrationLimiter,parseApplicationUpload,asyncHandler(async(req,res,next)=>{
  if(!mysqlActive())return next();
  let saved={result:{},created:[]};
  try{
    const staged={};for(const field of ['nid_front','nid_back','trade_license','shop_logo'])staged[field]=req.files?.[field]?.[0]||null;
    saved=await persistDocumentSet(staged);
    const vendor=await onboarding.register(req.body,saved.result);
    return vendorSession(req,vendor,error=>{if(error)return next(error);req.flash('success','আবেদন জমা হয়েছে। OTP যাচাই সম্পন্ন না হওয়া পর্যন্ত অ্যাকাউন্ট সীমিত থাকবে।');return res.redirect('/vendor/verify-phone');});
  }catch(error){documents.removeStaged(req.files);await documents.removePrivateDocuments(saved.created);if(error instanceof ConflictError||error instanceof ValidationError)return res.status(400).render('vendor/onboarding-register',{application:null,error:error.message});return next(error);}
}));

router.get('/vendor/onboarding/resubmit',requireVendor,asyncHandler(async(req,res,next)=>{
  if(!mysqlActive())return res.redirect('/vendor/onboarding');
  try{const application=await onboarding.getVendorApplication(req.session.vendorUser.id);if(!['action_required','rejected'].includes(application.lifecycle_status)){req.flash('error','Resubmission is available only after requested changes or rejection.');return res.redirect('/vendor/onboarding');}return res.render('vendor/onboarding-register',{application,error:null,resubmission:true});}catch(error){return next(error);}
}));
router.post('/vendor/onboarding/resubmit',requireVendor,vendorRegistrationLimiter,parseApplicationUpload,asyncHandler(async(req,res,next)=>{
  if(!mysqlActive()){documents.removeStaged(req.files);return res.redirect('/vendor/onboarding');}
  let saved={result:{},created:[]},previous=null;
  try{
    previous=await onboarding.getVendorApplication(req.session.vendorUser.id);
    const staged={};for(const field of ['nid_front','nid_back','trade_license','shop_logo'])staged[field]=req.files?.[field]?.[0]||null;
    saved=await persistDocumentSet(staged,previous.documents);
    await onboarding.resubmitApplication(req.session.vendorUser.id,req.body,saved.result,{type:'vendor',id:req.session.vendorUser.id,ip:req.ip,userAgent:req.get('user-agent')});
    const replaced=Object.keys(previous.documents).filter(key=>saved.result[key]!==previous.documents[key]).map(key=>previous.documents[key]);await documents.removePrivateDocuments(replaced);
    req.flash('success','Updated application sent for review.');return res.redirect('/vendor/onboarding');
  }catch(error){documents.removeStaged(req.files);await documents.removePrivateDocuments(saved.created);if(error instanceof ConflictError||error instanceof ValidationError)return res.status(400).render('vendor/onboarding-register',{application:previous,error:error.message,resubmission:true});return next(error);}
}));

router.get('/vendor/verify-phone',requireVendor,asyncHandler(async(req,res,next)=>{
  if(!mysqlActive())return res.redirect('/vendor/dashboard');
  try{const app=await onboarding.getVendorApplication(req.session.vendorUser.id);if(app.phone_verified_at)return res.redirect('/vendor/onboarding');return res.render('vendor/onboarding-otp',{application:app});}catch(error){return next(error);}
}));
router.post('/vendor/verify-phone/request',requireVendor,vendorOtpLimiter,requireCsrf,asyncHandler(async(req,res)=>{
  if(!mysqlActive())return res.redirect('/vendor/dashboard');
  try{const issued=await onboarding.issuePhoneOtp(req.session.vendorUser.id,{deliver:req.app.locals.vendorOtpDelivery});req.flash('success',issued.verified?'মোবাইল নম্বর আগে থেকেই যাচাই করা হয়েছে।':'যাচাই কোড পাঠানো হয়েছে।');}catch(error){req.flash('error',error.message);}return res.redirect('/vendor/verify-phone');
}));
router.post('/vendor/verify-phone',requireVendor,vendorOtpLimiter,requireCsrf,asyncHandler(async(req,res)=>{
  if(!mysqlActive())return res.redirect('/vendor/dashboard');
  try{await onboarding.verifyPhoneOtp(req.session.vendorUser.id,req.body.code);req.flash('success','মোবাইল নম্বর যাচাই হয়েছে। পরবর্তী ধাপ সম্পন্ন করুন।');return res.redirect('/vendor/onboarding');}catch(error){return flashAndRedirect(req,res,error,'/vendor/verify-phone');}
}));

router.get('/vendor/onboarding',requireVendor,asyncHandler(async(req,res,next)=>{
  if(!mysqlActive())return res.redirect('/vendor/dashboard');
  try{const dashboard=await onboarding.getPortalDashboard(req.session.vendorUser.id);let application=null;try{application=await onboarding.getVendorApplication(req.session.vendorUser.id);}catch(error){if(error.code!=='NOT_FOUND')throw error;}return res.render('vendor/onboarding-dashboard',{...dashboard,application,history:await onboarding.getStatusHistory(req.session.vendorUser.id),payouts:dashboard.payouts||[]});}catch(error){if(error.code==='NOT_FOUND')return res.render('vendor/onboarding-dashboard',{vendor:{id:req.session.vendorUser.id,lifecycle_status:'pending'},application:null,history:[],counts:{totalProducts:0,approvedProducts:0,pendingProducts:0},orders:{totalOrders:0,grossSales:0},payouts:[]});return next(error);}
}));
router.post('/vendor/onboarding/complete',requireVendor,requireCsrf,asyncHandler(async(req,res)=>{
  try{await onboarding.completeOnboarding(req.session.vendorUser.id,req.body.terms_accepted==='1',{type:'vendor',id:req.session.vendorUser.id,ip:req.ip,userAgent:req.get('user-agent')});req.flash('success','Onboarding information saved. Activation remains subject to admin approval and all verification checks.');}catch(error){return flashAndRedirect(req,res,error);}
  return res.redirect('/vendor/onboarding');
}));
router.post('/vendor/onboarding/payout',requireVendor,requireCsrf,asyncHandler(async(req,res)=>{
  try{await onboarding.savePayoutAccount(req.session.vendorUser.id,req.body,{type:'vendor',id:req.session.vendorUser.id,ip:req.ip,userAgent:req.get('user-agent')});req.flash('success','Payout details submitted for verification. No payout was initiated.');}catch(error){return flashAndRedirect(req,res,error);}
  return res.redirect('/vendor/onboarding');
}));

// Admin application workbench. RBAC and global admin CSRF middleware cover all these routes.
router.get('/admin/vendor-applications',requireAdmin,asyncHandler(async(req,res,next)=>{
  if(!mysqlActive())return res.redirect('/admin/vendor-verifications');
  try{const result=await onboarding.listApplications(req.query.status||'pending',{page:req.query.page||1});return res.render('admin/vendor-applications',{...result,statuses:require('../repositories/vendorOnboardingPolicy').VENDOR_STATUSES});}catch(error){return next(error);}
}));
router.get('/admin/vendor-applications/:id',requireAdmin,asyncHandler(async(req,res,next)=>{
  if(!mysqlActive())return res.redirect('/admin/vendor-verifications');
  try{await onboarding.auditSensitiveAccess(req.params.id,'application and NID',{type:'admin',id:req.adminUser?.id||null,ip:req.ip,userAgent:req.get('user-agent')});const vendor=await onboarding.getVendorApplication(req.params.id,{admin:true});const [history,payouts]=await Promise.all([onboarding.getStatusHistory(vendor.id),onboarding.listPayoutDetailsForAdmin(vendor.id)]);return res.render('admin/vendor-application-detail',{vendor,history,payouts});}catch(error){return next(error);}
}));
router.get('/admin/vendor-applications/:id/documents/:kind',requireAdmin,asyncHandler(async(req,res,next)=>{
  try{const key=String(req.params.kind);if(!['nid_front','nid_back','trade_license','shop_logo'].includes(key))throw new NotFoundError('Document not found.');await onboarding.auditSensitiveAccess(req.params.id,`document:${key}`,{type:'admin',id:req.adminUser?.id||null,ip:req.ip,userAgent:req.get('user-agent')});const vendor=await onboarding.getVendorApplication(req.params.id);const stored=vendor.documents[key];if(!stored)throw new NotFoundError('Document not found.');const file=await documents.resolvePrivateDocument(stored);res.set({'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'});const ext=stored.split('.').pop().toLowerCase();res.type(({jpg:'jpeg',jpeg:'jpeg',png:'png',webp:'webp',gif:'gif'})[ext]||'application/octet-stream');return res.sendFile(file.path,{headers:{'Cache-Control':'private, no-store, max-age=0','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});}catch(error){return next(error);}
}));
router.post('/admin/vendor-applications/:id/status',requireAdmin,requireCsrf,asyncHandler(async(req,res)=>{
  const action=String(req.body.action||''),map={start_review:'under_review',request_info:'action_required',approve:'approved',reject:'rejected',suspend:'suspended',reactivate:'active',deactivate:'deactivated'};
  try{if(!map[action])throw new ValidationError('Choose a valid vendor status action.');await onboarding.transition(req.params.id,map[action],req.body.reason||'',actor(req),{confirmIdentity:req.body.confirm_identity==='1'});req.flash('success',`Vendor application moved to ${map[action]}.`);}catch(error){return flashAndRedirect(req,res,error,`/admin/vendor-applications/${encodeURIComponent(req.params.id)}`);}
  return res.redirect(`/admin/vendor-applications/${encodeURIComponent(req.params.id)}`);
}));
router.post('/admin/vendor-applications/:id/commission',requireAdmin,requireCsrf,asyncHandler(async(req,res)=>{
  try{const bps=Math.round(Number(req.body.commission_percent)*100);await onboarding.assignCommission(req.params.id,bps,req.body.trusted_auto_publish==='1',actor(req));req.flash('success','Vendor commission saved. Auto-publish setting updated.');}catch(error){return flashAndRedirect(req,res,error,`/admin/vendor-applications/${encodeURIComponent(req.params.id)}`);}
  return res.redirect(`/admin/vendor-applications/${encodeURIComponent(req.params.id)}`);
}));
router.post('/admin/vendor-payout-accounts/:id/decision',requireAdmin,requireCsrf,asyncHandler(async(req,res)=>{
  try{const result=await onboarding.verifyPayoutAccount(req.params.id,req.body.status,req.body.reason||'',actor(req));req.flash('success',`Payout verification ${result.status}.`);return res.redirect(`/admin/vendor-applications/${result.vendorId}`);}catch(error){return flashAndRedirect(req,res,error,'/admin/vendor-applications');}
}));

module.exports=router;
