#!/usr/bin/env node
'use strict';

const mysql = require('mysql2/promise');

const RUNTIME_ALLOWED = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const DANGEROUS_GLOBAL = new Set([
  'ALL PRIVILEGES', 'SUPER', 'SYSTEM_USER', 'FILE', 'PROCESS', 'RELOAD', 'SHUTDOWN',
  'CREATE USER', 'GRANT OPTION', 'BINLOG_ADMIN', 'SYSTEM_VARIABLES_ADMIN', 'ROLE_ADMIN',
  'CONNECTION_ADMIN', 'REPLICATION SLAVE', 'REPLICATION CLIENT', 'SET_USER_ID'
]);

function parseGrant(grant) {
  const normalized = String(grant).trim().replace(/;$/, '');
  const match = normalized.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
  if (!match) return { raw: normalized, scope: 'other', privileges: [] };
  return {
    raw: normalized,
    scope: match[2].trim(),
    privileges: match[1].split(',').map(value => value.trim().toUpperCase())
  };
}

function analyzeRuntimeGrants(grants) {
  const parsed = grants.map(parseGrant);
  const violations = [];
  for (const grant of parsed) {
    if (grant.scope === '*.*') {
      const effective = grant.privileges.filter(privilege => privilege !== 'USAGE');
      if (effective.length) violations.push(`Global grant present: ${effective.join(', ')}`);
      continue;
    }
    const isDbScope = /^`?[^`]+`?\.\*$/i.test(grant.scope);
    if (!isDbScope) continue;
    for (const privilege of grant.privileges) {
      if (privilege === 'USAGE') continue;
      if (privilege === 'ALL PRIVILEGES' || privilege === 'GRANT OPTION' || !RUNTIME_ALLOWED.has(privilege)) {
        violations.push(`Runtime role has non-runtime database privilege: ${privilege} ON ${grant.scope}`);
      }
    }
  }
  for (const danger of DANGEROUS_GLOBAL) {
    if (parsed.some(grant => grant.privileges.includes(danger))) {
      if (!violations.some(text => text.includes('Global grant'))) violations.push(`Dangerous privilege detected: ${danger}`);
    }
  }
  return { ok: violations.length === 0, violations, grants: parsed };
}

async function main(env = process.env) {
  if (String(env.DB_PRIVILEGE_ROLE || 'app-runtime') !== 'app-runtime') {
    throw new Error('This checker currently validates only DB_PRIVILEGE_ROLE=app-runtime. Migration and backup accounts require separate reviewed policies.');
  }
  if (String(env.DB_CLIENT || 'mysql').toLowerCase() !== 'mysql') throw new Error('Privilege checker requires DB_CLIENT=mysql.');
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER'];
  const missing = required.filter(key => !String(env[key] || '').trim());
  if (missing.length) throw new Error(`Missing required DB configuration: ${missing.join(', ')}; values are not printed.`);
  const conn = await mysql.createConnection({
    host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER,
    password: env.DB_PASSWORD || '', database: env.DB_NAME, connectTimeout: 5000
  });
  try {
    const [[identity]] = await conn.query('SELECT CURRENT_USER() AS account');
    const [rows] = await conn.query('SHOW GRANTS FOR CURRENT_USER()');
    const grants = rows.map(row => Object.values(row)[0]);
    const result = analyzeRuntimeGrants(grants);
    console.log(JSON.stringify({ role: 'app-runtime', account: identity.account, targetDatabase: env.DB_NAME, ok: result.ok, violations: result.violations, grantCount: grants.length }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await conn.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error(`[DB PRIVILEGE CHECK FAILED] ${error.message}`);
  process.exitCode = 1;
});

module.exports = { RUNTIME_ALLOWED, DANGEROUS_GLOBAL, parseGrant, analyzeRuntimeGrants, main };
