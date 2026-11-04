'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { env } = require('../config/env');
const { ValidationError } = require('../utils/errors');
const imageUploads = require('./upload');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MIME_EXT = new Map([
  ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/pjpeg', '.jpg'],
  ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
]);

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function resolveEvidenceDir() {
  const configured = String(process.env.CUSTOMER_RETURN_EVIDENCE_DIR || '').trim();
  let dir;
  if (configured && env.isProduction && !path.isAbsolute(configured)) throw new Error('CUSTOMER_RETURN_EVIDENCE_DIR must be an absolute path in production.');
  if (configured) dir = path.resolve(configured);
  else if (!isWithin(PUBLIC_DIR, path.resolve(env.uploadDir))) dir = path.join(env.uploadDir, 'private', 'customer_return_evidence');
  else dir = path.join(ROOT_DIR, 'storage', 'customer_return_evidence');
  if (isWithin(PUBLIC_DIR, dir)) throw new Error('Customer return evidence storage must be outside the public directory.');
  if (env.isProduction && isWithin(ROOT_DIR, dir)) throw new Error('Customer return evidence storage must be outside the application release directory in production.');
  return dir;
}
function ensureEvidenceDir() {
  const dir = resolveEvidenceDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const realDir = fs.realpathSync(dir);
  const realPublicDir = fs.realpathSync(PUBLIC_DIR);
  if (isWithin(realPublicDir, realDir)) throw new Error('Customer return evidence storage must resolve outside the public directory.');
  fs.chmodSync(realDir, 0o700);
  return realDir;
}
function evidenceKey(file) {
  if (!file) return '';
  const dir = ensureEvidenceDir();
  const resolvedFile = path.resolve(String(file.path || ''));
  if (!isWithin(dir, resolvedFile) || !fs.existsSync(resolvedFile)) throw new ValidationError('Uploaded evidence is unavailable.');
  imageUploads.validateUploadedImageFile(file);
  fs.chmodSync(resolvedFile, 0o600);
  return `return-evidence/${path.basename(resolvedFile)}`;
}
function removeUploadedEvidence(file) {
  if (!file || !file.path) return false;
  const base = path.resolve(resolveEvidenceDir());
  const resolved = path.resolve(String(file.path));
  if (!isWithin(base, resolved)) return false;
  try {
    fs.unlinkSync(resolved);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

function resolveEvidencePath(key) {
  const raw = String(key || '');
  const match = /^return-evidence\/([A-Za-z0-9-]+\.(?:jpg|jpeg|png|webp|gif))$/i.exec(raw);
  if (!match) throw new ValidationError('Return evidence is unavailable.');
  const base = ensureEvidenceDir();
  const resolved = path.resolve(base, match[1]);
  if (!isWithin(base, resolved)) throw new ValidationError('Return evidence is unavailable.');
  return resolved;
}

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    try { callback(null, ensureEvidenceDir()); } catch (error) { callback(error); }
  },
  filename: (_req, file, callback) => {
    const mime = String(file.mimetype || '').split(';', 1)[0].trim().toLowerCase();
    const originalExt = path.extname(String(file.originalname || '')).toLowerCase();
    const ext = EXTENSIONS.has(originalExt) ? originalExt : (MIME_EXT.get(mime) || '.jpg');
    callback(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`);
  },
});
const single = multer({
  storage,
  fileFilter: (_req, file, callback) => {
    const mime = String(file.mimetype || '').split(';', 1)[0].trim().toLowerCase();
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    if (!EXTENSIONS.has(ext) || !MIME_EXT.has(mime)) return callback(new ValidationError('Evidence must be a JPEG, PNG, WebP, or GIF raster image.'));
    return callback(null, true);
  },
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('evidence');

module.exports = { single, evidenceKey, resolveEvidenceDir, resolveEvidencePath, removeUploadedEvidence };
