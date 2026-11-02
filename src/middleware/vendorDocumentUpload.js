'use strict';

const multer=require('multer');
const path=require('node:path');
const crypto=require('node:crypto');
const documents=require('../utils/vendorDocuments');
const {ValidationError}=require('../utils/errors');
const {MAX_DOCUMENT_BYTES,INVALID_DOCUMENT_MESSAGE}=documents;
const mimeByExtension=Object.freeze({
  '.jpg':['image/jpeg','image/pjpeg','image/jpg','image/x-jpeg'],
  '.jpeg':['image/jpeg','image/pjpeg','image/jpg','image/x-jpeg'],
  '.png':['image/png','image/x-png'],
  '.webp':['image/webp'],
  '.gif':['image/gif'],
  '.pdf':['application/pdf','application/x-pdf'],
});
function normalizedMime(value){return String(value||'').split(';',1)[0].trim().toLowerCase();}
function fileFilter(_req,file,callback){
  const extension=path.extname(String(file.originalname||'')).toLowerCase(),mime=normalizedMime(file.mimetype);
  const validExtension=Object.prototype.hasOwnProperty.call(mimeByExtension,extension);
  const validMime=validExtension&&(mimeByExtension[extension].includes(mime)||mime==='application/octet-stream');
  const pdfLogo=file.fieldname==='shop_logo'&&extension==='.pdf';
  if(!validExtension||!validMime||pdfLogo||extension==='.svg'||mime==='image/svg+xml')return callback(new ValidationError(INVALID_DOCUMENT_MESSAGE,{field:file.fieldname||'document',code:'INVALID_DOCUMENT_TYPE'}));
  return callback(null,true);
}
const storage=multer.diskStorage({
  destination(_req,_file,callback){documents.ensurePrivateStagingRoot().then(root=>callback(null,root),callback);},
  filename(_req,file,callback){const extension=path.extname(String(file.originalname||'')).toLowerCase();callback(null,`vendor-upload-${Date.now()}-${crypto.randomBytes(12).toString('hex')}${extension}`);},
});
function createApplicationUpload(){return multer({storage,fileFilter,limits:{fileSize:MAX_DOCUMENT_BYTES,files:4,fields:40}}).fields([
  {name:'nid_front',maxCount:1},{name:'nid_back',maxCount:1},{name:'trade_license',maxCount:1},{name:'shop_logo',maxCount:1},
]);}
module.exports={createApplicationUpload,fileFilter,MAX_DOCUMENT_BYTES};
