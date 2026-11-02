'use strict';

const settingsRepository=require('../repositories/settingsRepository');
const {env}=require('../config/env');
const {normalizeBdPhone}=require('../utils/validator');
const {ConflictError}=require('../utils/errors');
const ENDPOINT='https://bulksmsbd.net/api/smsapi';
const REQUEST_TIMEOUT_MS=8000;

function configuredBalance(value){const raw=String(value??'').trim();if(!raw)return null;const parsed=Number(raw);return Number.isFinite(parsed)?parsed:null;}
async function deliverVendorOtp({phone,code,settings,fetchImpl=globalThis.fetch,timeoutMs=REQUEST_TIMEOUT_MS,enabled=env.vendorOtpSmsEnabled}={}){
  if(enabled!==true)throw new ConflictError('SMS delivery is disabled until the gateway is verified by an administrator. Please contact support for manual phone-call verification.');
  const config=settings||await settingsRepository.getAllSettings();
  const apiKey=String(config.bulksms_api_key||'').trim(),senderId=String(config.bulksms_sender_id||'').trim();
  if(!apiKey||!senderId)throw new ConflictError('SMS delivery is not configured. Please contact support to request a manual phone-call verification.');
  const balance=configuredBalance(config.bulksms_balance);
  if(balance!==null&&balance<=0)throw new ConflictError('SMS gateway balance is zero. Please contact support to request a manual phone-call verification.');
  if(typeof fetchImpl!=='function')throw new ConflictError('SMS delivery is unavailable. Please contact support to request manual phone verification.');
  const mobile=normalizeBdPhone(phone,'vendor phone');
  if(!/^\d{6}$/.test(String(code||'')))throw new ConflictError('OTP delivery was refused because the verification code is invalid.');
  const message=`Mrtumi vendor verification code: ${code}. Valid for 5 minutes. Do not share this code.`;
  const body=new URLSearchParams({api_key:apiKey,type:'text',number:`88${mobile}`,senderid:senderId,message});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1000,Math.min(Number(timeoutMs)||REQUEST_TIMEOUT_MS,15000)));
  try{
    const response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:body.toString(),signal:controller.signal});
    if(!response||!response.ok)throw new Error('provider-http');
    const raw=String(await response.text()).slice(0,4096);let result;
    try{result=JSON.parse(raw);}catch(_){result=null;}
    const responseCode=Number(result?.response_code??result?.code);
    const success=responseCode===202||(!result&&/sms submitted successfully|successfully sent/i.test(raw));
    if(!success){
      const zeroBalance=responseCode===1005||/balance\s*(?:is\s*)?(?:zero|low|insufficient)/i.test(String(result?.message||result?.error||raw));
      throw new Error(zeroBalance?'provider-balance':'provider-rejected');
    }
    return{sent:true,provider:'bulksmsbd'};
  }catch(error){
    const timeout=error?.name==='AbortError';
    const message=timeout?'SMS delivery timed out. Please try again or contact support for a phone-call verification.':'SMS delivery failed. Please try again or contact support for a phone-call verification.';
    throw new ConflictError(message);
  }finally{clearTimeout(timer);}
}
module.exports={deliverVendorOtp,ENDPOINT,REQUEST_TIMEOUT_MS,configuredBalance};
