'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const docs=require('../src/utils/vendorDocuments');

test('vendor image documents are signature-validated, stored outside public, and addressed by opaque private IDs',async()=>{
  const staging=path.join(os.tmpdir(),`vendor-doc-${process.pid}-${Date.now()}.png`);
  await fs.writeFile(staging,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]));
  let saved;
  try{
    saved=await docs.storeUploadedDocument({path:staging,originalname:'scan.png',mimetype:'image/png',size:12});
    assert.match(saved,/^vendor-doc-[0-9]+-[a-f0-9]+\.png$/);
    const resolved=await docs.resolvePrivateDocument(saved);
    assert.equal(path.dirname(resolved.path),path.resolve(docs.privateRoot()));
    assert.equal(resolved.size,12);
    assert.equal(path.resolve(resolved.path).startsWith(path.resolve(__dirname,'../public')+path.sep),false);
    await assert.rejects(()=>docs.resolvePrivateDocument('../public/leak.png'));
  }finally{await fs.rm(staging,{force:true});if(saved)await docs.removePrivateDocuments([saved]);}
});

test('vendor document upload stores valid PDF privately and enforces the 5 MiB limit',async()=>{
  const staging=path.join(os.tmpdir(),`vendor-doc-${process.pid}-${Date.now()}.pdf`),large=path.join(os.tmpdir(),`vendor-doc-large-${process.pid}-${Date.now()}.pdf`);
  const content=Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');await fs.writeFile(staging,content);
  const oversized=Buffer.alloc(docs.MAX_DOCUMENT_BYTES+1);oversized.write('%PDF-1.7');oversized.write('%%EOF',oversized.length-5);await fs.writeFile(large,oversized);
  let saved;
  try{
    saved=await docs.storeUploadedDocument({path:staging,originalname:'nid-front.pdf',mimetype:'application/pdf',size:content.length});
    assert.match(saved,/^vendor-doc-[0-9]+-[a-f0-9]+\.pdf$/);
    const resolved=await docs.resolvePrivateDocument(saved);assert.equal(resolved.size,content.length);assert.equal(path.dirname(resolved.path),path.resolve(docs.privateRoot()));
    await assert.rejects(()=>docs.storeUploadedDocument({path:large,originalname:'large.pdf',mimetype:'application/pdf'}),{code:'VALIDATION_ERROR',message:docs.OVERSIZE_DOCUMENT_MESSAGE});
  }finally{await fs.rm(staging,{force:true});await fs.rm(large,{force:true});if(saved)await docs.removePrivateDocuments([saved]);}
});

test('vendor application Multer accepts PDF and raster files with a hard 5 MiB ceiling and rejects SVG',()=>{
  const upload=require('../src/middleware/vendorDocumentUpload');
  assert.equal(upload.MAX_DOCUMENT_BYTES,5*1024*1024);
  assert.doesNotThrow(()=>upload.fileFilter({}, {originalname:'nid.pdf',mimetype:'application/pdf'},error=>{if(error)throw error;}));
  assert.doesNotThrow(()=>upload.fileFilter({}, {originalname:'nid.webp',mimetype:'image/webp'},error=>{if(error)throw error;}));
  let error;upload.fileFilter({}, {originalname:'nid.svg',mimetype:'image/svg+xml'},result=>{error=result;});assert.equal(error.code,'VALIDATION_ERROR');
  error=null;upload.fileFilter({}, {fieldname:'shop_logo',originalname:'logo.pdf',mimetype:'application/pdf'},result=>{error=result;});assert.equal(error.code,'VALIDATION_ERROR');
});

test('vendor document upload rejects a raster extension that disguises non-image content',async()=>{
  const staging=path.join(os.tmpdir(),`vendor-doc-bad-${process.pid}-${Date.now()}.jpg`);
  await fs.writeFile(staging,'not an image');
  await assert.rejects(()=>docs.storeUploadedDocument({path:staging,originalname:'scan.jpg',mimetype:'image/jpeg'}),{code:'VALIDATION_ERROR'});
  await fs.rm(staging,{force:true});
});
