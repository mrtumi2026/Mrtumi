'use strict';

// Small, strict parsers for admin form fields. Every failure is a ValidationError shown to the admin.
const { ValidationError } = require('./errors');
const { bdtToPaisa } = require('./money');
const { requirePositiveInt } = require('./validator');

const fail = (message) => { throw new ValidationError(message); };
const id = (value, label = 'ID') => requirePositiveInt(value, label);

function optional(value, max) {
  const text = String(value ?? '').trim();
  if (text.length > max) fail(`Text must be at most ${max} characters.`);
  return text;
}
function required(value, max, label) {
  const text = optional(value, max);
  if (!text) fail(`${label} লিখতে হবে।`);
  return text;
}
function taka(value, label = 'Amount') {
  let paisa = null;
  try { paisa = bdtToPaisa(String(value ?? '').trim()); } catch (_error) { /* reported below */ }
  if (!Number.isSafeInteger(paisa) || paisa < 0 || paisa > 90000000000000) fail(`${label}: সঠিক টাকার পরিমাণ লিখুন।`);
  return paisa;
}
function positiveTaka(value, label = 'Amount') {
  const paisa = taka(value, label);
  if (paisa < 1) fail(`${label} শূন্যের চেয়ে বেশি হতে হবে।`);
  return paisa;
}
function date(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) fail('সঠিক তারিখ দিন।');
  return text;
}
// Business day in Bangladesh, independent of the server time zone.
const today = () => new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 10);
const dateText = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10));
function choice(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} সঠিক নয়।`);
  return value;
}
function slug(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!text || text.length > 191) fail('Slug ইংরেজি অক্ষর, সংখ্যা ও হাইফেন দিয়ে লিখুন।');
  return text;
}
function httpUrl(value) {
  const text = required(value, 500, 'URL');
  if (!/^https?:\/\/[^\s]+$/i.test(text)) fail('URL অবশ্যই http:// বা https:// দিয়ে শুরু হতে হবে।');
  return text;
}

module.exports = { id, optional, required, taka, positiveTaka, date, today, dateText, choice, slug, httpUrl };
