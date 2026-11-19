'use strict';

/**
 * Mr. Tumi Marketplace — Detached Cryptographic Release Ticket Signer (v3.4 Hardened)
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
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing ticket payload object');
  }
  if (!payload.target_commit || typeof payload.target_commit !== 'string' || !/^[0-9a-fA-F]{40}$/.test(payload.target_commit.trim())) {
    throw new Error('Invalid or missing mandatory target_commit: must be a 40-character hex SHA');
  }
  if (!payload.release_tag || typeof payload.release_tag !== 'string' || !payload.release_tag.trim()) {
    throw new Error('Missing mandatory release_tag: release tag must be explicitly provided (silent defaults are forbidden)');
  }
  const releaseTag = payload.release_tag.trim();
  const tagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$/;
  if (!tagPattern.test(releaseTag)) {
    throw new Error(`Invalid release_tag '${releaseTag}': must conform to approved semantic tag pattern (e.g. v3.5.0 or v1.0.0-rc1)`);
  }

  if (!payload.environment || typeof payload.environment !== 'string' || !payload.environment.trim()) {
    throw new Error('Missing mandatory environment: target environment must be explicitly specified (silent defaults are forbidden)');
  }
  const environment = payload.environment.trim().toLowerCase();
  const allowedEnvironments = new Set(['production', 'staging', 'development']);
  if (!allowedEnvironments.has(environment)) {
    throw new Error(`Invalid environment '${environment}': must be one of [production, staging, development]`);
  }

  if (!payload.key_id || typeof payload.key_id !== 'string' || !payload.key_id.trim()) {
    throw new Error('Missing mandatory key_id: signing key ID must be explicitly specified');
  }

  if (!privateKeyPem || typeof privateKeyPem !== 'string' || !privateKeyPem.trim()) {
    throw new Error('Missing mandatory privateKeyPem: cannot sign ticket without private key');
  }

  const completePayload = {
    target_commit: payload.target_commit.trim().toLowerCase(),
    release_tag: releaseTag,
    environment,
    algorithm: 'ed25519',
    issued_at: payload.issued_at || new Date().toISOString(),
    expires_at: payload.expires_at || new Date(Date.now() + (payload.validity_hours || 48) * 3600 * 1000).toISOString(),
    key_id: payload.key_id.trim()
  };

  const canonical = canonicalizePayload(completePayload);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem).toString('base64');

  return {
    ticket_version: '1.0',
    key_id: completePayload.key_id,
    algorithm: 'ed25519',
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

  if (!parsed.target_commit || !parsed.key_file || !parsed.release_tag || !parsed.environment || !parsed.key_id) {
    console.error('Usage: node scripts/ops/sign-release-ticket.js --commit <SHA> --tag <TAG> --env <ENV> --key-id <ID> --key-file <KEY_FILE> [--hours <HOURS>] [--out <FILE>]');
    console.error('All of --commit, --tag, --env, --key-id, and --key-file are strictly MANDATORY. Silent defaults are forbidden.');
    process.exit(1);
  }

  if (!fs.existsSync(parsed.key_file)) {
    console.error(`Error: Private key file not found: ${parsed.key_file}`);
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
