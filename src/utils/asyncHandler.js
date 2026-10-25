'use strict';

/**
 * Wraps async Express route/middleware functions so rejected Promises
 * always forward cleanly to Express error handling via `next(err)`.
 */
function asyncHandler(fn) {
  return function wrappedAsyncHandler(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

asyncHandler.asyncHandler = asyncHandler;
module.exports = asyncHandler;
