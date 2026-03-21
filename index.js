'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');

const { start: startScheduler }    = require('./src/scheduler');
const { syncSchedule, pollOdds, settleGames } = require('./src/scheduler');
const { calculateAndStoreMetrics } = require('./src/metrics');
const { americanToImplied, americanToDecimal } = require('./src/calculator');
const { fetchHistoricalWildOddsFromESPN } = require('./src/odds-fetcher');
const {
  getAllGames,
  getGameById,
  getAllSnapshotsForGame,
  getSharpMovesForGame,
  getAllSharpMoves,
  setMyEstimate,
  insertOrUpdatePrediction,
  getCalibrationData,
  getDollarBetGames,
  getStats,
  getPuckLineGames,
  getSplits,
  upsertManualLine,
  upsertMetrics,
  updateGameTotalResult,
  getOUTrackerGames,
  getGamesNeedingOddsBackfill,
  getSettlableGames,
} = require('./src/db');

// ─── Guard: require API keys before starting ─────────────────────────────────
if (!process.env.ODDS_API_KEY) {
  console.error('ERROR: ODDS_API_KEY is not set. Check your .env file.');
  process.exit(1);
}
if (!process.env.SPORTRADAR_API_KEY) {
  console.warn('WARN: SPORTRADAR_API_KEY is not set — schedule/results data will use the free NHL API only.');
}

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const router = express.Router();

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /games
 * All Wild games (newest first), with merged Pinnacle + DraftKings metric
 * columns (opening/closing lines, CLV, EV) and final scores once settled.
 */
router.get('/games', (_req, res) => {
  const games = getAllGames();
  res.json({ count: games.length, games });
});

/**
 * GET /games/:id
 * Single game detail — game row merged with all odds snapshots.
 */
router.get('/games/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  const game = getGameById(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const snapshots = getAllSnapshotsForGame(id);
  res.json({ game, snapshots });
});

/**
 * GET /games/:id/snapshots
 * Full odds-snapshot history for one game (both bookmakers, all types).
 */
router.get('/games/:id/snapshots', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  const game = getGameById(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const snapshots = getAllSnapshotsForGame(id);
  res.json({ game_id: id, count: snapshots.length, snapshots });
});

/**
 * POST /games/:id/estimate
 * Set (or update) the user's opening moneyline estimate for a game.
 * Immediately recalculates CLV and EV metrics with the new value.
 *
 * Body: { "moneyline": -130 }   (American odds for Wild winning)
 */
router.post('/games/:id/estimate', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  const { moneyline } = req.body;
  if (typeof moneyline !== 'number' || !Number.isFinite(moneyline) || moneyline === 0) {
    return res.status(400).json({
      error: 'moneyline must be a non-zero finite number in American odds format (e.g. -130 or 115)',
    });
  }

  const game = getGameById(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  setMyEstimate(id, moneyline);

  const impliedProb = americanToImplied(moneyline);
  calculateAndStoreMetrics(id, moneyline);

  res.json({
    ok:           true,
    game_id:      id,
    my_moneyline: moneyline,
    implied_prob: parseFloat(impliedProb.toFixed(4)),
  });
});

/**
 * GET /sharp-moves
 * All detected sharp move events across every game, newest first.
 */
router.get('/sharp-moves', (_req, res) => {
  const moves = getAllSharpMoves();
  res.json({ count: moves.length, sharp_moves: moves });
});

/**
 * GET /stats
 * Aggregate win rate, CLV%, average EV, ROI, and current streak across all
 * settled Wild games.
 */
router.get('/stats', (_req, res) => {
  const stats = getStats();
  res.json(stats);
});

/**
 * GET /stats/splits
 * Home/Away, back-to-back, and opponent-strength (vs .500+, vs <.500) W/L records.
 */
router.get('/stats/splits', (_req, res) => {
  res.json(getSplits());
});

/**
 * GET /puck-line-tracker
 * Every Wild game with derived puck line coverage results (±1.5) and total goals.
 * Running covered/total counts computed chronologically so the UI can draw trend curves.
 */
