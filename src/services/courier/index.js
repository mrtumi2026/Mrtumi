'use strict';

const { CourierAdapter } = require('./CourierAdapter');
const { SteadfastAdapter } = require('./SteadfastAdapter');
const { PathaoAdapter } = require('./PathaoAdapter');
const { ValidationError } = require('../../utils/errors');

function getCourierAdapter(code, options = {}) {
  const c = String(code || '').toLowerCase().trim();
  switch (c) {
    case 'steadfast':
      return new SteadfastAdapter(options);
    case 'pathao':
      return new PathaoAdapter(options);
    default:
      throw new ValidationError(`Unsupported courier code: "${code}". Supported: steadfast, pathao.`);
  }
}

module.exports = {
  CourierAdapter,
  SteadfastAdapter,
  PathaoAdapter,
  getCourierAdapter,
};
