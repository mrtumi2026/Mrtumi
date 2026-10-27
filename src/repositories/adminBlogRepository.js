'use strict';

const crypto = require('crypto');
const { env } = require('../config/env');
const { getPool, withTransaction, createQueryClient } = require('../db/mysqlPool');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const logger = require('../utils/logger');

function client() {
  if (env.db.client !== 'mysql') throw new Error('Admin blog repository requires MySQL.');
  return createQueryClient(getPool());
}
function boundedText(raw, field, max, { required = false } = {}) {
  const value = String(raw ?? '').trim();
  if (required && !value) throw new ValidationError(`${field} is required.`);
  if (value.length > max) throw new ValidationError(`${field} must not exceed ${max} characters.`);
  return value;
}
function makeSlug(title) {
  const base = title.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}-]+/gu, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'post';
  return `${base.slice(0, 170)}-${crypto.randomBytes(5).toString('hex')}`;
}
async function insertAudit(tx, actor, action, id, beforeState, afterState) {
  const audit = (value) => value == null ? null : JSON.stringify(logger.redactValue(value));
  await tx.execute(`INSERT INTO audit_logs(actor_type,actor_id,action,entity_type,entity_id,before_json,after_json,ip_address,user_agent)
    VALUES('admin',?,?,?,?,?,?,?,?)`, [actor.id, action, 'blog', String(id), audit(beforeState), audit(afterState), String(actor.ip || '').slice(0,64), String(actor.userAgent || '').slice(0,255)]);
}
async function listBlogs() {
  return client().queryAll(`SELECT id,title,slug,category,image_url AS image,excerpt,content,author,status,created_at
    FROM blogs ORDER BY id DESC`);
}
async function createBlog(input, actor = {}) {
  const title = boundedText(input.title, 'Title', 255, { required: true });
  const category = boundedText(input.category || 'ফল ও স্বাস্থ্য', 'Category', 100);
  const image = boundedText(input.image || '/uploads/banner/banner-1.jpg', 'Image', 500);
  const excerpt = boundedText(input.excerpt, 'Excerpt', 20000);
  const content = boundedText(input.content, 'Content', 500000, { required: true });
  const slug = makeSlug(title);
  try {
    return await withTransaction(async (tx) => {
      const result = await tx.execute('INSERT INTO blogs(title,slug,category,image_url,excerpt,content,status) VALUES(?,?,?,?,?,?,1)', [title,slug,category,image,excerpt,content]);
      await insertAudit(tx, actor, 'admin.blog.created', result.insertId, null, { slug, status: 1, fields: ['title','category','image_url','excerpt','content'] });
      return { id: result.insertId, slug, status: 1 };
    });
  } catch (error) {
    if (error.code === 'DB_DUPLICATE_ENTRY') throw new ConflictError('A blog with the generated slug already exists. Please retry.');
    throw error;
  }
}
async function deleteBlog(id, actor = {}) {
  const blogId = Number(id);
  if (!Number.isSafeInteger(blogId) || blogId < 1) throw new ValidationError('Blog ID is invalid.');
  return withTransaction(async (tx) => {
    const before = await tx.queryOne('SELECT id,slug,status FROM blogs WHERE id=? FOR UPDATE', [blogId]);
    if (!before) throw new NotFoundError('Blog post not found.');
    const deleted = await tx.execute('DELETE FROM blogs WHERE id=?', [blogId]);
    if (deleted.affectedRows !== 1) throw new NotFoundError('Blog post no longer exists.');
    await insertAudit(tx, actor, 'admin.blog.deleted', blogId, { slug: before.slug, status: Number(before.status) }, null);
    return { id: blogId, deleted: true };
  });
}

module.exports = { listBlogs, createBlog, deleteBlog, makeSlug };