router.get('/puck-line-tracker', (_req, res) => {
  const games = getPuckLineGames();

  // Convert American moneyline odds to $1 profit
  function spreadProfit(odds) {
    if (odds == null) return null;
    return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  }

  let minusCovered = 0, minusTotal = 0;
  let plusCovered  = 0, plusTotal  = 0;
  let minusPnl = 0,     plusPnl  = 0;
  let minusOddsBets = 0, plusOddsBets = 0;

  const bets = games.map(g => {
    const bet = {
      game_id:          g.id,
      scheduled_at:     g.scheduled_at,
      home_team:        g.home_team,
      away_team:        g.away_team,
      is_home:          g.is_home,
      status:           g.status,
      result:           g.result,
      wild_score:       g.wild_score,
      opponent_score:   g.opponent_score,
      goal_diff:        g.goal_diff,
      covers_minus_1_5: g.covers_minus_1_5,
      covers_plus_1_5:  g.covers_plus_1_5,
      total_goals:      g.total_goals,
      wild_spread_odds: g.closing_wild_spread_odds  ?? null,
      opp_spread_odds:  g.closing_opp_spread_odds   ?? null,
    };

    if (g.covers_minus_1_5 !== null) {
      if (g.covers_minus_1_5) minusCovered++;
      minusTotal++;
    }
    if (g.covers_plus_1_5 !== null) {
      if (g.covers_plus_1_5) plusCovered++;
      plusTotal++;
    }

    // Per-game P&L — only when odds are available
    if (g.covers_minus_1_5 !== null && g.closing_wild_spread_odds != null) {
      const profit = spreadProfit(g.closing_wild_spread_odds);
      bet.minus_pnl = g.covers_minus_1_5 ? profit : -1;
      minusPnl += bet.minus_pnl;
      minusOddsBets++;
    } else {
      bet.minus_pnl = null;
    }

    if (g.covers_plus_1_5 !== null && g.closing_opp_spread_odds != null) {
      const profit = spreadProfit(g.closing_opp_spread_odds);
      bet.plus_pnl = g.covers_plus_1_5 ? profit : -1;
      plusPnl += bet.plus_pnl;
      plusOddsBets++;
    } else {
      bet.plus_pnl = null;
    }

    bet.minus_running_covered = minusCovered;
    bet.minus_running_total   = minusTotal;
    bet.plus_running_covered  = plusCovered;
    bet.plus_running_total    = plusTotal;
    return bet;
  });

  res.json({
    total_games:       games.length,
    settled_games:     minusTotal,
    minus_covered:     minusCovered,
    minus_not_covered: minusTotal - minusCovered,
    plus_covered:      plusCovered,
    plus_not_covered:  plusTotal - plusCovered,
    minus_pnl:         minusOddsBets > 0 ? parseFloat(minusPnl.toFixed(2)) : null,
    plus_pnl:          plusOddsBets  > 0 ? parseFloat(plusPnl.toFixed(2))  : null,
    bets,
  });
});

/**
 * POST /games/:id/total-line
 * Manually enter a total (over/under) line and optional spread odds for a game.
 * Used to backfill historical games where the odds pipeline hadn't captured
 * markets yet. For already-settled games the total_result is computed immediately.
 *
 * Body (all optional except at least one field):
 *   { "total_line": 6.5, "over_odds": -115, "under_odds": -105,
 *     "wild_spread_odds": 180, "opp_spread_odds": -210 }
 */
