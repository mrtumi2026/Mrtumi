'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('user-controlled flash messages are script-context encoded and Toastr renders them as text', () => {
  const templates = [
    'views/store/partials/footer.ejs',
    'views/admin/partials/footer.ejs',
    'views/vendor/partials/layout-bottom.ejs',
    'views/reseller/partials/layout-bottom.ejs',
  ];
  for (const relativePath of templates) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    assert.ok(source.includes('JSON.stringify(flash.message).replace(/</g'), `${relativePath} escapes HTML script terminators`);
    assert.ok(source.includes('escapeHtml: true'), `${relativePath} configures Toastr to insert message text safely`);
  }
  const hostile = '</script><script>window.pwned=1</script>\u2028&';
  const encoded = JSON.stringify(hostile).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  assert.doesNotMatch(encoded, /</);
  assert.equal(JSON.parse(encoded), hostile, 'JavaScript receives the original message without HTML parser breakout');
});
