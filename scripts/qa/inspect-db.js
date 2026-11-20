'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(__dirname, '../../data/pholbazar.db');
if (fs.existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  console.log('=== PHOLBAZAR.DB INSPECTION ===');

  try {
    const tables = db.prepare('SELECT name FROM sqlite_master WHERE type="table"').all();
    console.log('Tables in pholbazar.db:', tables.map(t => t.name).join(', '));
  } catch (err) {
    console.error('Error querying tables:', err.message);
  }

  try {
    const tableInfo = db.prepare('PRAGMA table_info(products)').all();
    console.log('Product columns:', tableInfo.map(c => c.name).join(', '));
    const products = db.prepare('SELECT id, name, category_id, new_price, stock, sizes FROM products').all();
    console.log(`Found ${products.length} products in pholbazar.db:`);
    for (const p of products) {
      console.log(`  [${p.id}] "${p.name}" (Cat: ${p.category_id}) - Price: ৳${p.new_price}, Stock: ${p.stock}, Sizes: "${p.sizes || ''}"`);
    }
  } catch (err) {
    console.error('Error querying products:', err.message);
  }

  try {
    const categories = db.prepare('SELECT id, name, slug FROM categories').all();
    console.log(`\nFound ${categories.length} categories in pholbazar.db:`);
    for (const c of categories) {
      console.log(`  [${c.id}] "${c.name}" (Slug: ${c.slug})`);
    }
  } catch (err) {
    console.error('Error querying categories:', err.message);
  }

  try {
    const settings = db.prepare('SELECT key, value FROM settings').all();
    console.log(`\nFound ${settings.length} settings in pholbazar.db:`);
    for (const s of settings) {
      console.log(`  ${s.key} = "${s.value}"`);
    }
  } catch (err) {
    console.error('Error querying settings:', err.message);
  }
} else {
  console.log('pholbazar.db does not exist at:', dbPath);
}