router.post('/games/:id/total-line', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  const game = getGameById(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const { total_line, over_odds, under_odds, wild_spread_odds, opp_spread_odds } = req.body;

  if (total_line !== undefined && (typeof total_line !== 'number' || total_line <= 0)) {
    return res.status(400).json({ error: 'total_line must be a positive number' });
  }

  upsertManualLine(id, {
    total_line:       total_line       ?? null,
    over_odds:        over_odds        ?? null,
    under_odds:       under_odds       ?? null,
    wild_spread_odds: wild_spread_odds ?? null,
    opp_spread_odds:  opp_spread_odds  ?? null,
  });

  // If game is already settled and we now have a total line, compute result immediately
  if (game.status === 'closed' && total_line != null && game.wild_score != null) {
    const totalGoals = game.wild_score + game.opponent_score;
    let totalResult = null;
    if (totalGoals > total_line)      totalResult = 'over';
    else if (totalGoals < total_line) totalResult = 'under';
    else                              totalResult = 'push';

    const goalDiff       = game.wild_score - game.opponent_score;
    const pucklineMinus  = game.result ? (goalDiff >= 2 ? 1 : 0) : null;

    updateGameTotalResult(id, {
      total_result:           totalResult,
      puckline_minus_covered: pucklineMinus,
    });
  }

  return res.json({ ok: true, game_id: id });
});

/**
 * GET /ou-tracker
 * Every Wild game with total line, over/under odds, total result, and running $1 P&L
 * for "bet over every game" and "bet under every game" strategies.
 */
router.get('/ou-tracker', (_req, res) => {
  const { americanToDecimal: toDecimal } = require('./src/calculator');
  const games = getOUTrackerGames();

  let overPnl  = 0;
  let underPnl = 0;
  let overSettled  = 0;
  let underSettled = 0;

  const bets = games.map(g => {
    const hasLine   = g.total_line != null;
    const settled   = g.total_result != null;

    let overProfit  = null;
    let underProfit = null;

    if (settled && hasLine) {
      if (g.total_result === 'push') {
        overProfit  = 0;
        underProfit = 0;
      } else if (g.total_result === 'over') {
        const dec = g.over_odds != null ? toDecimal(g.over_odds) : toDecimal(-110);
        overProfit  = parseFloat((dec - 1).toFixed(4));
        underProfit = -1;
      } else {
        // under
        const dec = g.under_odds != null ? toDecimal(g.under_odds) : toDecimal(-110);
        underProfit = parseFloat((dec - 1).toFixed(4));
        overProfit  = -1;
      }
      overPnl  = parseFloat((overPnl  + overProfit).toFixed(4));
      underPnl = parseFloat((underPnl + underProfit).toFixed(4));
      overSettled++;
      underSettled++;
    }

    return {
      game_id:        g.id,
      scheduled_at:   g.scheduled_at,
      home_team:      g.home_team,
      away_team:      g.away_team,
      is_home:        g.is_home,
      status:         g.status,
      result:         g.result,
      wild_score:     g.wild_score,
      opponent_score: g.opponent_score,
      total_goals:    g.total_goals,
      total_line:     g.total_line,
      over_odds:      g.over_odds,
      under_odds:     g.under_odds,
      total_result:   g.total_result,
      over_profit:    overProfit,
      under_profit:   underProfit,
      over_running_pnl:  settled && hasLine ? overPnl  : null,
      under_running_pnl: settled && hasLine ? underPnl : null,
    };
  });

  res.json({
    total_games:   games.length,
    games_with_line: games.filter(g => g.total_line != null).length,
    over_settled:  overSettled,
    over_pnl:      overPnl,
    under_pnl:     underPnl,
    overs:  games.filter(g => g.total_result === 'over').length,
    unders: games.filter(g => g.total_result === 'under').length,
    pushes: games.filter(g => g.total_result === 'push').length,
    bets,
  });
});

/**
 * GET /games/:id/sharp-moves
 * All sharp-move events recorded for one game.
 */
router.get('/games/:id/sharp-moves', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }
  const game = getGameById(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const moves = getSharpMovesForGame(id);
  res.json({ game_id: id, count: moves.length, sharp_moves: moves });
});

/**
 * POST /games/:id/predict
 * Store (or update) a pre-game win-probability estimate for the Wild.
 * Body: { "my_prob": 0.62 }   (float, 0 < value < 1)
 *
 * Upserts into model_predictions.  Recalculating CLV/EV here is intentional
 * so that both estimate formats (moneyline + raw prob) drive the same metrics.
 */
