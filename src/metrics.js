'use strict';

const { calcCLV, calcEV, americanToImplied } = require('./calculator');
const { getSnapshotsByType, upsertMetrics }   = require('./db');

const BOOKMAKERS = ['pinnacle', 'draftkings', 'fanduel', 'betmgm'];

/**
 * Compute and persist CLV / EV / implied-probability metrics for a game.
 *
 * Called automatically when a game is settled and whenever the user
 * updates their opening estimate via POST /games/:id/estimate.
 *
 * Logic per bookmaker:
 *  - opening line  → oldest snapshot with type='opening'
 *  - closing line  → most recent snapshot with type='closing'
 *                    (falls back to the most recent hourly if no closing exists)
 *  - CLV           → calcCLV(myImpliedProb, closingImpliedProb)
 *  - EV            → calcEV(myImpliedProb, openingWildMoneyline)
 *
 * @param {number}      gameId          games.id PK
 * @param {number|null} myMoneyline     User's estimate as American odds for Wild
 */
function calculateAndStoreMetrics(gameId, myMoneyline) {
  const myImpliedProb = myMoneyline != null
    ? americanToImplied(myMoneyline)
    : null;

  for (const bookmaker of BOOKMAKERS) {
    // Snapshots returned newest-first, so [0] = most recent, last = oldest
    const openingSnaps = getSnapshotsByType(gameId, bookmaker, 'opening');
    const closingSnaps = getSnapshotsByType(gameId, bookmaker, 'closing');
    const hourlySnaps  = getSnapshotsByType(gameId, bookmaker, 'hourly');

    // True opening = first snap ever (oldest opening snapshot)
    const openingSnap = openingSnaps.length
      ? openingSnaps[openingSnaps.length - 1]
      : null;

    // Canonical closing = latest 'closing' snapshot; fall back to latest hourly
    const closingSnap = closingSnaps.length
      ? closingSnaps[0]
      : hourlySnaps.length
        ? hourlySnaps[0]
        : null;

    // Nothing to calculate if we have no snapshots for this bookmaker
    if (!openingSnap && !closingSnap) continue;

    const canonicalClose = closingSnap ?? openingSnap;

    const clv = calculateAndStoreMetrics._calcCLV(myImpliedProb, canonicalClose?.wild_implied_prob ?? null);
    const ev  = calculateAndStoreMetrics._calcEV(myImpliedProb, openingSnap?.wild_moneyline ?? null);

    upsertMetrics({
      game_id:               gameId,
      bookmaker,
      opening_wild_moneyline: openingSnap?.wild_moneyline    ?? null,
      closing_wild_moneyline: canonicalClose?.wild_moneyline ?? null,
      opening_implied_prob:   openingSnap?.wild_implied_prob ?? null,
      closing_implied_prob:   canonicalClose?.wild_implied_prob ?? null,
      clv,
      ev,
    });
  }
}

// Attach the calc helpers as properties so unit tests can stub them easily
calculateAndStoreMetrics._calcCLV = calcCLV;
calculateAndStoreMetrics._calcEV  = calcEV;

module.exports = { calculateAndStoreMetrics };
