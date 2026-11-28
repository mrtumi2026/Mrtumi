'use strict';

const { env } = require('../config/env');
const settingsRepository = require('../repositories/settingsRepository');
const smsService = require('./smsService');
const mailService = require('./mailService');
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
  const missingEmailItems = [...(await mailService.getMailConfig(settings)).missing];
  const customerRecoveryEmailEnabled =
    String(settings.customer_recovery_email_enabled || env.customerRecoveryEmailEnabled || '0') === '1' ||
    env.customerRecoveryEmailEnabled === true;

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
    const message = `Mr. Tumi পাসওয়ার্ড কোড (OTP): ${token}। মেয়াদ ${expiryMinutes} মিনিট। কাউকে জানাবেন না।`;
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
    const minutes = Math.round(expiresInSeconds / 60);
    await mailService.sendMail({
      to: destination,
      subject: 'Mr. Tumi — পাসওয়ার্ড পুনরুদ্ধার কোড / Password recovery code',
      text: `আপনার পাসওয়ার্ড পুনরুদ্ধারের কোড: ${token}\nমেয়াদ ${minutes} মিনিট। এই কোড কাউকে জানাবেন না।\n\nYour password recovery code: ${token}\nIt expires in ${minutes} minutes. Do not share it.`,
    });
    return { delivered: true, channel: 'email' };
  }

  throw new ValidationError('Invalid recovery channel.');
}

module.exports = {
  getRecoveryProviderStatus,
  deliverRecoveryMessage,
};
