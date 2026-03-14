'use strict';

process.env.SPORTRADAR_API_KEY = 'test';
process.env.ODDS_API_KEY = 'test';
process.env.DB_PATH = '/tmp/wild-test.db';

const assert = require('assert');

// ── Calculator ────────────────────────────────────────────────────────────────
const calc = require('./src/calculator');

assert.strictEqual(calc.americanToImplied(-130).toFixed(4), '0.5652');
assert.strictEqual(calc.americanToDecimal(-130).toFixed(4), '1.7692');
assert.strictEqual(calc.americanToDecimal(110).toFixed(4),  '2.1000');

const { prob1, prob2 } = calc.deJuice(-130, 110);
assert(Math.abs(prob1 + prob2 - 1.0) < 0.0001, 'de-juiced probs should sum to 1');
assert.strictEqual(calc.calcImpliedProb(-130, 110).toFixed(4), prob1.toFixed(4));

// CLV: closing moved from my 55% → 60% = positive (market confirmed)
assert(calc.calcCLV(0.55, 0.60) > 0, 'positive CLV expected');
// EV: my 58% estimate vs -120 opening (decimal 1.833)
// 0.58 * 1.833 - 1 = 0.063 ⇒ 6.3%
assert(calc.calcEV(0.58, -120) > 0, 'positive EV expected');

assert.strictEqual(calc.determineResult(true,  3, 2), 'win');
assert.strictEqual(calc.determineResult(false, 3, 2), 'loss');
assert.strictEqual(calc.determineResult(true,  2, 3), 'loss');
console.log('✓ calculator');

// ── Database ──────────────────────────────────────────────────────────────────
const db = require('./src/db');

db.upsertGame({
  sportradar_id: 'abc-123',
  scheduled_at:  '2026-01-15T02:00:00Z',
  home_team:     'Minnesota Wild',
  away_team:     'Colorado Avalanche',
  is_home:       1,
  status:        'scheduled',
});
const game = db.getGameBySportradarId('abc-123');
assert(game.id >= 1, 'game should have an id');
assert.strictEqual(game.home_team, 'Minnesota Wild');

db.insertSnapshot({
  game_id:          game.id,
  bookmaker:        'draftkings',
  snapshot_type:    'opening',
  captured_at:      new Date().toISOString(),
  wild_moneyline:   -130,
  opp_moneyline:    110,
  wild_implied_prob: calc.calcImpliedProb(-130, 110),
});
assert(db.hasOpeningSnapshot(game.id, 'draftkings'), 'should have opening snapshot');
assert(!db.hasOpeningSnapshot(game.id, 'pinnacle'),  'pinnacle should have no snapshot yet');

db.setMyEstimate(game.id, -125);
const g2 = db.getGameById(game.id);
assert.strictEqual(g2.my_moneyline, -125);

db.settleGame(game.id, { wild_score: 4, opponent_score: 2, result: 'win', status: 'closed' });
const g3 = db.getGameById(game.id);
assert.strictEqual(g3.result,      'win');
assert.strictEqual(g3.wild_score,   4);
assert.strictEqual(g3.opponent_score, 2);

const stats = db.getStats();
assert.strictEqual(stats.wins,         1);
assert.strictEqual(stats.win_rate_pct, 100);
console.log('✓ database');

// ── Metrics ───────────────────────────────────────────────────────────────────
const { calculateAndStoreMetrics } = require('./src/metrics');

// Add a closing snapshot for DraftKings
db.insertSnapshot({
  game_id:          game.id,
  bookmaker:        'draftkings',
  snapshot_type:    'closing',
  captured_at:      new Date().toISOString(),
  wild_moneyline:   -140,
  opp_moneyline:    120,
  wild_implied_prob: calc.calcImpliedProb(-140, 120),
});

calculateAndStoreMetrics(game.id, -125);
const allGames = db.getAllGames();
const row = allGames.find(g => g.id === game.id);
assert(row.dk_clv !== null,  'DK CLV should be set');
assert(row.dk_ev  !== null,  'DK EV should be set');
console.log('✓ metrics  (CLV:', row.dk_clv.toFixed(2) + '%, EV:', row.dk_ev.toFixed(2) + '%)');

