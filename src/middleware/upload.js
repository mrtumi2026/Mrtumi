'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { env } = require('../config/env');
const { ValidationError } = require('../utils/errors');

/**
 * Resolves the persistent upload directory (`UPLOAD_DIR` outside release checkout on cPanel
 * when configured, falling back to `public/uploads/custom` in local development).
 */
function resolveUploadBase() {
  const configured = env && env.uploadDir ? String(env.uploadDir).trim() : '';
  const base = configured
    ? path.resolve(configured, 'custom')
    : path.join(__dirname, '..', '..', 'public', 'uploads', 'custom');
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/**
 * Inspects leading magic bytes of an uploaded raster image file on disk.
 * Rejects SVG/HTML/JS/PHP/polyglot payloads disguised with an image filename.
 */
function hasValidRasterMagicBytes(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buf, 0, 16, 0);
    if (bytesRead < 4) return false;

    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return true;
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytesRead >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return true;
    }
    // GIF87a / GIF89a: 47 49 46 38 (37|39) 61
    if (
      bytesRead >= 6 &&
      buf[0] === 0x47 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) &&
      buf[5] === 0x61
    ) {
      return true;
    }
    // WebP: RIFF....WEBP
    if (
      bytesRead >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      return true;
    }
    return false;
  } catch (_err) {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_e) {
        // ignore close error
      }
    }
  }
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_e) {
    // ignore cleanup failure
  }
}

function validateUploadedImageFile(file) {
  if (!file) return null;
  if (!file.path || !hasValidRasterMagicBytes(file.path)) {
    safeUnlink(file.path);
    throw new ValidationError(
      'Uploaded file is not a valid JPEG, PNG, WebP, or GIF raster image.',
      { field: file.fieldname || 'image', code: 'INVALID_IMAGE_SIGNATURE' }
    );
  }
  return `/uploads/custom/${path.basename(file.path)}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      cb(null, resolveUploadBase());
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.jpg';
    const rand = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${rand}${safeExt}`);
  },
});

function imageFileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(mime)) {
    return cb(
      new ValidationError(
        'Only safe raster image files (.jpg, .jpeg, .png, .webp, .gif) are allowed. SVG and executable uploads are blocked.',
        { field: file.fieldname || 'image', extension: ext, mimetype: mime }
      )
    );
  }
  return cb(null, true);
}

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: {
    fileSize: Math.max(512 * 1024, Number(env.maxUploadBytes || 5 * 1024 * 1024)),
    files: 6,
  },
});

upload.validateUploadedImageFile = validateUploadedImageFile;
upload.hasValidRasterMagicBytes = hasValidRasterMagicBytes;
upload.safeUnlink = safeUnlink;

module.exports = upload;
