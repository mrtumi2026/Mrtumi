'use strict';

/**
 * SMTP mail delivery (Brevo or any SMTP provider).
 * Admin settings take priority over SMTP_* environment variables.
 * The SMTP password is never logged or rendered back to a page.
 */
const nodemailer = require('nodemailer');
const settingsRepository = require('../repositories/settingsRepository');
const { ValidationError, ConflictError } = require('../utils/errors');
const { logger } = require('../utils/logger');

const EMAIL_REGEX = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;
const pick = (setting, envName) => String(setting || process.env[envName] || '').trim();

async function getMailConfig(settingsInput) {
  const s = settingsInput || (await settingsRepository.getAllSettings().catch(() => ({})));
  const config = {
    host: pick(s.smtp_host, 'SMTP_HOST'),
    port: Number(pick(s.smtp_port, 'SMTP_PORT') || 587),
    user: pick(s.smtp_user, 'SMTP_USER'),
    pass: pick(s.smtp_pass, 'SMTP_PASSWORD'),
    fromEmail: pick(s.smtp_from_email, 'SMTP_FROM_EMAIL'),
    fromName: pick(s.smtp_from_name, 'SMTP_FROM_NAME') || 'Mr. Tumi',
  };
  const missing = [];
  if (!config.host) missing.push('SMTP Host');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) missing.push('SMTP Port');
  if (!config.user) missing.push('SMTP User');
  if (!config.pass) missing.push('SMTP Password / App Password');
  if (!EMAIL_REGEX.test(config.fromEmail)) missing.push('Verified sender email');
  return { ...config, missing };
}

async function sendMail({ to, subject, text }, { settings, createTransport = nodemailer.createTransport } = {}) {
  const recipient = String(to || '').trim();
  if (!EMAIL_REGEX.test(recipient)) throw new ValidationError('A valid recipient email address is required.');
  const config = await getMailConfig(settings);
  if (config.missing.length) throw new ConflictError(`Email delivery is disabled. Missing: ${config.missing.join(', ')}`);

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465 && !loopback,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
  try {
    const info = await transport.sendMail({
      from: { name: config.fromName, address: config.fromEmail },
      to: recipient,
      subject: String(subject || '').slice(0, 200),
      text: String(text || ''),
    });
    return { delivered: true, messageId: info.messageId || '' };
  } catch (error) {
    logger.warn('SMTP delivery failed', { code: error.code || 'SMTP_ERROR', responseCode: error.responseCode || 0 });
    throw new ConflictError(`Email could not be sent (${error.code || 'SMTP_ERROR'}). Check the SMTP settings.`);
  }
}

module.exports = { getMailConfig, sendMail };
