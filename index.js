'use strict';

require('dotenv').config();

const express = require('express');
const path    = require('path');

const { start: startScheduler }    = require('./src/scheduler');
const { syncSchedule, pollOdds, settleGames } = require('./src/scheduler');
const { calculateAndStoreMetrics } = require('./src/metrics');
const { americanToImplied }        = require('./src/calculator');
const {
  getAllGames,
  getGameById,
  getAllSnapshotsForGame,
  getSharpMovesForGame,
  getAllSharpMoves,
  setMyEstimate,
  insertOrUpdatePrediction,
  getCalibrationData,
  getStats,
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
 * Aggregate win rate, CLV%, average EV, and simple ROI across all
 * settled Wild games.
 */
router.get('/stats', (_req, res) => {
  const stats = getStats();
  res.json(stats);
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
 * POST /sync
 * Immediately re-sync the Wild schedule from SportRadar.
 */
router.post('/sync', requireAdminKey, async (_req, res) => {
  try {
    await syncSchedule();
    res.json({ ok: true, message: 'Schedule synced' });
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