// ── results-fetcher (module loads) ────────────────────────────────────────────
const rf = require('./src/results-fetcher');
assert.strictEqual(typeof rf.fetchSeasonSchedule, 'function');
assert.strictEqual(rf.deriveSeasonYear(new Date('2026-03-14')), 2025); // March → fall 2025
assert.strictEqual(rf.deriveSeasonYear(new Date('2025-10-01')), 2025); // Oct → 2025
console.log('✓ results-fetcher');

// ── odds-fetcher (module loads) ───────────────────────────────────────────────
const of_ = require('./src/odds-fetcher');
assert.strictEqual(typeof of_.fetchWildOdds, 'function');
console.log('✓ odds-fetcher');

// ── Sharp moves & model predictions ──────────────────────────────────────────

db.insertSnapshot({
  game_id:          game.id,
  bookmaker:        'pinnacle',
  snapshot_type:    'opening',
  captured_at:      new Date(Date.now() - 3600_000).toISOString(),
  wild_moneyline:   -120,
  opp_moneyline:    100,
  wild_implied_prob: calc.calcImpliedProb(-120, 100),
});
db.insertSharpMove({
  game_id:       game.id,
  bookmaker:     'pinnacle',
  detected_at:   new Date().toISOString(),
  old_moneyline: -120,
  new_moneyline: -135,
  move_size:     15,
});
const moves = db.getSharpMovesForGame(game.id);
assert.strictEqual(moves.length, 1);
assert.strictEqual(moves[0].move_size, 15);
db.markSharpMoveAlerted(moves[0].id);
const moves2 = db.getSharpMovesForGame(game.id);
assert.strictEqual(moves2[0].alerted, 1);
console.log('✓ sharp_move_events');

db.insertOrUpdatePrediction(game.id, 0.62);
const cal = db.getCalibrationData();
assert.strictEqual(cal.length, 1);
assert.strictEqual(cal[0].my_prob, 0.62);
assert.strictEqual(cal[0].outcome, 1); // game was settled as a win above
db.insertOrUpdatePrediction(game.id, 0.65); // upsert
const cal2 = db.getCalibrationData();
assert.strictEqual(cal2.length, 1);
assert.strictEqual(cal2[0].my_prob, 0.65);
console.log('✓ model_predictions + calibration');

// ── Context update ────────────────────────────────────────────────────────────
db.updateGameContext(game.sportradar_id, {
  wild_days_rest: 2, opp_days_rest: 1,
  opp_wins: 30, opp_losses: 20, opp_ot_losses: 5,
  opp_last10_wins: 7, opp_last10_losses: 3,
});
const g4 = db.getGameById(game.id);
assert.strictEqual(g4.wild_days_rest, 2);
assert.strictEqual(g4.opp_wins,       30);
assert.strictEqual(g4.opp_last10_wins, 7);
console.log('✓ game context columns');

// ── getAllGames has fd/betmgm columns ─────────────────────────────────────────
const all = db.getAllGames();
assert('fd_clv' in all[0],     'fd_clv column missing');
assert('betmgm_clv' in all[0], 'betmgm_clv column missing');
assert('model_prob' in all[0], 'model_prob column missing');
console.log('✓ getAllGames 4-book + model_prob columns');

// ── mailer module loads & is structured correctly ─────────────────────────────
const mailer = require('./src/mailer');
assert.strictEqual(typeof mailer.sendSharpMoveAlert, 'function');
assert.strictEqual(typeof mailer.sendSettleAlert,    'function');
console.log('✓ mailer');

// ── 4-book metrics tracking ───────────────────────────────────────────────────
const { calculateAndStoreMetrics: calcMetrics2 } = require('./src/metrics');
// Add FanDuel opening snapshot
db.insertSnapshot({
  game_id: game.id, bookmaker: 'fanduel', snapshot_type: 'opening',
  captured_at: new Date().toISOString(),
  wild_moneyline: -125, opp_moneyline: 105,
  wild_implied_prob: calc.calcImpliedProb(-125, 105),
});
calcMetrics2(game.id, -125);
const allG = db.getAllGames();
const row2 = allG.find(g => g.id === game.id);
assert(row2.fd_clv !== null || row2.fd_opening_ml !== null, 'FanDuel metrics not computed');
console.log('✓ 4-book metrics (FanDuel)');

console.log('\nAll checks passed.');

// Cleanup
require('fs').unlinkSync('/tmp/wild-test.db');

