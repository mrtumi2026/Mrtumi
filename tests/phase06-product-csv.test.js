'use strict';

const path=require('path');
const os=require('os');
const fs=require('fs');
const {describe,test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const TEST_DB_PATH=path.join(os.tmpdir(),`mrtumi.phase06.csv.${process.pid}.test.db`);
process.env.NODE_ENV='test';process.env.DB_CLIENT='sqlite';process.env.SQLITE_PATH=TEST_DB_PATH;process.env.SEED_DEMO_DATA='false';process.env.LOG_SILENT='true';
const db=require('../src/db/database');
const productRepo=require('../src/repositories/phase06Repository');
const csvRepo=require('../src/repositories/phase06ProductCsvRepository');
const {PRODUCT_CSV_COLUMNS,serializeCsv,parseCsv}=require('../src/utils/productCsv');

before(()=>{db.initializeDatabase();db.run('INSERT INTO categories(name,slug,status) VALUES(?,?,1)','CSV category','phase06-csv-category');});
after(()=>{try{db.rawDb.close();}catch(_e){}for(const ext of ['','-shm','-wal'])try{fs.unlinkSync(TEST_DB_PATH+ext);}catch(_e){}});

function csvRow(overrides={}){
  return {sku:'',barcode:'',name_bn:'পণ্য',name_en:'Product',slug:'csv-product',product_type:'grocery',category_id:'1',brand_id:'',unit_label:'1 pc',
    regular_price_bdt:'100.00',sale_price_bdt:'90.00',cost_price_bdt:'60.00',wholesale_price_bdt:'0.00',wholesale_min_qty:'0',low_stock_threshold:'3',
    short_desc_bn:'',short_desc_en:'',description_bn:'',description_en:'',...overrides};
}

describe('Phase 06 product CSV import/export (SQLite adapter)',()=>{
  test('preview is read-only, mixed invalid rows block the whole commit, and valid explicit commits preserve excluded fields',async()=>{
    const one=await productRepo.createProduct({sku:'CSV-LOCAL-001',barcode:'CSV-BAR-001',name_bn:'আগের নাম ১',name_en:'Old one',slug:'csv-local-one',category_id:1,
      regular_price_bdt:'100.00',sale_price_bdt:'90.00',cost_price_bdt:'60.00',opening_stock:'11',image_url:'/uploads/product/lychee-fresh.jpg'});
    const two=await productRepo.createProduct({sku:'CSV-LOCAL-002',barcode:'CSV-BAR-002',name_bn:'আগের নাম ২',name_en:'Old two',slug:'csv-local-two',category_id:1,
      regular_price_bdt:'200.00',sale_price_bdt:'180.00',cost_price_bdt:'120.00',opening_stock:'7',image_url:'/uploads/product/mango-organic.jpg'});
    db.run('UPDATE products SET stock_reserved=2,vendor_stock_on_hand=4,vendor_stock_reserved=1,is_flash_sale=1,approval_status=? WHERE id=?','pending',one.id);
    const oldOne=db.get('SELECT name,slug,old_price,new_price,purchase_price,stock,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,image,approval_status,is_flash_sale,is_archived,status FROM products WHERE id=?',one.id);
    const oldTwo=db.get('SELECT name,slug,old_price,new_price,purchase_price,stock,image,approval_status FROM products WHERE id=?',two.id);
    const validCsv=serializeCsv(PRODUCT_CSV_COLUMNS,[
      csvRow({sku:'CSV-LOCAL-001',barcode:'CSV-BAR-001',name_bn:'নতুন, "এক"',name_en:'=SUM(1,1)',slug:'csv-local-one-updated',regular_price_bdt:'125.50',sale_price_bdt:'110.25',cost_price_bdt:'70.00'}),
      csvRow({sku:'CSV-LOCAL-002',barcode:'CSV-BAR-002',name_bn:'নতুন দুই',name_en:'New two',slug:'csv-local-two-updated',regular_price_bdt:'250.00',sale_price_bdt:'225.00',cost_price_bdt:'150.00'}),
    ]);
    const preview=await csvRepo.previewProductCsv(validCsv);
    assert.equal(preview.valid,true,JSON.stringify(preview.errors));
    assert.equal(preview.totalRows,2);
    assert.deepEqual(db.get('SELECT name,slug,old_price,new_price,purchase_price,stock,image FROM products WHERE id=?',one.id),
      {name:oldOne.name,slug:oldOne.slug,old_price:oldOne.old_price,new_price:oldOne.new_price,purchase_price:oldOne.purchase_price,stock:oldOne.stock,image:oldOne.image},'preview does not mutate product data');

    const mixed=serializeCsv(PRODUCT_CSV_COLUMNS,[
      csvRow({sku:'CSV-LOCAL-001',barcode:'CSV-BAR-001',name_bn:'Would partially change',slug:'csv-local-one-mixed'}),
      csvRow({sku:'CSV-LOCAL-002',barcode:'CSV-BAR-002',name_bn:'Invalid taxonomy',slug:'csv-local-two-mixed',category_id:'999999'}),
    ]);
    const mixedPreview=await csvRepo.previewProductCsv(mixed);
    assert.equal(mixedPreview.valid,false);
    assert.ok(mixedPreview.errors.some((item)=>item.row===3&&item.errors.some((message)=>message.includes('active category'))));
    const mixedCommit=await csvRepo.commitProductCsv(mixed,{id:7});
    assert.equal(mixedCommit.committed,false,'mixed valid/invalid imports are all-or-nothing');
    assert.equal(db.get('SELECT name FROM products WHERE id=?',one.id).name,oldOne.name);
    assert.equal(db.get('SELECT name FROM products WHERE id=?',two.id).name,oldTwo.name);

    const committed=await csvRepo.commitProductCsv(validCsv,{id:7,ip:'192.0.2.1'});
    assert.equal(committed.committed,true);
    assert.equal(committed.updatedCount,2);
    const updatedOne=db.get('SELECT name,slug,old_price,new_price,purchase_price,stock,stock_reserved,vendor_stock_on_hand,vendor_stock_reserved,image,approval_status,is_flash_sale,is_archived,status FROM products WHERE id=?',one.id);
    assert.deepEqual(updatedOne,{...oldOne,name:'নতুন, "এক"',slug:'csv-local-one-updated',old_price:125.5,new_price:110.25,purchase_price:70,stock:11},
      'CSV updates only catalog-edit fields and leaves all inventory, image, approval, sale, archive and status fields unchanged');
    assert.equal(db.get('SELECT name,slug FROM products WHERE id=?',two.id).name,'নতুন দুই');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='product.csv_import.update' AND entity_id IN (?,?)",String(one.id),String(two.id)).n,2);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='product.csv_import.commit'").n,1);

    const triggerSql=`CREATE TRIGGER phase06_csv_audit_failure BEFORE INSERT ON audit_logs WHEN NEW.action='product.csv_import.update' AND NEW.entity_id='${two.id}' BEGIN SELECT RAISE(ABORT,'fixture CSV audit failure'); END`;
    db.rawDb.exec(triggerSql);
    try{await assert.rejects(()=>csvRepo.commitProductCsv(serializeCsv(PRODUCT_CSV_COLUMNS,[
      csvRow({sku:'CSV-LOCAL-001',barcode:'CSV-BAR-001',name_bn:'Rollback one',slug:'csv-local-one-rollback'}),
      csvRow({sku:'CSV-LOCAL-002',barcode:'CSV-BAR-002',name_bn:'Rollback two',slug:'csv-local-two-rollback'}),
    ]),{id:7}));}
    finally{db.rawDb.exec('DROP TRIGGER IF EXISTS phase06_csv_audit_failure');}
    assert.equal(db.get('SELECT name FROM products WHERE id=?',one.id).name,'নতুন, "এক"','later-row audit failure rolls back earlier product update');
    assert.equal(db.get('SELECT name FROM products WHERE id=?',two.id).name,'নতুন দুই');
  });

  test('CSV rejects duplicate SKU/barcode, ambiguous database barcodes and unsafe export formulas while preserving CSV quoting',async()=>{
    const one=db.get("SELECT id FROM products WHERE code='CSV-LOCAL-001'");
    const two=db.get("SELECT id FROM products WHERE code='CSV-LOCAL-002'");
    const repeatedSku=serializeCsv(PRODUCT_CSV_COLUMNS,[
      csvRow({sku:'CSV-LOCAL-001',barcode:'CSV-BAR-001'}),csvRow({sku:'csv-local-001',barcode:'CSV-BAR-OTHER'}),
    ]);
    const duplicateSkuPreview=await csvRepo.previewProductCsv(repeatedSku);
    assert.equal(duplicateSkuPreview.valid,false);
    assert.ok(duplicateSkuPreview.errors.some((row)=>row.errors.some((message)=>message.includes('Duplicate SKU'))));
    const repeatedBarcode=serializeCsv(PRODUCT_CSV_COLUMNS,[
      csvRow({sku:'CSV-LOCAL-001',barcode:'SAME-BAR'}),csvRow({sku:'CSV-LOCAL-002',barcode:'SAME-BAR'}),
    ]);
    assert.ok((await csvRepo.previewProductCsv(repeatedBarcode)).errors.some((row)=>row.errors.some((message)=>message.includes('Duplicate Barcode'))));
    db.run('UPDATE products SET barcode=? WHERE id=?','CSV-BAR-001',two.id);
    const ambiguous=await csvRepo.previewProductCsv(serializeCsv(PRODUCT_CSV_COLUMNS,[csvRow({sku:'CSV-LOCAL-001',barcode:'CSV-BAR-001'})]));
    assert.ok(ambiguous.errors.some((row)=>row.errors.some((message)=>message.includes('ambiguous'))));
    db.run('UPDATE products SET barcode=? WHERE id=?','CSV-BAR-002',two.id);

    db.run('UPDATE products SET name=?,name_en=? WHERE id=?','Name, with "quotes"\nand line','=SUM(1,1)',one.id);
    const exported=await csvRepo.exportProductsCsv();
    const [header,firstData]=parseCsv(exported.csv);
    assert.deepEqual(header.cells,PRODUCT_CSV_COLUMNS);
    assert.equal(firstData.cells[header.cells.indexOf('name_en')],"'=SUM(1,1)",'formula-like values are prefixed for spreadsheet safety');
    assert.equal(firstData.cells[header.cells.indexOf('name_bn')],'Name, with "quotes"\nand line','commas, quotes, and embedded newlines round-trip');
    assert.equal(header.cells.includes('image_url'),false,'export excludes media paths');
    assert.equal(header.cells.some((name)=>['stock_on_hand','stock_reserved','vendor_stock_on_hand','vendor_stock_reserved','approval_status','is_archived','status','variant_sku'].includes(name)),false,'export excludes inventory, variants and product state');
    const roundTrip=await csvRepo.previewProductCsv(exported.csv);
    assert.equal(roundTrip.valid,true,JSON.stringify(roundTrip.errors));
  });
});
