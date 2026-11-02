'use strict';

const {ValidationError,ConflictError}=require('../utils/errors');
const VENDOR_STATUSES=Object.freeze(['pending','under_review','action_required','approved','active','rejected','suspended','deactivated']);
const TRANSITIONS=Object.freeze({
  pending:['under_review','action_required','approved','rejected','deactivated'],
  under_review:['action_required','approved','rejected','deactivated'],
  action_required:['under_review','approved','rejected','deactivated'],
  approved:['active','suspended','deactivated','action_required'],
  active:['suspended','deactivated'],
  rejected:['pending','under_review','deactivated'],
  suspended:['active','deactivated'],
  deactivated:['pending'],
});
function nextStatus(from,to){
  const old=String(from||''),next=String(to||'');
  if(!VENDOR_STATUSES.includes(next))throw new ValidationError('Unsupported vendor status.');
  if(!TRANSITIONS[old]?.includes(next))throw new ConflictError(`Vendor status cannot move from ${old} to ${next}.`);
  return next;
}
function activationRequirements(vendor){
  return{
    approved:vendor.lifecycle_status==='approved'||vendor.lifecycle_status==='active'||vendor.lifecycle_status==='suspended',
    phoneVerified:Boolean(vendor.phone_verified_at),
    identityVerified:Boolean(vendor.identity_verified_at),
    onboardingComplete:Boolean(vendor.onboarding_completed_at),
    commissionAssigned:Boolean(vendor.commission_configured_at)&&Number(vendor.commission_rate_bps)>0,
    payoutVerified:Boolean(vendor.payout_verified_at),
  };
}
function assertActivationRequirements(vendor){
  const requirements=activationRequirements(vendor);
  const missing=Object.entries(requirements).filter(([,done])=>!done).map(([name])=>name);
  if(missing.length)throw new ConflictError(`Vendor activation requirements are incomplete: ${missing.join(', ')}.`,{missing});
  return requirements;
}
function mayPublish(vendor){return vendor.lifecycle_status==='active'&&Number(vendor.status)===1;}
function mayWithdraw(vendor){return mayPublish(vendor)&&Boolean(vendor.payout_verified_at);}
module.exports={VENDOR_STATUSES,TRANSITIONS,nextStatus,activationRequirements,assertActivationRequirements,mayPublish,mayWithdraw};
