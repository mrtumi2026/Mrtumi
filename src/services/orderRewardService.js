'use strict';

// Settles pending referral and affiliate rewards when an order reaches a final state.
// Always runs inside the caller's transaction so money and status commit together.
async function applyOrderOutcomeTx(tx, orderId, status) {
  const referralService = require('./referralService');
  const affiliateService = require('./affiliateService');
  if (status === 'delivered') {
    await referralService.creditReferralRewardForOrder(orderId, tx);
    await affiliateService.creditOrderAffiliateCommission(orderId, tx);
  } else if (status === 'cancelled' || status === 'failed') {
    await referralService.cancelReferralRewardForOrder(orderId, tx);
    await affiliateService.cancelOrderAffiliateCommission(orderId, tx);
  }
}

module.exports = { applyOrderOutcomeTx };
