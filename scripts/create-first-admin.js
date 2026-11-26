#!/usr/bin/env node
'use strict';

/**
 * Creates the first Super Admin on a fresh MySQL/MariaDB database.
 * Run from a terminal after `migrate up`:  node scripts/create-first-admin.js
 * The password is typed at a hidden prompt; it is never an argument, never printed.
 * Refuses to run when an active Super Admin already exists.
 */

const readline = require('readline');
const bcrypt = require('bcryptjs');
const { env } = require('../src/config/env');
const mysql = require('../src/db/mysqlPool');

async function createFirstSuperAdmin({ name, email, password }, { pool } = {}) {
  const cleanName = String(name || '').trim().slice(0, 191);
  const cleanEmail = String(email || '').trim().toLowerCase().slice(0, 191);
  if (!cleanName) throw new Error('Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('Email address is invalid.');
  const secret = String(password || '');
  if (secret.length < 12 || Buffer.byteLength(secret, 'utf8') > 72) {
    throw new Error('Password must be at least 12 characters (and at most 72 bytes).');
  }
  const passwordHash = await bcrypt.hash(secret, 12);
  return mysql.withTransaction(async (tx) => {
    await tx.execute("INSERT IGNORE INTO roles(name,slug,status) VALUES('Super Admin','super_admin',1)");
    const role = await tx.queryOne("SELECT id FROM roles WHERE slug='super_admin' FOR UPDATE");
    if (!role) throw new Error('The super_admin role could not be created.');
    const existing = await tx.queryOne('SELECT id FROM users WHERE role_id=? AND status=1 LIMIT 1', [role.id]);
    if (existing) throw new Error('An active Super Admin already exists. Manage staff from the admin panel.');
    const result = await tx.execute(
      "INSERT INTO users(role_id,name,email,phone,password_hash,role_label,status) VALUES(?,?,?,'',?,'Super Admin',1)",
      [role.id, cleanName, cleanEmail, passwordHash]
    );
    await tx.execute(
      "INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent) VALUES('system',NULL,'admin.first_super_admin.created','admin_user',?,NULL,NULL,'','cli')",
      [String(result.insertId)]
    );
    return { id: Number(result.insertId) };
  }, { pool });
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    if (hidden) rl._writeToOutput = () => {};
  });
}

async function main() {
  if (env.db.client !== 'mysql') throw new Error('DB_CLIENT must be mysql.');
  if (!process.stdin.isTTY) throw new Error('Run this from an interactive terminal.');
  console.log(`Database: ${env.db.database}`);
  const name = await ask('Admin name: ');
  const email = await ask('Admin email: ');
  const password = await ask('New password (hidden, 12+ characters): ', { hidden: true });
  const again = await ask('Type the password again: ', { hidden: true });
  if (password !== again) throw new Error('The two passwords do not match.');
  try {
    await createFirstSuperAdmin({ name, email, password });
    console.log('Super Admin created. Log in at /admin/login');
  } finally {
    await mysql.closePool(mysql.getPool());
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { createFirstSuperAdmin };
