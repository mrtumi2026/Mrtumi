'use strict';

const { env } = require('../config/env');
const settingsRepository = require('../repositories/settingsRepository');
const smsService = require('./smsService');
const { ValidationError, ConflictError } = require('../utils/errors');
const { logger } = require('../utils/logger');

/**
 * Evaluates live provider readiness and owner authorization for customer account recovery.
 * Recovery remains fail-closed (disabled) until an approved, configured delivery provider exists.
 */
async function getRecoveryProviderStatus() {
  let settings = {};
  try {
    settings = await settingsRepository.getAllSettings();
  } catch (_e) {
    settings = {};
  }

  // 1. BulkSMSBD SMS Gateway Check
  const bulksmsApiKey = String(settings.bulksms_api_key || env.bulksmsApiKey || '').trim();
  const bulksmsSenderId = String(settings.bulksms_sender_id || env.bulksmsSenderId || '').trim();
  const bulksmsEnabled = settings.bulksms_enabled !== '0';
  const customerRecoverySmsEnabled =
    String(settings.customer_recovery_sms_enabled || env.customerRecoverySmsEnabled || '0') === '1' ||
    env.customerRecoverySmsEnabled === true;

  const missingSmsItems = [];
  if (!bulksmsApiKey) missingSmsItems.push('BulkSMSBD API Key');
  if (!bulksmsSenderId) missingSmsItems.push('BulkSMSBD Sender ID');
  if (!bulksmsEnabled) missingSmsItems.push('BulkSMSBD Gateway Enabled in Admin Settings');
  if (!customerRecoverySmsEnabled) missingSmsItems.push('Owner authorization for live customer recovery SMS (customer_recovery_sms_enabled=1)');

  const smsAvailable = missingSmsItems.length === 0;

  // 2. SMTP Email Gateway Check
  const smtpHost = String(settings.smtp_host || env.smtpHost || '').trim();
  const smtpPort = String(settings.smtp_port || env.smtpPort || '').trim();
  const smtpUser = String(settings.smtp_user || env.smtpUser || '').trim();
  const smtpPass = String(settings.smtp_pass || env.smtpPassword || '').trim();
  const customerRecoveryEmailEnabled =
    String(settings.customer_recovery_email_enabled || env.customerRecoveryEmailEnabled || '0') === '1' ||
    env.customerRecoveryEmailEnabled === true;

  const missingEmailItems = [];
  if (!smtpHost) missingEmailItems.push('SMTP Host');
  if (!smtpUser) missingEmailItems.push('SMTP User');
  if (!smtpPass) missingEmailItems.push('SMTP Password / App Password');
  if (!customerRecoveryEmailEnabled) missingEmailItems.push('Owner authorization for live customer recovery Email (customer_recovery_email_enabled=1)');

  const emailAvailable = missingEmailItems.length === 0;

  const enabled = smsAvailable || emailAvailable;
  const availableChannels = [];
  if (smsAvailable) availableChannels.push('phone');
  if (emailAvailable) availableChannels.push('email');

  return {
    enabled,
    availableChannels,
    sms: {
      available: smsAvailable,
      missing: missingSmsItems,
      gateway: 'BulkSMSBD',
    },
    email: {
      available: emailAvailable,
      missing: missingEmailItems,
      gateway: 'SMTP',
    },
  };
}

/**
 * Adapter invoked by customerRepository.issueCustomerRecovery.
 * Delivers recovery token to verified destination via approved provider.
 * Never leaks token into logs.
 */
async function deliverRecoveryMessage({ channel, destination, token, expiresInSeconds = 1200 }) {
  const status = await getRecoveryProviderStatus();

  if (channel === 'phone') {
    if (!status.sms.available) {
      throw new ConflictError(
        `SMS recovery delivery is disabled. Missing: ${status.sms.missing.join(', ')}`
      );
    }
    const expiryMinutes = Math.round(expiresInSeconds / 60);
    const message = `[Mr. Tumi] আপনার পাসওয়ার্ড পুনরুদ্ধারের কোড: ${token}। মেয়াদ ${expiryMinutes} মিনিট। এই কোড কাউকে জানাবেন না।`;
    const result = await smsService.sendSms({
      phone: destination,
      message,
      templateKey: 'customer_recovery',
    });
    if (!result || !result.success) {
      logger.warn('BulkSMSBD recovery delivery attempt failed', { error: result?.error || 'Unknown provider error' });
      throw new Error(`BulkSMSBD delivery failed: ${result?.error || 'Unknown error'}`);
    }
    return { delivered: true, channel: 'phone' };
  }

  if (channel === 'email') {
    if (!status.email.available) {
      throw new ConflictError(
        `Email recovery delivery is disabled. Missing: ${status.email.missing.join(', ')}`
      );
    }
    throw new ConflictError('SMTP transactional email delivery adapter is pending owner SMTP configuration.');
  }

  throw new ValidationError('Invalid recovery channel.');
}

module.exports = {
  getRecoveryProviderStatus,
  deliverRecoveryMessage,
};
