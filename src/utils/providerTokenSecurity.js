'use strict';

const crypto = require('node:crypto');
const { env } = require('../config/env');

/**
 * Derives a deterministic 32-byte key for application-level provider token encryption (AES-256-GCM)
 * using HKDF from VENDOR_PII_KEY or stable SESSION_SECRET.
 */
function getProviderTokenKey() {
  const rawKey = String(process.env.VENDOR_PII_KEY || '').trim();
  if (rawKey) {
    if (/^[a-f0-9]{64}$/i.test(rawKey)) return Buffer.from(rawKey, 'hex');
    try {
      const b = Buffer.from(rawKey, 'base64');
      if (b.length === 32) return b;
    } catch (_e) {}
  }

  const secret = String(env.sessionSecret || process.env.SESSION_SECRET || 'mrtumi-courier-default-secret-salt-key-32b');
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      Buffer.from('mrtumi-courier-salt-v1', 'utf8'),
      Buffer.from('mrtumi-courier-token-v1', 'utf8'),
      32
    )
  );
}

/**
 * Encrypts a sensitive provider token using authenticated AES-256-GCM.
 * Output format: enc:v1:<iv_base64>:<tag_base64>:<ciphertext_base64>
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encryptProviderToken(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getProviderTokenKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts a sensitive provider token if encrypted with enc:v1: prefix.
 * If plaintext, returns as-is.
 *
 * @param {string} ciphertext
 * @returns {string}
 */
function decryptProviderToken(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.startsWith('enc:v1:')) {
    return ciphertext;
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 5) return ciphertext;
  try {
    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const encrypted = Buffer.from(parts[4], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getProviderTokenKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (_err) {
    return ciphertext;
  }
}

module.exports = {
  encryptProviderToken,
  decryptProviderToken,
  getProviderTokenKey,
};
