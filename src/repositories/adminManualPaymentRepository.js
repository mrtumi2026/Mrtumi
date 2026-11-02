'use strict';

const mysql=require('../db/mysqlPool');
const {requirePositiveInt}=require('../utils/validator');
const {ConflictError,NotFoundError}=require('../utils/errors');

async function decideManualPayment(paymentIdInput,decisionInput,actor={}, {pool=null}={}){
  const paymentId=requirePositiveInt(paymentIdInput,'Payment ID');
  const decision=String(decisionInput||'').trim();
  if(!['approve','reject'].includes(decision))throw new ConflictError('Unsupported manual payment decision.');
  return mysql.withTransaction(async tx=>{
    const payment=await tx.queryOne(`SELECT op.id,op.order_id,op.gateway_code,op.provider_trx_id,op.sender_number,op.amount_paisa,op.status,
      o.invoice_no,o.total_paisa,o.payment_status,o.paid_paisa,o.order_status FROM order_payments op JOIN orders o ON o.id=op.order_id
      WHERE op.id=? AND op.gateway_code IN ('bkash','nagad','rocket','manual_bkash','manual_nagad','manual_rocket') FOR UPDATE`,[paymentId]);
    if(!payment)throw new NotFoundError('Manual payment record not found.');
    const target=decision==='approve'?'verified':'rejected';
    if(payment.status===target)return{id:paymentId,orderId:Number(payment.order_id),status:target,replayed:true};
    if(payment.status!=='pending_verification')throw new ConflictError('Only pending manual payments can be reviewed.');
    if(payment.payment_status!=='pending_verification'||['cancelled','failed'].includes(payment.order_status))throw new ConflictError('This order is no longer awaiting manual payment verification.');
    if(decision==='approve'){ 
      if(Number(payment.amount_paisa)!==Number(payment.total_paisa))throw new ConflictError('The submitted manual payment does not cover the full order total.');
      await tx.execute("UPDATE order_payments SET status='verified',verified_at=UTC_TIMESTAMP(),verified_by_user_id=? WHERE id=? AND status='pending_verification'",[actor.id||null,paymentId]);
      await tx.execute("UPDATE orders SET payment_status='paid',paid_paisa=?,cod_due_paisa=0 WHERE id=? AND payment_status='pending_verification'",[payment.amount_paisa,payment.order_id]);
    }else{
      await tx.execute("UPDATE order_payments SET status='rejected' WHERE id=? AND status='pending_verification'",[paymentId]);
      await tx.execute("UPDATE orders SET payment_status='rejected' WHERE id=? AND payment_status='pending_verification'",[payment.order_id]);
    }
    await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
      VALUES('admin',?,?,?,?,?,?,?,?)`,[actor.id||null,`admin.payment.${decision}`,'order_payment',String(paymentId),JSON.stringify({status:payment.status,orderId:Number(payment.order_id)}),JSON.stringify({status:target,orderId:Number(payment.order_id),gateway:payment.gateway_code,invoiceNo:payment.invoice_no}),String(actor.ip||'').slice(0,64),String(actor.userAgent||'').slice(0,255)]);
    return{id:paymentId,orderId:Number(payment.order_id),status:target,replayed:false};
  },{pool:pool||mysql.getPool()});
}

module.exports={decideManualPayment};
