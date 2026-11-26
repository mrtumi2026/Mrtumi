'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function views(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? views(full) : full.endsWith('.ejs') ? [full] : [];
  });
}

test('no page template prints JavaScript outside a script tag', () => {
  for (const file of views(path.join(__dirname, '..', 'views'))) {
    const visible = fs.readFileSync(file, 'utf8')
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<%[\s\S]*?%>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '');
    assert.doesNotMatch(visible, /^\s*(var|const|let) \w+ ?=|document\.(getElementById|addEventListener|querySelector)\(.*;\s*$/m, path.relative(process.cwd(), file));
  }
});
