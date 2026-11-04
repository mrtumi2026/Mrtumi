'use strict';
const express=require('express');
const {requireAdmin}=require('../middleware/auth');
const {requirePermission}=require('../middleware/rbac');
const {requireCsrf}=require('../middleware/csrf');
const {asyncHandler}=require('../utils/asyncHandler');
const {ValidationError}=require('../utils/errors');
const repo=require('../repositories/adminTestDataRepository');
const router=express.Router();router.use('/admin',requireAdmin);
const actor=req=>({id:req.adminUser?.id,ip:req.ip,userAgent:req.get('user-agent')||''});
router.get('/admin/test-data',requirePermission('test_data.manage'),asyncHandler(async(req,res)=>{
  const groups=await repo.listGroups({q:req.query.q,status:req.query.status});
  return res.render('admin/test-data',{groups,query:String(req.query.q||''),status:String(req.query.status||''),locale:res.locals.locale||'en'});
}));
router.post('/admin/test-data/groups',requirePermission('test_data.manage'),requireCsrf,asyncHandler(async(req,res)=>{
  const id=await repo.createGroup(req.body,actor(req));res.redirect(`/admin/test-data/groups/${id}`);
}));
router.get('/admin/test-data/groups/:id',requirePermission('test_data.manage'),asyncHandler(async(req,res)=>{
  const detail=await repo.groupDetail(req.params.id);const types=Object.keys(repo.ENTITY_TABLE);const searchType=types.includes(req.query.type)?req.query.type:'customers';
  const candidates=String(req.query.q||'').trim()?await repo.searchUnmarked(searchType,req.query.q):[];
  const cleanupResult=req.session.testDataCleanupResult||null;delete req.session.testDataCleanupResult;
  return res.render('admin/test-data-group',{...detail,candidates,searchType,search:String(req.query.q||''),types,cleanupResult,locale:res.locals.locale||'en'});
}));
router.post('/admin/test-data/groups/:id/mark',requirePermission('test_data.manage'),requireCsrf,asyncHandler(async(req,res)=>{
  await repo.markEntity(req.params.id,req.body.entity_type,req.body.entity_id,actor(req));res.redirect(`/admin/test-data/groups/${req.params.id}`);
}));
router.post('/admin/test-data/groups/:id/cleanup',requirePermission('test_data.manage'),requireCsrf,asyncHandler(async(req,res)=>{
  const {group}=await repo.groupDetail(req.params.id);
  if(String(req.body.confirmation||'').trim()!==`CLEAN ${group.group_key}`)throw new ValidationError('Type the exact cleanup confirmation shown in the preview.');
  const result=await repo.cleanupGroup(req.params.id,actor(req));req.session.testDataCleanupResult={status:result.status,deleted:result.deleted,blockers:result.blockers};res.redirect(`/admin/test-data/groups/${req.params.id}`);
}));
module.exports=router;
