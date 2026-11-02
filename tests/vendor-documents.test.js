'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const docs=require('../src/utils/vendorDocuments');

test('vendor documents are raster-validated, stored outside public, and addressed by opaque private IDs',async()=>{
  const staging=path.join(os.tmpdir(),`vendor-doc-${process.pid}-${Date.now()}.png`);
  await fs.writeFile(staging,Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]));
  let saved;
  try{
    saved=await docs.storeUploadedDocument({path:staging,originalname:'misleading.jpg',mimetype:'image/jpeg'});
    assert.match(saved,/^vendor-doc-[0-9]+-[a-f0-9]+\.png$/);
    const resolved=await docs.resolvePrivateDocument(saved);
    assert.equal(path.dirname(resolved.path),path.resolve(docs.privateRoot()));
    assert.equal(resolved.size,12);
    assert.equal(path.resolve(resolved.path).startsWith(path.resolve(__dirname,'../public')+path.sep),false);
    await assert.rejects(()=>docs.resolvePrivateDocument('../public/leak.png'));
  }finally{await fs.rm(staging,{force:true});if(saved)await docs.removePrivateDocuments([saved]);}
});

test('vendor document upload rejects a raster extension that disguises non-image content',async()=>{
  const staging=path.join(os.tmpdir(),`vendor-doc-bad-${process.pid}-${Date.now()}.jpg`);
  await fs.writeFile(staging,'not an image');
  await assert.rejects(()=>docs.storeUploadedDocument({path:staging,originalname:'scan.jpg',mimetype:'image/jpeg'}),{code:'VALIDATION_ERROR'});
  await fs.rm(staging,{force:true});
});
