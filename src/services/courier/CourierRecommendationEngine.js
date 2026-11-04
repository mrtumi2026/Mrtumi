'use strict';

/**
 * Intelligent Courier Recommendation Engine.
 * Transparently analyzes cost, delivery SLA, serviceability, COD conditions,
 * and produces explainable recommendations and comparative alternatives.
 */
class CourierRecommendationEngine {
  /**
   * Evaluate a collection of quotes and determine the recommended courier.
   * @param {Array} quotes - List of quote objects from provider adapters
   * @param {Object} context - Shipment context: { isCod, weightGrams, destination }
   * @returns {Object} { recommendedQuote, reasonBn, reasonEn, alternatives, unserviceable }
   */
  static evaluateQuotes(quotes = [], context = {}) {
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return {
        recommendedQuote: null,
        reasonBn: 'কোন সক্রিয় কুরিয়ার সার্ভিস পাওয়া যায়নি।',
        reasonEn: 'No active courier providers available for this route.',
        alternatives: [],
        unserviceable: []
      };
    }

    const serviceable = [];
    const unserviceable = [];

    for (const q of quotes) {
      if (q.available && q.chargePaisa > 0) {
        serviceable.push(q);
      } else {
        unserviceable.push({
          providerCode: q.providerCode,
          providerName: q.providerName,
          reason: q.reasonUnavailable || 'Service unavailable'
        });
      }
    }

    if (serviceable.length === 0) {
      return {
        recommendedQuote: null,
        reasonBn: 'নির্দিষ্ট ঠিকানায় কোন কুরিয়ার ডেলিভারি সার্ভিস নিশ্চিত করতে পারেনি।',
        reasonEn: 'None of the configured couriers can service this destination.',
        alternatives: [],
        unserviceable
      };
    }

    // Single option available
    if (serviceable.length === 1) {
      const single = serviceable[0];
      const costBdt = (single.chargePaisa + (single.codFeePaisa || 0)) / 100;
      return {
        recommendedQuote: single,
        reasonBn: `এই গন্তব্যের জন্য একমাত্র সক্রিয় সার্ভিস। মোট চার্জ: ৳${costBdt}, আনুমানিক সময়: ${single.estimatedDaysMin}-${single.estimatedDaysMax} দিন।`,
        reasonEn: `Sole active service available for this destination. Charge: ৳${costBdt}, ETA: ${single.estimatedDaysMin}-${single.estimatedDaysMax} days.`,
        alternatives: [],
        unserviceable
      };
    }

    // Multi-factor scoring for 2+ providers:
    // Factors: Cost (55%), Speed (40%), Live quote confidence (5%)
    const minCost = Math.min(...serviceable.map(q => q.chargePaisa + (q.codFeePaisa || 0)));
    const maxCost = Math.max(...serviceable.map(q => q.chargePaisa + (q.codFeePaisa || 0)));
    const minDays = Math.min(...serviceable.map(q => (q.estimatedDaysMin + q.estimatedDaysMax) / 2));
    const maxDays = Math.max(...serviceable.map(q => (q.estimatedDaysMin + q.estimatedDaysMax) / 2));