router.post('/games/:id/predict', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' });
  }

  const { my_prob } = req.body;
  if (typeof my_prob !== 'number' || !Number.isFinite(my_prob) || my_prob <= 0 || my_prob >= 1) {
    return res.status(400).json({
      error: 'my_prob must be a finite number between 0 and 1 exclusive (e.g. 0.62)',
    });
  }

  const game = getGameById(id);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  insertOrUpdatePrediction(id, my_prob);

  res.json({ ok: true, game_id: id, my_prob });
});

/**
 * GET /dollar-tracker
 * Returns every Wild game with a hypothetical $1 bet on the Wild at the
 * best available market moneyline (closing preferred, opening as fallback).
 * Profit/loss is pre-computed for settled games; potential profit is included
 * for upcoming games. A cumulative running_pnl column lets the UI draw a
 * running-total curve without any extra maths.
 */
router.get('/dollar-tracker', (_req, res) => {
  const games = getDollarBetGames();
  let runningPnl = 0;
  let settledCount = 0;

  const bets = games.map(g => {
    const bet = {
      game_id:       g.id,
      scheduled_at:  g.scheduled_at,
      home_team:     g.home_team,
      away_team:     g.away_team,
      is_home:       g.is_home,
      status:        g.status,
      result:        g.result,
      wild_score:    g.wild_score,
      opponent_score: g.opponent_score,
      bet_ml:        g.bet_ml,
    };

    if (g.result === 'win' && g.bet_ml != null) {
      const profit = americanToDecimal(g.bet_ml) - 1;
      bet.profit      = parseFloat(profit.toFixed(4));
      runningPnl     += profit;
      settledCount   += 1;
    } else if (g.result === 'win') {
      // Win but no odds available — can't compute payout
      bet.profit      = null;
      bet.no_odds     = true;
      settledCount   += 1;
    } else if (g.result === 'loss') {
      bet.profit      = -1;
      runningPnl     -= 1;
      settledCount   += 1;
    } else {
      // Upcoming / live — show what a win would pay
      bet.profit           = null;
      bet.potential_profit = g.bet_ml != null
        ? parseFloat((americanToDecimal(g.bet_ml) - 1).toFixed(4))
        : null;
    }

    bet.running_pnl = parseFloat(runningPnl.toFixed(4));
    return bet;
  });

  res.json({
    total_games:   games.length,
    settled_games: settledCount,
    total_pnl:     parseFloat(runningPnl.toFixed(4)),
    bets,
  });
});

/**
 * GET /stats/calibration
 * Returns all (my_prob, outcome) pairs for games that have a prediction
 * stored via POST /games/:id/predict.
 *
 * outcome: 1 = Wild win, 0 = Wild loss, null = not yet settled.
 * Useful for generating a calibration curve.
 */
router.get('/stats/calibration', (_req, res) => {
  const rows = getCalibrationData();
  res.json({ count: rows.length, calibration: rows });
});

// ─── Manual trigger endpoints (useful for testing / backfill) ─────────────────

/**
 * Simple shared-secret guard for admin-only endpoints.
 * Set ADMIN_KEY in your .env to enable. Requests must include:
 *   Authorization: Bearer <ADMIN_KEY>
 * If ADMIN_KEY is not set, the endpoints are unrestricted (dev convenience).
 */
function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return next(); // key not configured — allow in dev

  const auth = req.headers['authorization'] ?? '';
  if (auth === `Bearer ${adminKey}`) return next();

  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * POST /admin/backfill-odds
 * Fetch historical totals + spreads odds from ESPN's public summary API for
 * every settled game that is missing a closing total line, and upsert them
 * into game_metrics.  Also computes total_result for each game.
 *
 * Uses ESPN's free public API (no key required). ESPN typically retains
 * betting data going back ~16 weeks, so early-season games may show
 * "not_found".
 *
 * Query: ?dryRun=true  — returns the list of games to backfill without fetching.
 */
