'use strict';

const { PaymentGateway } = require('./PaymentGateway');
const { BkashGateway } = require('./BkashGateway');
const { ValidationError } = require('../../utils/errors');

function getPaymentGateway(code, options = {}) {
  const c = String(code || '').toLowerCase().trim();
  switch (c) {
    case 'bkash':
    case 'bkash_api':
    case 'bkash_auto':
      return new BkashGateway(options);
    default:
      throw new ValidationError(`Unsupported automated payment gateway code: "${code}". Supported: bkash_api.`);
  }
}

module.exports = {
  PaymentGateway,
  BkashGateway,
  getPaymentGateway,
};
