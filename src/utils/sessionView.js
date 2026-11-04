'use strict';

/** The session identifier is only a local fallback when cookies are unavailable. */
function visibleSessionToken(sessionId, isProduction) {
  if (isProduction) return '';
  return typeof sessionId === 'string' ? sessionId : '';
}

module.exports = { visibleSessionToken };
