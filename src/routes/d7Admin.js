'use strict';
const express=require('express');
const {requireAdmin}=require('../middleware/auth');
const {requirePermission,hasPermission}=require('../middleware/rbac');
const {AuthorizationError}=require('../utils/errors');
const {requireCsrf}=require('../middleware/csrf');
const {asyncHandler}=require('../utils/asyncHandler');
const d7=require('../repositories/d7Repository');
const mysql=require('../db/mysqlPool');
const router=express.Router();
router.use('/admin/d7',requireAdmin);
const actor=req=>({id:req.adminUser?.id||req.session?.adminUser?.id||null,ip:req.ip||'',userAgent:req.get('user-agent')||''});
const isEn=req=>req.locale==='en';
function requireSettlementAccess(req,_res,next){const user=req.adminUser||req.session?.adminUser;if(hasPermission(user,'settlements.prepare')||hasPermission(user,'settlements.approve'))return next();return next(new AuthorizationError());}
router.get('/admin/d7/returns',requirePermission('returns.review'),asyncHandler(async(req,res)=>{const rows=await d7.listReturns(String(req.query.status||''));for(const row of rows)row.items=await d7.listReturnItems(row.id);res.render('admin/d7-returns',{rows,status:String(req.query.status||''),isEn:isEn(req),csrfToken:req.csrfToken()});}));
router.post('/admin/d7/returns/:id/decision',requirePermission('returns.review'),requireCsrf,asyncHandler(async(req,res)=>{await d7.decideReturn(req.params.id,req.body.status,req.body.note,actor(req));req.flash('success','Return decision recorded.');res.redirect('/admin/d7/returns');}));
router.post('/admin/d7/returns/:id/items/:itemId/inspect',requirePermission('returns.review'),requireCsrf,asyncHandler(async(req,res)=>{await d7.inspectReturnItem(req.params.id,req.params.itemId,req.body.disposition,actor(req));req.flash('success','Inspection and disposition recorded.');res.redirect('/admin/d7/returns');}));
router.get('/admin/d7/settings',requirePermission('settings.manage'),asyncHandler(async(req,res)=>{
  const db=mysql.createQueryClient(mysql.getPool());const [settings,categories,vendors]=await Promise.all([d7.getSettings(),d7.listCategoryPolicies(),db.queryAll('SELECT id,shop_name,commission_rate_bps FROM vendors WHERE status=1 ORDER BY shop_name')]);
  res.render('admin/d7-settings',{settings,categories,vendors,isEn:isEn(req),csrfToken:req.csrfToken()});
}));
router.post('/admin/d7/settings',requirePermission('settings.manage'),requireCsrf,asyncHandler(async(req,res)=>{await d7.saveSettings(req.body,actor(req));req.flash('success','D7 policy configuration saved. Refund execution remains disabled without a supported provider.');res.redirect('/admin/d7/settings');}));
router.post('/admin/d7/settings/categories/:id',requirePermission('settings.manage'),requireCsrf,asyncHandler(async(req,res)=>{await d7.saveCategoryPolicy(req.params.id,req.body.eligible,req.body.window_days,actor(req));res.redirect('/admin/d7/settings');}));
router.post('/admin/d7/settings/vendors/:id/commission',requirePermission('settings.manage'),requireCsrf,asyncHandler(async(req,res)=>{
  const rate=d7.validateCommissionBps(req.body.commission_rate_bps);const db=mysql.createQueryClient(mysql.getPool());
  await mysql.withTransaction(async tx=>{const vendor=await tx.queryOne('SELECT id,commission_rate_bps FROM vendors WHERE id=? FOR UPDATE',[req.params.id]);if(!vendor)throw Object.assign(new Error('Vendor not found.'),{status:404});await tx.execute('UPDATE vendors SET commission_rate_bps=? WHERE id=?',[rate,vendor.id]);await tx.execute('INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES(?,?,?,?,?,?,?,?,?)',['admin',actor(req).id,'vendor.commission.updated','vendor',String(vendor.id),JSON.stringify({commissionRateBps:Number(vendor.commission_rate_bps)}),JSON.stringify({commissionRateBps:rate}),actor(req).ip,actor(req).userAgent]);});
  res.redirect('/admin/d7/settings');
}));
router.get('/admin/d7/settlements',requireSettlementAccess,asyncHandler(async(req,res)=>{const db=mysql.createQueryClient(mysql.getPool());const [rows,vendors,adjustments]=await Promise.all([d7.listSettlements(),db.queryAll('SELECT id,shop_name FROM vendors WHERE status=1 ORDER BY shop_name'),d7.listAdjustments()]);res.render('admin/d7-settlements',{rows,vendors,adjustments,isEn:isEn(req),csrfToken:req.csrfToken(),canPrepare:hasPermission(req.adminUser,'settlements.prepare'),canApprove:hasPermission(req.adminUser,'settlements.approve')});}));
router.post('/admin/d7/settlements/prepare',requirePermission('settlements.prepare'),requireCsrf,asyncHandler(async(req,res)=>{await d7.prepareSettlement(req.body.vendor_id,req.body.period_start,req.body.period_end,actor(req));req.flash('success','Settlement snapshot prepared.');res.redirect('/admin/d7/settlements');}));
router.post('/admin/d7/settlements/adjustments',requirePermission('settlements.prepare'),requireCsrf,asyncHandler(async(req,res)=>{await d7.createAdjustment(req.body.vendor_id,req.body,actor(req));req.flash('success','Adjustment submitted pending independent approval.');res.redirect('/admin/d7/settlements');}));
router.post('/admin/d7/settlements/adjustments/:id/decision',requirePermission('settlements.approve'),requireCsrf,asyncHandler(async(req,res)=>{await d7.decideAdjustment(req.params.id,req.body.status,req.body.note,actor(req));req.flash('success','Adjustment decision recorded.');res.redirect('/admin/d7/settlements');}));
router.post('/admin/d7/settlements/:id/approve',requirePermission('settlements.approve'),requireCsrf,asyncHandler(async(req,res)=>{await d7.approveSettlement(req.params.id,actor(req));req.flash('success','Settlement approved; no payout was sent.');res.redirect('/admin/d7/settlements');}));
module.exports=router;
