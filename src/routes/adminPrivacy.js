'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');
const { requireCsrf } = require('../middleware/csrf');
const { asyncHandler } = require('../utils/asyncHandler');
const privacy = require('../repositories/privacyRepository');
const router = express.Router();
router.use('/admin/privacy', requireAdmin);
const actor = (req) => ({ id: req.adminUser?.id, type: 'admin', ip: req.ip || '', userAgent: req.get('user-agent') || '' });
const locale = (req) => req.locale === 'en';
async function currentPolicy(language){try{return await privacy.getCurrentPolicy(language);}catch(error){if(error.statusCode===404)return null;throw error;}}

router.get('/admin/privacy/policies', requirePermission('privacy.manage'), asyncHandler(async (req,res) => {
  const [policies,history,current]=await Promise.all([privacy.listPolicies(),privacy.listPolicyPublications(),currentPolicy(req.locale)]);
  return res.render('admin/privacy/policies',{policies,history,current,isEn:locale(req),draft:null});
}));
router.get('/admin/privacy/policies/new', requirePermission('privacy.manage'), (req,res)=>res.render('admin/privacy/policies',{policies:[],history:[],current:null,draft:null,isEn:locale(req)}));
router.get('/admin/privacy/policies/:id', requirePermission('privacy.manage'), asyncHandler(async(req,res)=>{
  const [draft,policies,history,current]=await Promise.all([privacy.getPolicyVersion(req.params.id),privacy.listPolicies(),privacy.listPolicyPublications(),currentPolicy(req.locale)]);
  return res.render('admin/privacy/policies',{draft,policies,history,current,isEn:locale(req)});
}));
router.post('/admin/privacy/policies', requirePermission('privacy.manage'), requireCsrf, asyncHandler(async(req,res)=>{
  const id=await privacy.createPolicy(req.body,actor(req));return res.redirect(`/admin/privacy/policies/${id}`);
}));
router.post('/admin/privacy/policies/:id', requirePermission('privacy.manage'), requireCsrf, asyncHandler(async(req,res)=>{
  await privacy.updatePolicyDraft(req.params.id,req.body,actor(req));return res.redirect(`/admin/privacy/policies/${req.params.id}`);
}));
router.post('/admin/privacy/policies/:id/review', requirePermission('privacy.manage'), requireCsrf, asyncHandler(async(req,res)=>{
  await privacy.reviewPolicy(req.params.id,req.body.legal_review_status,req.body.legal_review_note,actor(req));return res.redirect(`/admin/privacy/policies/${req.params.id}`);
}));
router.post('/admin/privacy/policies/:id/publish', requirePermission('privacy.manage'), requireCsrf, asyncHandler(async(req,res)=>{
  await privacy.publishPolicy(req.params.id,actor(req),req.body.note||'');return res.redirect('/admin/privacy/policies');
}));

router.get('/admin/privacy/consent', requirePermission('privacy.manage'), asyncHandler(async(req,res)=>res.render('admin/privacy/consent',{options:await privacy.listConsentOptions(),isEn:locale(req)})));
router.post('/admin/privacy/consent/:key', requirePermission('privacy.manage'), requireCsrf, asyncHandler(async(req,res)=>{
  await privacy.updateConsentOption(req.params.key,req.body,actor(req));return res.redirect('/admin/privacy/consent');
}));
router.get('/admin/privacy/retention', requirePermission('privacy.manage'), asyncHandler(async(req,res)=>res.render('admin/privacy/retention',{settings:await privacy.listRetentionSettings(),isEn:locale(req)})));
router.post('/admin/privacy/retention/:category', requirePermission('privacy.manage'), requireCsrf, asyncHandler(async(req,res)=>{
  await privacy.updateRetentionSetting(req.params.category,req.body,actor(req));return res.redirect('/admin/privacy/retention');
}));

router.get('/admin/privacy/requests', requirePermission('privacy.review'), asyncHandler(async(req,res)=>{
  const requests=await privacy.listAdminRequests({status:req.query.status||'',type:req.query.type||''});
  return res.render('admin/privacy/requests',{requests,status:req.query.status||'',type:req.query.type||'',isEn:locale(req)});
}));
router.get('/admin/privacy/requests/:id', requirePermission('privacy.review'), asyncHandler(async(req,res)=>{
  const request=await privacy.getAdminRequest(req.params.id);
  return res.render('admin/privacy/request-detail',{request,isEn:locale(req)});
}));
router.post('/admin/privacy/requests/:id/review', requirePermission('privacy.review'), requireCsrf, asyncHandler(async(req,res)=>{
  await privacy.reviewPrivacyRequest(req.params.id,req.body.decision,req.body.reason,actor(req));return res.redirect(`/admin/privacy/requests/${req.params.id}`);
}));
router.post('/admin/privacy/requests/:id/apply-correction', requirePermission('privacy.review'), requireCsrf, asyncHandler(async(req,res)=>{
  await privacy.applyCorrection(req.params.id,{name:req.body.name,email:req.body.email,phone:req.body.phone},req.body.reason,actor(req));return res.redirect(`/admin/privacy/requests/${req.params.id}`);
}));
router.post('/admin/privacy/requests/:id/anonymize', requirePermission('privacy.review'), requireCsrf, asyncHandler(async(req,res)=>{
  await privacy.anonymizeCustomer(req.params.id,req.body.reason,actor(req));return res.redirect(`/admin/privacy/requests/${req.params.id}`);
}));
module.exports=router;
