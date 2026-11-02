'use strict';

const {env}=require('../config/env');
const mysql=require('../db/mysqlPool');
const sqliteDb=require('../db/database');
const {recordAuditLog}=require('./auditLogRepository');
const {requirePositiveInt}=require('../utils/validator');
const {ValidationError,NotFoundError}=require('../utils/errors');

function normalizeUpdate(input={}){
  const accountNumber=String(input.account_number??'').trim();
  const instructions=String(input.instructions??'').trim();
  const rawStatus=String(input.status??'');
  if(accountNumber.length>100||!/^[A-Za-z0-9+(). -]*$/.test(accountNumber))throw new ValidationError('Enter a valid receiving account number (maximum 100 characters).');
  if(instructions.length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions))throw new ValidationError('Instructions must not exceed 4000 characters or contain control characters.');
  if(!['0','1'].includes(rawStatus))throw new ValidationError('Choose Active or Inactive for gateway status.');
  return{accountNumber,instructions,status:Number(rawStatus)};
}
function accountAudit(value){const digits=String(value||'').replace(/\D/g,'');return{last4:digits.slice(-4),configured:Boolean(value)};}

async function listPaymentGateways({pool=null}={}){
  if(env.db.client==='mysql'||pool){
    return mysql.createQueryClient(pool||mysql.getPool()).queryAll('SELECT id,name,code,gateway_type,account_number,instructions,status,updated_at FROM payment_gateways ORDER BY CASE WHEN code=\'cod\' THEN 0 ELSE 1 END,id');
  }
  return sqliteDb.all('SELECT id,name,code,type AS gateway_type,account_number,instructions,status FROM payment_gateways ORDER BY CASE WHEN code=\'cod\' THEN 0 ELSE 1 END,id');
}

async function updatePaymentGateway(idInput,input={},actor={}, {pool=null}={}){
  const id=requirePositiveInt(idInput,'Gateway ID');
  const update=normalizeUpdate(input);
  if(env.db.client==='mysql'||pool){
    const activePool=pool||mysql.getPool();
    return mysql.withTransaction(async tx=>{
      const before=await tx.queryOne('SELECT id,name,code,gateway_type,account_number,instructions,status FROM payment_gateways WHERE id=? FOR UPDATE',[id]);
      if(!before)throw new NotFoundError('Payment gateway not found.');
      if(before.gateway_type==='manual'&&update.status===1&&(!update.accountNumber||!update.instructions))throw new ValidationError('Configure both the receiving account number and customer instructions before activating a manual MFS gateway.');
      await tx.execute('UPDATE payment_gateways SET account_number=?,instructions=?,status=? WHERE id=?',[update.accountNumber,update.instructions,update.status,id]);
      await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'payment_gateway.updated',entityType:'payment_gateway',entityId:id,
        beforeState:{code:before.code,account:accountAudit(before.account_number),instructionsLength:String(before.instructions||'').length,status:Number(before.status)},
        afterState:{code:before.code,account:accountAudit(update.accountNumber),instructionsLength:update.instructions.length,status:update.status},
        ipAddress:actor.ip||'',userAgent:actor.userAgent||''},tx);
      return{id,code:before.code,status:update.status};
    },{pool:activePool});
  }
  const before=sqliteDb.get('SELECT id,name,code,type AS gateway_type,account_number,instructions,status FROM payment_gateways WHERE id=?',id);
  if(!before)throw new NotFoundError('Payment gateway not found.');
  if(before.gateway_type==='manual'&&update.status===1&&(!update.accountNumber||!update.instructions))throw new ValidationError('Configure both the receiving account number and customer instructions before activating a manual MFS gateway.');
  sqliteDb.run('UPDATE payment_gateways SET account_number=?,instructions=?,status=? WHERE id=?',update.accountNumber,update.instructions,update.status,id);
  await recordAuditLog({actorType:'admin',actorId:actor.id||null,action:'payment_gateway.updated',entityType:'payment_gateway',entityId:id,
    beforeState:{code:before.code,account:accountAudit(before.account_number),instructionsLength:String(before.instructions||'').length,status:Number(before.status)},
    afterState:{code:before.code,account:accountAudit(update.accountNumber),instructionsLength:update.instructions.length,status:update.status},
    ipAddress:actor.ip||'',userAgent:actor.userAgent||''});
  return{id,code:before.code,status:update.status};
}

module.exports={listPaymentGateways,updatePaymentGateway,normalizeUpdate};
