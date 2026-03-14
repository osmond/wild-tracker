'use strict';

/**
 * Convert American moneyline odds to raw implied probability (vig included).
 *
 * @param {number} americanOdds  e.g. -130 or +115
 * @returns {number}  Raw implied probability [0, 1]
 */
function americanToImplied(americanOdds) {
  if (americanOdds < 0) {
    return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
  }
  return 100 / (americanOdds + 100);
}

/**
 * Convert American moneyline odds to decimal odds.
 *
 * @param {number} americanOdds  e.g. -130 → 1.769, +115 → 2.15
 * @returns {number}  Decimal odds
 */
function americanToDecimal(americanOdds) {
  if (americanOdds < 0) {
    return 1 + 100 / Math.abs(americanOdds);
  }
  return 1 + americanOdds / 100;
}

/**
 * Remove vig from a two-outcome market.
 * Each raw implied probability is divided by their overround sum so the
 * resulting probabilities sum to exactly 1.0.
 *
 * @param {number} odds1  American odds for side 1
 * @param {number} odds2  American odds for side 2
 * @returns {{ prob1: number, prob2: number }}  True (de-juiced) probabilities
 */
function deJuice(odds1, odds2) {
  const raw1 = americanToImplied(odds1);
  const raw2 = americanToImplied(odds2);
  const total = raw1 + raw2;
  return { prob1: raw1 / total, prob2: raw2 / total };
}

/**
 * Calculate the de-juiced implied win probability for the Wild given both
 * sides of the market.
 *
 * @param {number} wildOdds  American odds for Minnesota Wild
 * @param {number} oppOdds   American odds for opponent
 * @returns {number}  True implied probability for Wild [0, 1]
 */
function calcImpliedProb(wildOdds, oppOdds) {
  const { prob1 } = deJuice(wildOdds, oppOdds);
  return prob1;
}

/**
 * Calculate CLV (Closing Line Value).
 *
 * Measures how my opening probability estimate compares to the market's
 * closing implied probability.
 *
 * Formula:  CLV% = (closingProb / myEstimateProb − 1) × 100
 *
 *   Positive CLV → closing line moved in the same direction as my estimate
 *                  (market validated my view — I was "ahead of the market").
 *   Negative CLV → market moved against my estimate.
 *
 * @param {number} myImpliedProb      My raw win probability estimate for Wild
 * @param {number} closingImpliedProb  De-juiced closing line win prob for Wild
 * @returns {number|null}  CLV as a percentage
 */
function calcCLV(myImpliedProb, closingImpliedProb) {
  if (!myImpliedProb || !closingImpliedProb) return null;
  return (closingImpliedProb / myImpliedProb - 1) * 100;
}

/**
 * Calculate EV% at the opening line.
 *
 * Formula:  EV% = (myWinProb × decimalPayout − 1) × 100
 *
 * Represents the expected return per unit wagered at the opening odds,
 * given my probability estimate for Wild winning.
 *
 *   Positive EV → I believe the opening odds offer value over fair market.
 *   Negative EV → opening odds are worse than my estimated fair value.
 *
 * @param {number} myImpliedProb   My raw win probability estimate for Wild
 * @param {number} openingWildOdds  American odds for Wild at opening
 * @returns {number|null}  EV as a percentage
 */
function calcEV(myImpliedProb, openingWildOdds) {
  if (!myImpliedProb || openingWildOdds == null) return null;
  const decimal = americanToDecimal(openingWildOdds);
  return (myImpliedProb * decimal - 1) * 100;
}

/**
 * Determine Wild game result from raw scores.
 *
 * @param {boolean} isHome   True when Wild is the home team
 * @param {number}  homeScore
 * @param {number}  awayScore
 * @returns {'win'|'loss'|null}
 */
function determineResult(isHome, homeScore, awayScore) {
  if (homeScore == null || awayScore == null) return null;
  const wildScore = isHome ? homeScore : awayScore;
  const oppScore  = isHome ? awayScore : homeScore;
  if (wildScore > oppScore) return 'win';
  if (wildScore < oppScore) return 'loss';
  return null; // Shouldn't happen — NHL always produces a winner
}

module.exports = {
  americanToImplied,
  americanToDecimal,
  deJuice,
  calcImpliedProb,
  calcCLV,
  calcEV,
  determineResult,
};
