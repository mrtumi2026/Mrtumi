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
const DANGEROUS_EXTENSIONS = new Set(['.svg', '.svgz', '.html', '.htm', '.php', '.js', '.exe', '.sh']);
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/pjpeg',
  'image/jpg',
  'image/x-jpeg',
  'image/png',
  'image/x-png',
  'image/webp',
  'image/gif',
]);
const MIME_EXTENSION_FALLBACKS = new Map([
  ['image/jpeg', '.jpg'], ['image/pjpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/x-jpeg', '.jpg'],
  ['image/png', '.png'], ['image/x-png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
]);
function normalizedMimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

/**
 * Reads only the image signature. EXIF/other JPEG metadata follows the SOI marker
 * and therefore does not interfere with this check.
 */
function inspectRasterMagicBytes(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return { valid: true, permissionDenied: false };
    if (bytesRead >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { valid: true, permissionDenied: false };
    if (bytesRead >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') return { valid: true, permissionDenied: false };
    if (bytesRead >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { valid: true, permissionDenied: false };
    return { valid: false, permissionDenied: false };
  } catch (err) {
    // Permit extension-based fallback only when the OS specifically blocks
    // inspection of an existing, non-empty regular file; missing/invalid files
    // and readable files with non-image contents still fail closed.
    const permissionDenied = Boolean(err && ['EACCES', 'EPERM'].includes(err.code));
    if (permissionDenied) {
      try {
        const stat = fs.statSync(filePath);
        return { valid: false, permissionDenied: stat.isFile() && stat.size > 0 };
      } catch (_statError) {
        // No readable filesystem entry to validate.
      }
    }
    return { valid: false, permissionDenied: false };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_e) { /* ignore close error */ }
    }
  }
}

function hasValidRasterMagicBytes(filePath) {
  return inspectRasterMagicBytes(filePath).valid;
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
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const signature = file.path ? inspectRasterMagicBytes(file.path) : { valid: false, permissionDenied: false };
  const validByExtensionAfterPermissionError = ALLOWED_EXTENSIONS.has(ext) && signature.permissionDenied;
  if (!file.path || (!signature.valid && !validByExtensionAfterPermissionError)) {
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
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const mime = normalizedMimeType(file.mimetype);
    const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : (MIME_EXTENSION_FALLBACKS.get(mime) || '.jpg');
    const rand = crypto.randomBytes(6).toString('hex');
    cb(null, `${Date.now()}-${rand}${safeExt}`);
  },
});

function imageFileFilter(_req, file, cb) {
  const ext = path.extname(String(file.originalname || '')).toLowerCase();
  const mime = normalizedMimeType(file.mimetype);
  const isSvgMime = mime === 'image/svg+xml';
  const isAllowedImageMime = ALLOWED_MIME_TYPES.has(mime) || (mime.startsWith('image/') && !isSvgMime);
  if (DANGEROUS_EXTENSIONS.has(ext) || isSvgMime || (!ALLOWED_EXTENSIONS.has(ext) && !isAllowedImageMime)) {
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

// Phase 06 primary product images have a fixed 5 MiB limit independent of any
// larger multi-image/gallery upload setting.
const phase06ProductImageUpload = multer({
  storage,
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

upload.singlePhase06ProductImage = () => phase06ProductImageUpload.single('image_file');
upload.validateUploadedImageFile = validateUploadedImageFile;
upload.resolveUploadBase = resolveUploadBase;
upload.hasValidRasterMagicBytes = hasValidRasterMagicBytes;
upload.safeUnlink = safeUnlink;

module.exports = upload;
