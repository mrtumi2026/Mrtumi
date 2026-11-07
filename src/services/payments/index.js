'use strict';

const { PaymentGateway } = require('./PaymentGateway');
const { BkashGateway } = require('./BkashGateway');
const { ShurjoPayGateway } = require('./ShurjoPayGateway');
const { UddoktaPayGateway } = require('./UddoktaPayGateway');
const { ValidationError } = require('../../utils/errors');

function getPaymentGateway(code, options = {}) {
  const c = String(code || '').toLowerCase().trim();
  switch (c) {
    case 'bkash':
    case 'bkash_auto':
      return new BkashGateway(options);
    case 'shurjopay':
      return new ShurjoPayGateway(options);
    case 'uddoktapay':
      return new UddoktaPayGateway(options);
    default:
      throw new ValidationError(`Unsupported payment gateway code: "${code}". Supported: bkash_auto, shurjopay, uddoktapay.`);
  }
}

module.exports = {
  PaymentGateway,
  BkashGateway,
  ShurjoPayGateway,
  UddoktaPayGateway,
  getPaymentGateway,
};
