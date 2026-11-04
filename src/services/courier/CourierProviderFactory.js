'use strict';

const SteadfastAdapter = require('./adapters/SteadfastAdapter');
const PathaoAdapter = require('./adapters/PathaoAdapter');
const RedxAdapter = require('./adapters/RedxAdapter');
const MockCourierAdapter = require('./adapters/MockCourierAdapter');

/**
 * Factory for creating courier provider adapters from database records.
 */
class CourierProviderFactory {
  static createAdapter(config = {}) {
    const type = String(config.provider_type || '').toLowerCase().trim();
    const code = String(config.code || '').toLowerCase().trim();
    const name = String(config.name || '').toLowerCase().trim();

    if (type === 'mock' || code.includes('mock') || name.includes('mock')) {
      return new MockCourierAdapter(config);
    }
    if (type === 'steadfast' || code.includes('steadfast') || name.includes('steadfast')) {
      return new SteadfastAdapter(config);
    }
    if (type === 'pathao' || code.includes('pathao') || name.includes('pathao')) {
      return new PathaoAdapter(config);
    }
    if (type === 'redx' || code.includes('redx') || name.includes('redx')) {
      return new RedxAdapter(config);
    }

    // Default fallback: if marked sandbox or test, return MockCourierAdapter
    if (Boolean(Number(config.sandbox || 0)) && !config.api_key) {
      return new MockCourierAdapter(config);
    }

    // General fallback
    return new SteadfastAdapter(config);
  }
}

module.exports = CourierProviderFactory;
