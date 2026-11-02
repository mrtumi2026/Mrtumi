'use strict';

const crypto=require('node:crypto');
const {ValidationError}=require('./errors');
const {env}=require('../config/env');

function encryptionKey(){
  const raw=String(process.env.VENDOR_PII_KEY||'').trim();
  if(!raw){
    const secret=String(env.sessionSecret||process.env.SESSION_SECRET||'');
    if(Buffer.byteLength(secret,'utf8')<32)throw new ValidationError('Vendor PII encryption key is unavailable. Set VENDOR_PII_KEY or a stable SESSION_SECRET before vendor onboarding.');
    return Buffer.from(crypto.hkdfSync('sha256',Buffer.from(secret,'utf8'),Buffer.from('mrtumi-vendor-pii-v1'),Buffer.from('vendor-private-data'),32));
  }
  let key;
  if(/^[a-f0-9]{64}$/i.test(raw))key=Buffer.from(raw,'hex');
  else {try{key=Buffer.from(raw,'base64');}catch(_){key=Buffer.alloc(0);}}
  if(!key||key.length!==32)throw new ValidationError('Vendor identity/payout encryption key must decode to exactly 32 bytes.');
  return key;
}
function encryptVendorPii(value){
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}
function decryptVendorPii(value){
  const parts=String(value||'').split(':');
  if(parts.length!==4||parts[0]!=='v1')throw new ValidationError('Stored vendor private data cannot be decrypted.');
  try{const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(parts[1],'base64'));decipher.setAuthTag(Buffer.from(parts[2],'base64'));return Buffer.concat([decipher.update(Buffer.from(parts[3],'base64')),decipher.final()]).toString('utf8');}
  catch(_){throw new ValidationError('Vendor private data key is unavailable or has changed.');}
}
function hashVendorPii(value){return crypto.createHmac('sha256',encryptionKey()).update(String(value).trim().toUpperCase()).digest('hex');}
function maskAccount(value){const digits=String(value||'').replace(/\s/g,'');return digits.length<=4?'•'.repeat(digits.length):`${'•'.repeat(Math.min(8,digits.length-4))}${digits.slice(-4)}`;}
module.exports={encryptVendorPii,decryptVendorPii,hashVendorPii,maskAccount};
