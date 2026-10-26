'use strict';

const { recordAuditLog } = require('../repositories/auditLogRepository');
const logger = require('../utils/logger');
const SAFE_METHODS = new Set(['GET','HEAD','OPTIONS']);

/**
 * Append a minimized request-level event for successful legacy admin mutations that do not yet
 * have domain-specific audit records. Existing Phase 06/08/09 and dashboard writers remain the
 * authoritative detailed events and are excluded to avoid duplicates.
 */
function createLegacyAdminAudit({writer=recordAuditLog,loggerInstance=logger}={}) {
  return function legacyAdminAudit(req,res,next) {
  const policy=req.adminRoutePolicy;
  const exportRead=Boolean(req.adminUser&&policy&&policy.auditRead&&req.method==='GET'&&req.query&&req.query.export==='csv');
  const mutation=Boolean(req.adminUser&&policy&&policy.audit&&!SAFE_METHODS.has(req.method));
  if(!exportRead&&!mutation)return next();
  let completed=false;
  const originalEnd=res.end;
  res.end=function(...args) {
    if(completed||res.statusCode>=400)return originalEnd.apply(this,args);
    completed=true;
    const endResponse=()=>originalEnd.apply(res,args);
    const event={
      actorType:'admin', actorId:req.adminUser.id,
      action:exportRead?'admin.legacy.reports.export':`admin.legacy.${policy.key}.mutation`,
      entityType:exportRead?'admin_report':'admin_route', entityId:`${req.method} ${req.path}`,
      afterState:{method:req.method,path:req.path,permission:policy.key,status:Number(res.statusCode||200),...(exportRead?{format:'csv'}:{})},
      ipAddress:req.ip,userAgent:req.get('user-agent')||''
    };
    Promise.resolve().then(()=>writer(event)).then(endResponse).catch((err)=>{
      loggerInstance.error('Legacy admin audit write failed',{code:err&&err.code||'AUDIT_WRITE_FAILED',requestId:req.id||''});
      if(res.headersSent){res.destroy();return res;}
      res.statusCode=503;
      res.removeHeader('Location');res.removeHeader('Content-Length');
      if(typeof req.accepts==='function'&&req.accepts('json')){
        res.setHeader('Content-Type','application/json; charset=utf-8');
        return originalEnd.call(res,JSON.stringify({success:false,error:'AUDIT_UNAVAILABLE',message:'The action may have been applied, but its audit event could not be recorded. Verify current state before retrying.'}));
      }
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      return originalEnd.call(res,'The action may have been applied, but its audit event could not be recorded. Verify current state before retrying.');
    });
    return res;
  };
  return next();
  };
}

const legacyAdminAudit=createLegacyAdminAudit();
module.exports={legacyAdminAudit,createLegacyAdminAudit};
