'use strict';

const { AppError, ValidationError } = require('./errors');

const PRODUCT_CSV_COLUMNS = Object.freeze([
  'sku','barcode','name_bn','name_en','slug','product_type','category_id','brand_id','unit_label',
  'regular_price_bdt','sale_price_bdt','cost_price_bdt','wholesale_price_bdt','wholesale_min_qty','low_stock_threshold',
  'short_desc_bn','short_desc_en','description_bn','description_en',
]);
const MAX_PRODUCT_CSV_BYTES = 1024 * 1024;
const MAX_PRODUCT_CSV_ROWS = 100;
const MAX_PRODUCT_EXPORT_ROWS = 5000;
const FORMULA_PREFIX = /^[\t\r\n ]*[=+@-]/;

function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (Buffer.byteLength(source, 'utf8') > MAX_PRODUCT_CSV_BYTES) {
    throw new AppError('CSV_INPUT_TOO_LARGE', 'CSV input exceeds the 1 MiB limit.', 413);
  }
  if (source.includes('\u0000')) throw new ValidationError('CSV input contains a NUL character.');
  const records = [];
  let cells = [];
  let value = '';
  let inQuotes = false;
  let afterQuote = false;
  let rowLine = 1;
  let line = 1;
  let hasContent = false;

  function finishCell() {
    cells.push(value);
    value = '';
    afterQuote = false;
  }
  function finishRecord() {
    finishCell();
    if (cells.some((cell) => String(cell).trim() !== '')) records.push({ line:rowLine, cells });
    cells = [];
    hasContent = false;
    rowLine = line + 1;
  }
  function consumeNewline(index, quoted) {
    const isCrLf = source[index] === '\r' && source[index + 1] === '\n';
    if (quoted) value += '\n';
    else finishRecord();
    line += 1;
    return isCrLf ? index + 1 : index;
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') { value += '"'; i += 1; hasContent = true; }
        else { inQuotes = false; afterQuote = true; }
      } else if (ch === '\r' || ch === '\n') {
        i = consumeNewline(i, true);
        hasContent = true;
      } else { value += ch; hasContent = true; }
      continue;
    }
    if (afterQuote) {
      if (ch === ',') { finishCell(); hasContent = true; continue; }
      if (ch === '\r' || ch === '\n') { i = consumeNewline(i, false); continue; }
      throw new ValidationError(`CSV row ${rowLine} has unexpected characters after a closing quote.`);
    }
    if (ch === '"') {
      if (value.length) throw new ValidationError(`CSV row ${rowLine} has a quote inside an unquoted field.`);
      inQuotes = true;
      hasContent = true;
      continue;
    }
    if (ch === ',') { finishCell(); hasContent = true; continue; }
    if (ch === '\r' || ch === '\n') { i = consumeNewline(i, false); continue; }
    value += ch;
    if (ch.trim() !== '') hasContent = true;
  }
  if (inQuotes) throw new ValidationError(`CSV row ${rowLine} has an unterminated quoted field.`);
  if (hasContent || cells.length || value.length || afterQuote) {
    finishCell();
    if (cells.some((cell) => String(cell).trim() !== '')) records.push({ line:rowLine, cells });
  }
  return records;
}

function spreadsheetSafeValue(rawValue) {
  const value = String(rawValue ?? '');
  return value.startsWith("'") || FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

function decodeSpreadsheetSafeValue(rawValue) {
  const value = String(rawValue ?? '');
  if (!value.startsWith("'")) return value;
  const unescaped = value.slice(1);
  return unescaped.startsWith("'") || FORMULA_PREFIX.test(unescaped) ? unescaped : value;
}

function quoteCsvCell(rawValue) {
  return `"${spreadsheetSafeValue(rawValue).replace(/"/g, '""')}"`;
}

function serializeCsv(columns, rows) {
  const lines = [columns.map(quoteCsvCell).join(',')];
  for (const row of rows) lines.push(columns.map((column) => quoteCsvCell(row[column])).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = {
  PRODUCT_CSV_COLUMNS,
  MAX_PRODUCT_CSV_BYTES,
  MAX_PRODUCT_CSV_ROWS,
  MAX_PRODUCT_EXPORT_ROWS,
  parseCsv,
  serializeCsv,
  spreadsheetSafeValue,
  decodeSpreadsheetSafeValue,
};