    const scored = serviceable.map(q => {
      const totalCost = q.chargePaisa + (q.codFeePaisa || 0);
      const avgDays = (q.estimatedDaysMin + q.estimatedDaysMax) / 2;

      // Cost score: 1.0 (cheapest) to 0.0 (most expensive)
      const costScore = maxCost === minCost ? 1.0 : (maxCost - totalCost) / (maxCost - minCost);

      // Speed score: 1.0 (fastest) to 0.0 (slowest)
      const speedScore = maxDays === minDays ? 1.0 : (maxDays - avgDays) / (maxDays - minDays);

      // Live quote bonus: 0.05 if live verified
      const liveBonus = q.isLiveQuote ? 0.05 : 0;

      const totalScore = (costScore * 0.55) + (speedScore * 0.40) + liveBonus;

      return {
        ...q,
        totalCostPaisa: totalCost,
        avgDays,
        score: totalScore
      };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    const winner = scored[0];
    const winnerCostBdt = winner.totalCostPaisa / 100;

    // Build transparent rationale
    let reasonBn = '';
    let reasonEn = '';

    const isCheapest = winner.totalCostPaisa === minCost;
    const isFastest = winner.avgDays === minDays;

    if (isCheapest && isFastest) {
      reasonBn = `সবচেয়ে সাশ্রয়ী রেট (৳${winnerCostBdt}) এবং দ্রুততম ডেলিভারির (${winner.estimatedDaysMin}-${winner.estimatedDaysMax} দিন) জন্য এটি সেরা বিকল্প।`;
      reasonEn = `Best overall option: lowest delivery cost (৳${winnerCostBdt}) and fastest SLA (${winner.estimatedDaysMin}-${winner.estimatedDaysMax} days).`;
    } else if (isFastest && !isCheapest) {
      const diffCostBdt = (winner.totalCostPaisa - minCost) / 100;
      reasonBn = `দ্রুততম ডেলিভারি নিশ্চিত করতে সুপারিশ করা হয়েছে (৳${diffCostBdt} অতিরিক্ত হলেও সময় বাঁচাবে)।`;
      reasonEn = `Recommended for fastest delivery time (${winner.estimatedDaysMin}-${winner.estimatedDaysMax} days), worth the ৳${diffCostBdt} price difference.`;
    } else if (isCheapest) {
      reasonBn = `সবচেয়ে কম খরচে (৳${winnerCostBdt}) নির্ভরযোগ্য ডেলিভারির জন্য প্রস্তাবিত।`;
      reasonEn = `Recommended for best price efficiency (৳${winnerCostBdt}) for standard delivery.`;
    } else {
      reasonBn = `খরচ ও ডেলিভারি সময়ের সার্বিক ভারসাম্য বিবেচনা করে এটি প্রস্তাবিত হয়েছে।`;
      reasonEn = `Recommended based on optimal balance between cost and delivery SLA.`;
    }

    // Build alternatives comparison
    const alternatives = scored.slice(1).map(alt => {
      const altCostBdt = alt.totalCostPaisa / 100;
      const costDiffBdt = (alt.totalCostPaisa - winner.totalCostPaisa) / 100;
      const daysDiff = alt.avgDays - winner.avgDays;

      let tradeOffBn = '';
      let tradeOffEn = '';

      if (costDiffBdt > 0 && daysDiff >= 0) {
        tradeOffBn = `৳${costDiffBdt} বেশি চার্জ এবং ডেলিভারি বিলম্ব হতে পারে`;
        tradeOffEn = `৳${costDiffBdt} higher cost and longer delivery window`;
      } else if (costDiffBdt < 0) {
        tradeOffBn = `৳${Math.abs(costDiffBdt)} সাশ্রয়ী কিন্তু সময় বেশি লাগতে পারে`;
        tradeOffEn = `৳${Math.abs(costDiffBdt)} cheaper but slower delivery window`;
      } else if (daysDiff < 0) {
        tradeOffBn = `${Math.abs(daysDiff)} দিন দ্রুত কিন্তু রেট সামান্য বেশি`;
        tradeOffEn = `${Math.abs(daysDiff)} day(s) faster with higher tariff`;
      } else {
        tradeOffBn = `বিকল্প কুরিয়ার সার্ভিস`;
        tradeOffEn = `Alternative service option`;
      }

      return {
        providerCode: alt.providerCode,
        providerName: alt.providerName,
        chargePaisa: alt.chargePaisa,
        codFeePaisa: alt.codFeePaisa,
        totalCostPaisa: alt.totalCostPaisa,
        totalCostBdt: altCostBdt,
        estimatedDaysMin: alt.estimatedDaysMin,
        estimatedDaysMax: alt.estimatedDaysMax,
        isLiveQuote: alt.isLiveQuote,
        serviceType: alt.serviceType,
        tradeOffBn,
        tradeOffEn
      };
    });

    return {
      recommendedQuote: {
        providerCode: winner.providerCode,
        providerName: winner.providerName,
        chargePaisa: winner.chargePaisa,
        codFeePaisa: winner.codFeePaisa,
        totalCostPaisa: winner.totalCostPaisa,
        totalCostBdt: winnerCostBdt,
        estimatedDaysMin: winner.estimatedDaysMin,
        estimatedDaysMax: winner.estimatedDaysMax,
        isLiveQuote: winner.isLiveQuote,
        serviceType: winner.serviceType,
        score: winner.score
      },
      reasonBn,
      reasonEn,
      alternatives,
      unserviceable
    };
  }
}

module.exports = CourierRecommendationEngine;
