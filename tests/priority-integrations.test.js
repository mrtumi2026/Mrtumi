'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadMigrationPairs } = require('../src/db/migrator');

const root = path.join(__dirname, '..');

test('priority integrations migration defines storefront and credential fields with reversible schema changes', () => {
  const pair = loadMigrationPairs().find((item) => item.version === '0014');
  assert.ok(pair, '0014 migration pair must load');
  const base = fs.readFileSync(path.join(root, 'src/db/migrations/0003_orders_payments_and_operations.up.sql'), 'utf8');
  for (const field of ['badge', 'created_at', 'image_url', 'link_url', 'sort_order', 'status']) assert.match(pair.upSql + base, new RegExp('`' + field + '`'));
  for (const field of ['gateway_type', 'account_number', 'api_key', 'secret_key', 'instructions', 'sandbox', 'updated_at']) assert.match(pair.upSql + fs.readFileSync(path.join(root, 'src/db/migrations/0003_orders_payments_and_operations.up.sql'), 'utf8'), new RegExp('`' + field + '`'));
  for (const field of ['base_url', 'api_key', 'secret_key', 'sandbox', 'status', 'updated_at']) assert.match(pair.upSql + fs.readFileSync(path.join(root, 'src/db/migrations/0003_orders_payments_and_operations.up.sql'), 'utf8'), new RegExp('`' + field + '`'));
  assert.match(pair.downSql, /DROP COLUMN `badge`/);
  const clientIdMigration = loadMigrationPairs().find((item) => item.version === '0015');
  assert.ok(clientIdMigration, '0015 migration pair must load');
  assert.match(clientIdMigration.upSql, /`client_id`/);
  assert.match(clientIdMigration.downSql, /DROP COLUMN `client_id`/);
});

