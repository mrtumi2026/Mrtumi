'use strict';

const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');
const {env}=require('../config/env');
const upload=require('../middleware/upload');
const {ValidationError}=require('./errors');

function privateRoot(){
  const configured=env.vendorDocumentDir?path.resolve(env.vendorDocumentDir):(env.uploadDir?path.join(path.resolve(env.uploadDir),'vendor-private'):'');
  if(env.isProduction){
    if(!configured)throw new ValidationError('Private vendor document storage is not configured.');
    const publicRoot=path.resolve(__dirname,'../../public');
    if(configured===publicRoot||configured.startsWith(publicRoot+path.sep))throw new ValidationError('Private vendor documents must be stored outside the public web root.');
    return configured;
  }
  return path.join(__dirname,'../../data/vendor-private-documents');
}
async function detectedRasterExtension(filePath){
  const handle=await fsp.open(filePath,'r');try{const bytes=Buffer.alloc(12);const{bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead>=2&&bytes[0]===0xff&&bytes[1]===0xd8)return'.jpg';if(bytesRead>=4&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47)return'.png';if(bytesRead>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return'.webp';if(bytesRead>=4&&bytes.toString('ascii',0,4)==='GIF8')return'.gif';return'';}finally{await handle.close();}
}
async function assertOutsidePublic(root){
  if(!env.isProduction)return;
  const publicRoot=await fsp.realpath(path.resolve(__dirname,'../../public'));
  const realRoot=await fsp.realpath(root);
  if(realRoot===publicRoot||realRoot.startsWith(publicRoot+path.sep))throw new ValidationError('Private vendor documents must be stored outside the public web root.');
}
async function storeUploadedDocument(file){
  if(!file)throw new ValidationError('A required vendor document is missing.');
  upload.validateUploadedImageFile(file);
  const ext=await detectedRasterExtension(file.path);
  if(!ext)throw new ValidationError('Only valid JPEG, PNG, WebP, or GIF document scans are accepted.');
  const root=path.resolve(privateRoot());await fsp.mkdir(root,{recursive:true,mode:0o700});await assertOutsidePublic(root);await fsp.chmod(root,0o700);
  const name=`vendor-doc-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`;
  const target=path.resolve(root,name);
  if(path.dirname(target)!==root)throw new ValidationError('Invalid private document path.');
  try{await fsp.copyFile(file.path,target,fs.constants.COPYFILE_EXCL);await fsp.chmod(target,0o600);}
  finally{upload.safeUnlink(file.path);}
  return name;
}
async function resolvePrivateDocument(name){
  const value=String(name||'');if(!/^[a-z0-9-]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(value))throw new ValidationError('Invalid private document identifier.');
  const root=path.resolve(privateRoot()),target=path.resolve(root,value);
  if(path.dirname(target)!==root)throw new ValidationError('Invalid private document path.');
  await assertOutsidePublic(root);
  const stat=await fsp.stat(target);if(!stat.isFile())throw new ValidationError('Private document not found.');
  return{path:target,size:stat.size};
}
async function removePrivateDocuments(names=[]){for(const name of names){try{const resolved=await resolvePrivateDocument(name);await fsp.unlink(resolved.path);}catch(_){/* staged files are best-effort cleaned on failed registration */}}}
function stagedUploads(files={}){return Object.values(files).flat().filter(Boolean);}
function removeStaged(files={}){for(const file of stagedUploads(files))upload.safeUnlink(file.path);}
module.exports={privateRoot,storeUploadedDocument,resolvePrivateDocument,removePrivateDocuments,stagedUploads,removeStaged};
