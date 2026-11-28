'use strict';

// Settles pending referral and affiliate rewards, returns spent wallet money, and moves cash
// received on a cancelled order to the buyer's wallet when an order reaches a final state.
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
  if (status === 'cancelled' || status === 'failed') {
    await require('../repositories/phase08Repository').refundCancelledOrderToWalletTx(tx, orderId);
  }
}

module.exports = { applyOrderOutcomeTx };
