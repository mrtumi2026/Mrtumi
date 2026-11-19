'use strict';

/**
 * Mr. Tumi Marketplace — Detached Cryptographic Release Ticket Signer
 *
 * Used by authorized release governors to cryptographically sign a release
 * candidate commit using an offline Ed25519 private key.
 *
 * The private key MUST NEVER be stored in the repository or on application servers.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function canonicalizePayload(payload) {
  // Sort keys alphabetically and format as deterministic compact JSON
  const sorted = {};
  for (const k of Object.keys(payload).sort()) {
    sorted[k] = payload[k];
  }
  return JSON.stringify(sorted);
}

function createSignedTicket(payload, privateKeyPem) {
  if (!payload.target_commit || !/^[0-9a-fA-F]{40}$/.test(payload.target_commit)) {
    throw new Error(`Invalid target_commit: must be 40-character hex SHA`);
  }
  if (!payload.key_id) {
    throw new Error(`Missing key_id in release ticket payload`);
  }

  const completePayload = {
    target_commit: payload.target_commit.toLowerCase(),
    release_tag: payload.release_tag || 'release',
    environment: payload.environment || 'production',
    issued_at: payload.issued_at || new Date().toISOString(),
    expires_at: payload.expires_at || new Date(Date.now() + (payload.validity_hours || 48) * 3600 * 1000).toISOString(),
    key_id: payload.key_id
  };

  const canonical = canonicalizePayload(completePayload);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem).toString('base64');

  return {
    ticket_version: '1.0',
    key_id: completePayload.key_id,
    payload: completePayload,
    canonical_payload: canonical,
    signature
  };
}

function main() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--commit') parsed.target_commit = args[++i];
    else if (args[i] === '--tag') parsed.release_tag = args[++i];
    else if (args[i] === '--key-id') parsed.key_id = args[++i];
    else if (args[i] === '--key-file') parsed.key_file = args[++i];
    else if (args[i] === '--env') parsed.environment = args[++i];
    else if (args[i] === '--hours') parsed.validity_hours = Number(args[++i]);
    else if (args[i] === '--out') parsed.out_file = args[++i];
  }

  if (!parsed.target_commit || !parsed.key_file) {
    console.error('Usage: node scripts/ops/sign-release-ticket.js --commit <SHA> --key-file <KEY_FILE> [--key-id <ID>] [--out <FILE>]');
    process.exit(1);
  }

  const keyPem = fs.readFileSync(parsed.key_file, 'utf8');
  const ticket = createSignedTicket(parsed, keyPem);
  const jsonStr = JSON.stringify(ticket, null, 2);

  if (parsed.out_file) {
    fs.writeFileSync(parsed.out_file, jsonStr, { mode: 0o600 });
    console.log(`✔ Signed release ticket written to: ${parsed.out_file}`);
  } else {
    console.log(jsonStr);
  }
}

if (require.main === module) {
  main();
}

module.exports = { createSignedTicket, canonicalizePayload };