router.post('/admin/backfill-odds', requireAdminKey, async (req, res) => {
  const dryRun   = req.query.dryRun === 'true';
  const games    = getGamesNeedingOddsBackfill();

  if (dryRun) {
    return res.json({
      dry_run:     true,
      games_count: games.length,
      games:       games.map(g => ({
        id:           g.id,
        scheduled_at: g.scheduled_at,
        home_team:    g.home_team,
        away_team:    g.away_team,
      })),
    });
  }

  const results  = [];
  let filled     = 0;
  let notFound   = 0;

  for (const game of games) {
    try {
      const { lines } = await fetchHistoricalWildOddsFromESPN(game.scheduled_at, game.is_home);

      if (!lines || lines.length === 0) {
        results.push({ game_id: game.id, status: 'not_found' });
        notFound++;
      } else {
        // Upsert each bookmaker's lines
        for (const bm of lines) {
          upsertMetrics({
            game_id:                  game.id,
            bookmaker:                bm.bookmaker,
            opening_wild_moneyline:   null,
            closing_wild_moneyline:   null,
            opening_implied_prob:     null,
            closing_implied_prob:     null,
            clv:                      null,
            ev:                       null,
            closing_total_line:       bm.total_line,
            closing_over_odds:        bm.over_odds,
            closing_under_odds:       bm.under_odds,
            closing_wild_spread_odds: bm.wild_spread_odds,
            closing_opp_spread_odds:  bm.opp_spread_odds,
          });
        }

        // Compute total_result if we have a line and a final score
        const bestLine = lines.find(l => l.total_line != null);
        if (bestLine && game.wild_score != null) {
          const totalGoals = game.wild_score + game.opponent_score;
          let total_result = null;
          if (totalGoals > bestLine.total_line)      total_result = 'over';
          else if (totalGoals < bestLine.total_line) total_result = 'under';
          else                                        total_result = 'push';

          const goalDiff = game.wild_score - game.opponent_score;
          updateGameTotalResult(game.id, {
            total_result,
            puckline_minus_covered: game.result ? (goalDiff >= 2 ? 1 : 0) : null,
          });
        }

        results.push({ game_id: game.id, status: 'ok', bookmakers: lines.map(l => l.bookmaker) });
        filled++;
      }
    } catch (err) {
      results.push({ game_id: game.id, status: 'error', error: err.message });
    }

    // Small delay to be polite to the API
    await new Promise(r => setTimeout(r, 250));
  }

  return res.json({
    ok:        true,
    source:    'espn',
    total:     games.length,
    filled,
    not_found: notFound,
  });
});

/**
 * POST /admin/settle
 * Immediately attempt to settle all past unsettled games by fetching
 * their final scores from the NHL API.  Returns a count of how many
 * games were newly settled and how many remain unsettled.
 */
router.post('/admin/settle', requireAdminKey, async (req, res) => {
  const before = getSettlableGames().length;
  await settleGames();
  const after = getSettlableGames().length;
  const settled = before - after;
  return res.json({
    ok:       true,
    before,
    settled,
    remaining: after,
  });
});

/**
 * POST /sync
 * Immediately re-sync the Wild schedule from SportRadar.
 * Optional body: { "type": "REG" | "PST" }
 * Optional query: ?type=PST
 */
router.post('/sync', requireAdminKey, async (req, res) => {
  const raw  = (req.query.type ?? req.body?.type ?? 'REG').toString().toUpperCase();
  const type = ['REG', 'PST', 'PRE'].includes(raw) ? raw : 'REG';
  try {
    await syncSchedule(type);
    res.json({ ok: true, message: `Schedule synced (${type})` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /poll-odds
 * Immediately fetch and store the current odds snapshot.
 */
router.post('/poll-odds', requireAdminKey, async (_req, res) => {
  try {
    await pollOdds();
    res.json({ ok: true, message: 'Odds polled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /settle
 * Immediately attempt to settle all outstanding games.
 */
router.post('/settle', requireAdminKey, async (_req, res) => {
  try {
    await settleGames();
    res.json({ ok: true, message: 'Settle check complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Mount API router & serve built client ────────────────────────────────────

app.use('/api', router);

// Serve the built Vite client in production
const clientDist = path.join(__dirname, 'client', 'dist');
if (require('fs').existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`[server] Wild Odds Tracker listening on http://localhost:${PORT}`);
  startScheduler();
});
