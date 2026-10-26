'use strict';

const express=require('express');
const crypto=require('crypto');
const {requireAdmin}=require('../middleware/auth');
const {requireCsrf}=require('../middleware/csrf');
const {requirePermission}=require('../middleware/rbac');
const {asyncHandler}=require('../utils/asyncHandler');
const repo=require('../repositories/phase08Repository');
const router=express.Router();
router.use('/admin/phase08',requireAdmin);
function actor(req){return{id:req.adminUser?.id||req.session?.adminUser?.id||null,ip:req.ip||'',userAgent:req.get('user-agent')||''};}
function isEn(req){return req.locale==='en';}
function wantsJson(req){return req.is('application/json')||String(req.headers.accept||'').includes('application/json')||req.xhr;}
function idempotencyId(){return crypto.randomUUID();}

router.get('/admin/phase08',requirePermission('orders.manage'),(_req,res)=>res.redirect('/admin/phase08/orders'));
router.get('/admin/phase08/orders',requirePermission('orders.manage'),asyncHandler(async(req,res)=>{
  const [data,history]=await Promise.all([repo.listOrders({search:req.query.q,status:req.query.status,page:req.query.page,limit:25}),req.query.id?repo.listOrderHistory(req.query.id):Promise.resolve([])]);
  res.render('admin/phase08-orders',{...data,history,transitions:repo.TRANSITIONS,isEn:isEn(req),query:String(req.query.q||''),status:String(req.query.status||''),csrfToken:req.csrfToken(),rows:data.rows.map(row=>({...row,requestKey:idempotencyId()}))});
}));
router.post('/admin/phase08/orders/:id/status',requirePermission('orders.manage'),requireCsrf,asyncHandler(async(req,res)=>{
  const result=await repo.transitionOrder(req.params.id,req.body.status,req.body.reason,actor(req),req.body.request_key||req.get('Idempotency-Key'));
  if(wantsJson(req))return res.json({success:true,...result});
  req.flash('success',isEn(req)?`Order status updated to ${result.to}.`:`অর্ডার স্ট্যাটাস ${result.to} করা হয়েছে।`);
  return res.redirect('/admin/phase08/orders');
}));
router.get('/admin/phase08/refunds',requirePermission('refunds.review'),asyncHandler(async(req,res)=>{
  const [data,history]=await Promise.all([repo.listRefunds({search:req.query.q,status:req.query.status,page:req.query.page,limit:25}),req.query.id?repo.listRefundHistory(req.query.id):Promise.resolve([])]);
  res.render('admin/phase08-refunds',{...data,history,isEn:isEn(req),query:String(req.query.q||''),status:String(req.query.status||''),csrfToken:req.csrfToken(),rows:data.rows.map(row=>({...row,decisionKey:idempotencyId()}))});
}));
router.post('/admin/phase08/refunds/:id/decision',requirePermission('refunds.review'),requireCsrf,asyncHandler(async(req,res)=>{
  const result=await repo.transitionRefund(req.params.id,req.body.status,req.body.reason,actor(req),req.body.request_key||req.get('Idempotency-Key'));
  if(wantsJson(req))return res.json({success:true,...result});
  req.flash('success',isEn(req)?`Refund request ${result.status}.`:`রিফান্ড অনুরোধ ${result.status} হয়েছে।`);
  return res.redirect('/admin/phase08/refunds');
}));
router.get('/admin/phase08/incomplete',requirePermission('checkout.recovery.view'),asyncHandler(async(req,res)=>{
  const data=await repo.listIncompleteCheckouts({search:req.query.q,status:req.query.status,page:req.query.page,limit:25});
  res.render('admin/phase08-incomplete',{...data,transitions:repo.INCOMPLETE_STATES,isEn:isEn(req),query:String(req.query.q||''),status:String(req.query.status||''),csrfToken:req.csrfToken(),rows:data.rows.map(row=>({...row,cartCount:(()=>{try{return JSON.parse(row.cart_json||'[]').length;}catch{return 0;}})()}))});
}));
router.post('/admin/phase08/incomplete/:id/status',requirePermission('checkout.recovery.manage'),requireCsrf,asyncHandler(async(req,res)=>{
  const result=await repo.transitionIncompleteCheckout(req.params.id,req.body.status,req.body.reason,actor(req),req.body.recovered_order_id||null);
  if(wantsJson(req))return res.json({success:true,...result});
  req.flash('success',isEn(req)?`Recovery record marked ${result.status}.`:`রিকভারি রেকর্ড ${result.status} হয়েছে।`);
  return res.redirect('/admin/phase08/incomplete');
}));
router.get('/admin/phase08/settings',requirePermission('settings.manage'),asyncHandler(async(req,res)=>res.render('admin/phase08-settings',{settings:await repo.getPhase08Settings(),isEn:isEn(req),csrfToken:req.csrfToken()})));
router.post('/admin/phase08/settings',requirePermission('settings.manage'),requireCsrf,asyncHandler(async(req,res)=>{
  await repo.savePhase08Settings(req.body,actor(req));
  if(wantsJson(req))return res.json({success:true});
  req.flash('success',isEn(req)?'Phase 08 policy settings saved. SMS delivery is not enabled by this setting.':'Phase 08 সেটিং সংরক্ষিত হয়েছে। এই সেটিং SMS পাঠায় না।');
  return res.redirect('/admin/phase08/settings');
}));
module.exports=router;