test('priority settings routes use asynchronous MySQL operations and retain SQLite fallback paths', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/adminSettings.js'), 'utf8');
  assert.match(source, /integrationsClient\(\)\.queryAll\('SELECT id,title,subtitle,badge,position,image_url AS image,link_url AS link/);
  assert.match(source, /integrationsClient\(\)\.execute\('INSERT INTO banners/);
  assert.match(source, /upload\.single\('image_file'\)/);
  assert.match(source, /upload\.validateUploadedImageFile/);
  assert.match(source, /router\.get\('\/admin\/banner\/create', \(_req, res\) => res\.redirect\('\/admin\/banner\/manage\?create=1'\)\)/);
  assert.match(source, /autoOpenModal: req\.query\.create === '1'/);
  assert.match(source, /req\.flash\('error', err\.message\)[\s\S]*?return res\.redirect\('\/admin\/banner\/manage\?create=1'\)/);
  assert.match(source, /router\.post\('\/admin\/banner\/update\/:id'/);
  assert.match(source, /router\.post\('\/admin\/paymentgeteway\/update\/:id'/);
  assert.match(source, /router\.post\('\/admin\/courierapi\/update\/:id'/);
  assert.match(source, /WHERE gateway_type=\?/);
  assert.match(source, /INSERT INTO courier_apis \(name,code,base_url,api_key,secret_key,client_id,status,sandbox\)/);
  assert.match(source, /db\.all\('SELECT \* FROM banners/);
  const checkout = fs.readFileSync(path.join(root, 'src/repositories/checkoutRepository.js'), 'utf8');
  assert.match(checkout, /gateway_type='manual'/);
  assert.match(checkout, /payment_method,payment_status/);
  const checkoutView = fs.readFileSync(path.join(root, 'views/store/checkout.ejs'), 'utf8');
  assert.match(checkoutView, /gateways\.forEach/);
  const crudView = fs.readFileSync(path.join(root, 'views/admin/crud-module.ejs'), 'utf8');
  assert.ok(crudView.includes('input[type="file"][name="image_file"]'));
  assert.ok(crudView.includes("canvas.toBlob(resolve, 'image/jpeg', quality)"));
  assert.ok(crudView.includes('180 * 1024'));
  assert.ok(crudView.includes('1920 / image.naturalWidth'));
  assert.ok(crudView.includes('name="image_base64"'));
  assert.ok(crudView.includes("editForm.enctype = 'multipart/form-data'"));
  assert.match(crudView, /crudAddImagePreview/);
  assert.match(crudView, /data-record='/);
  assert.match(crudView, /id="crudEditModal"/);
  assert.match(crudView, /bootstrap\.Modal\.getOrCreateInstance\(editModal\)\.show\(\)/);
});

test('banner upload handlers validate compressed raster payloads, preserve edits, and the storefront renders ordered carousel slides and promo grid', () => {
  const admin = fs.readFileSync(path.join(root, 'src/routes/adminSettings.js'), 'utf8');
  assert.ok(admin.includes('await saveBannerBase64(req.body.image_base64)'));
  assert.ok(admin.includes('upload.validateUploadedImageFile(req.file)'));
  assert.ok(admin.includes('banner-${Date.now()}-${crypto.randomBytes(8).toString(\'hex\')}'));
  assert.ok(admin.includes('generatedImage=newImage'));
  assert.ok(admin.includes("ORDER BY sort_order ASC,id DESC"));
  const repository = fs.readFileSync(path.join(root, 'src/repositories/storefrontRepository.js'), 'utf8');
  assert.ok(repository.includes("ORDER BY `sort_order` ASC, `id` ASC"));
  const home = fs.readFileSync(path.join(root, 'views/store/home.ejs'), 'utf8');
  assert.ok(home.includes('data-bs-interval="4500"'));
  assert.ok(home.includes('data-bs-pause="hover"'));
  assert.ok(home.includes('data-bs-touch="true"'));
  assert.ok(home.includes('carousel-indicators hero-carousel-indicators'));
  assert.ok(home.includes('promoBanners.slice(0, 4)'));
  assert.ok(home.includes('hero-slide-graphic'));
});

test('dashboard provider widgets return graceful HTTP 200 unconfigured payloads without contacting providers', () => {
  const source = fs.readFileSync(path.join(root, 'src/routes/adminDashboard.js'), 'utf8');
  assert.match(source, /success: false, configured: false, status: 'unconfigured', message/);
  assert.match(source, /API credentials not yet configured/);
  assert.match(source, /if \(kind === 'bdcourier'\) Object\.assign\(body, \{ data: null \}\)/);
  const helper = source.slice(source.indexOf('const unconfiguredProviderWidget'), source.indexOf("router.get('/admin/smsgeteway/balance'"));
  assert.match(helper, /res\.status\(200\)\.json\(body\)/);
  assert.doesNotMatch(helper, /\b(?:fetch|axios|https?\.request|integrationsClient)\b/);
  for (const route of ['/admin/smsgeteway/balance', '/admin/bdcourier/my-plan', '/admin/steadfast/dashboard-widget']) {
    assert.ok(source.includes(route));
    assert.match(source, new RegExp(`router\\.get\\('${route.replaceAll('/', '\\/')}'[^\\n]*unconfiguredProviderWidget`));
  }
  assert.doesNotMatch(source, /res\.status\(503\)/);
});

test('dashboard provider widgets render configured success data only on the success path and otherwise show unavailable', () => {
  const dashboard = fs.readFileSync(path.join(root, 'views/admin/dashboard.ejs'), 'utf8');
  const widgets = [
    ['fetchSmsBalance', /parseFloat\(d\.balance\)/],
    ['fetchBdCourierPlan', /d\.data\.plan_name/],
    ['fetchSteadfastWidget', /d\.balance_display/],
  ];
  for (const [name, configuredData] of widgets) {
    const start = dashboard.indexOf(`function ${name}()`);
    assert.notEqual(start, -1, `${name} exists`);
    const nextFunction = dashboard.indexOf('  function ', start + 1);
    const body = dashboard.slice(start, nextFunction === -1 ? dashboard.length : nextFunction);
    assert.match(body, /if \(d\.success(?: && d\.data)?\)/, `${name} gates live values on success`);
    assert.match(body, configuredData, `${name} preserves its configured-provider success path`);
    assert.match(body, /অনুপলব্ধ|Unavailable/, `${name} reports unavailable for unsuccessful or unconfigured responses`);
    if (name === 'fetchSmsBalance') assert.match(body, /#b91c1c/, 'SMS unconfigured state is styled as an error, not success');
  }
});
