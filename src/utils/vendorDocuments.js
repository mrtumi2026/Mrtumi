'use strict';

const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');
const {env}=require('../config/env');
const upload=require('../middleware/upload');
const {ValidationError}=require('./errors');
const MAX_DOCUMENT_BYTES=5*1024*1024;
const INVALID_DOCUMENT_MESSAGE='ফাইলটি বৈধ JPG, PNG, WebP, GIF অথবা PDF ডকুমেন্ট নয়।';
const OVERSIZE_DOCUMENT_MESSAGE='প্রতিটি ডকুমেন্টের আকার সর্বোচ্চ ৫ মেগাবাইট হতে পারবে।';

function privateRoot(){
  const configured=env.vendorDocumentDir?path.resolve(env.vendorDocumentDir):(env.uploadDir?path.join(path.resolve(env.uploadDir),'vendor-private'):'');
  if(env.isProduction){
    if(!configured)throw new ValidationError('ব্যক্তিগত ভেন্ডর ডকুমেন্ট সংরক্ষণ ব্যবস্থা কনফিগার করা নেই।');
    const publicRoot=path.resolve(__dirname,'../../public');
    if(configured===publicRoot||configured.startsWith(publicRoot+path.sep))throw new ValidationError('ব্যক্তিগত ভেন্ডর ডকুমেন্ট public web root-এর বাইরে রাখতে হবে।');
    return configured;
  }
  return path.join(__dirname,'../../data/vendor-private-documents');
}
function privateStagingRoot(){return path.join(path.resolve(privateRoot()),'.staging');}
async function assertOutsidePublic(root){
  if(!env.isProduction)return;
  const publicRoot=await fsp.realpath(path.resolve(__dirname,'../../public'));
  const realRoot=await fsp.realpath(root);
  if(realRoot===publicRoot||realRoot.startsWith(publicRoot+path.sep))throw new ValidationError('ব্যক্তিগত ভেন্ডর ডকুমেন্ট public web root-এর বাইরে রাখতে হবে।');
}
async function ensurePrivateStagingRoot(){
  const root=privateStagingRoot();await fsp.mkdir(root,{recursive:true,mode:0o700});await assertOutsidePublic(root);await fsp.chmod(root,0o700);return root;
}
async function detectedDocumentExtension(filePath){
  const handle=await fsp.open(filePath,'r');
  try{
    const bytes=Buffer.alloc(12),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead>=2&&bytes[0]===0xff&&bytes[1]===0xd8)return'.jpg';
    if(bytesRead>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47&&bytes[4]===0x0d&&bytes[5]===0x0a&&bytes[6]===0x1a&&bytes[7]===0x0a)return'.png';
    if(bytesRead>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return'.webp';
    if(bytesRead>=4&&bytes.toString('ascii',0,4)==='GIF8')return'.gif';
    if(bytesRead>=5&&bytes.toString('ascii',0,5)==='%PDF-'){const stat=await handle.stat();if(stat.size<12)return'';const tail=Buffer.alloc(Math.min(1024,stat.size));await handle.read(tail,0,tail.length,stat.size-tail.length);if(tail.includes(Buffer.from('%%EOF')))return'.pdf';}
    return'';
  }finally{await handle.close();}
}
function extensionMatches(original,actual){
  const ext=path.extname(String(original||'')).toLowerCase();
  return actual==='.jpg'?['.jpg','.jpeg'].includes(ext):ext===actual;
}
async function storeUploadedDocument(file){
  if(!file||!file.path)throw new ValidationError('প্রয়োজনীয় ডকুমেন্টটি আপলোড করুন।');
  const stagedStat=await fsp.stat(file.path).catch(()=>null);
  if(!stagedStat||!stagedStat.isFile()){upload.safeUnlink(file.path);throw new ValidationError(INVALID_DOCUMENT_MESSAGE);}
  if(stagedStat.size>MAX_DOCUMENT_BYTES){upload.safeUnlink(file.path);throw new ValidationError(OVERSIZE_DOCUMENT_MESSAGE);}
  let ext='';
  try{ext=await detectedDocumentExtension(file.path);}catch(_){ext='';}
  if(!ext||!extensionMatches(file.originalname,ext)){
    upload.safeUnlink(file.path);throw new ValidationError(INVALID_DOCUMENT_MESSAGE,{field:file.fieldname||'document',code:'INVALID_DOCUMENT_SIGNATURE'});
  }
  const root=path.resolve(privateRoot());await fsp.mkdir(root,{recursive:true,mode:0o700});await assertOutsidePublic(root);await fsp.chmod(root,0o700);
  const name=`vendor-doc-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
  const target=path.resolve(root,name);
  if(path.dirname(target)!==root){upload.safeUnlink(file.path);throw new ValidationError('অবৈধ ডকুমেন্ট পাথ।');}
  try{await fsp.copyFile(file.path,target,fs.constants.COPYFILE_EXCL);await fsp.chmod(target,0o600);}
  finally{upload.safeUnlink(file.path);}
  return name;
}
async function resolvePrivateDocument(name){
  const value=String(name||'');if(!/^[a-z0-9-]+\.(?:jpg|jpeg|png|webp|gif|pdf)$/i.test(value))throw new ValidationError('অবৈধ ডকুমেন্ট শনাক্তকারী।');
  const root=path.resolve(privateRoot()),target=path.resolve(root,value);
  if(path.dirname(target)!==root)throw new ValidationError('অবৈধ ডকুমেন্ট পাথ।');
  await assertOutsidePublic(root);
  const stat=await fsp.stat(target);if(!stat.isFile())throw new ValidationError('ডকুমেন্টটি পাওয়া যায়নি।');
  return{path:target,size:stat.size};
}
async function removePrivateDocuments(names=[]){for(const name of names){try{const resolved=await resolvePrivateDocument(name);await fsp.unlink(resolved.path);}catch(_){/* staged files are best-effort cleaned on failed registration */}}}
function stagedUploads(files={}){return Object.values(files).flat().filter(Boolean);}
function removeStaged(files={}){for(const file of stagedUploads(files))upload.safeUnlink(file.path);}
module.exports={privateRoot,privateStagingRoot,ensurePrivateStagingRoot,storeUploadedDocument,resolvePrivateDocument,removePrivateDocuments,stagedUploads,removeStaged,MAX_DOCUMENT_BYTES,INVALID_DOCUMENT_MESSAGE,OVERSIZE_DOCUMENT_MESSAGE};
