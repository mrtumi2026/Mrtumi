'use strict';

// Settles pending referral and affiliate rewards, and returns spent wallet money, when an
// order reaches a final state.
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
  if (['cancelled', 'failed', 'returned'].includes(status)) {
    await require('./customerWalletService').returnOrderSpendTx(tx, orderId);
  }
}

module.exports = { applyOrderOutcomeTx };
