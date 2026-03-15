'use strict';

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.resolve(process.env.DB_PATH || './data/wild.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sportradar_id  TEXT    UNIQUE NOT NULL,
    scheduled_at   TEXT    NOT NULL,
    home_team      TEXT    NOT NULL,
    away_team      TEXT    NOT NULL,
    is_home        INTEGER NOT NULL DEFAULT 0,
    status         TEXT    NOT NULL DEFAULT 'scheduled',
    wild_score     INTEGER,
    opponent_score INTEGER,
    result         TEXT,
    my_moneyline   INTEGER,
    settled_at     TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  /*
   * One row per hourly fetch per bookmaker per game.
   * snapshot_type: 'opening' | 'hourly' | 'closing'
   * wild_implied_prob is de-juiced (vig removed).
   */
  CREATE TABLE IF NOT EXISTS odds_snapshots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id          INTEGER NOT NULL,
    bookmaker        TEXT    NOT NULL,
    snapshot_type    TEXT    NOT NULL DEFAULT 'hourly',
    captured_at      TEXT    NOT NULL,
    wild_moneyline   INTEGER NOT NULL,
    opp_moneyline    INTEGER NOT NULL,
    wild_implied_prob REAL   NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  /*
   * One row per bookmaker per game; upserted after settling and whenever
   * the user updates their estimate.
   */
  CREATE TABLE IF NOT EXISTS game_metrics (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id                INTEGER NOT NULL,
    bookmaker              TEXT    NOT NULL,
    opening_wild_moneyline INTEGER,
    closing_wild_moneyline INTEGER,
    opening_implied_prob   REAL,
    closing_implied_prob   REAL,
    clv                    REAL,
    ev                     REAL,
    calculated_at          TEXT,
    UNIQUE(game_id, bookmaker),
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  CREATE TABLE IF NOT EXISTS sharp_move_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         INTEGER NOT NULL,
    bookmaker       TEXT    NOT NULL,
    detected_at     TEXT    NOT NULL,
    old_moneyline   INTEGER NOT NULL,
    new_moneyline   INTEGER NOT NULL,
    move_size       INTEGER NOT NULL,
    alerted         INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  /*
   * One row per game; upserted when POST /games/:id/predict is called.
   * my_prob is the user's (or model's) pre-game win probability for Wild.
   */
  CREATE TABLE IF NOT EXISTS model_predictions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL UNIQUE,
    my_prob     REAL    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (game_id) REFERENCES games(id)
  );

  CREATE INDEX IF NOT EXISTS idx_games_scheduled    ON games(scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_snapshots_game_bm ON odds_snapshots(game_id, bookmaker, captured_at);
  CREATE INDEX IF NOT EXISTS idx_sharp_moves_game   ON sharp_move_events(game_id, detected_at);
`);

// ─── Schema migrations (safe to run on existing databases) ───────────────────

const GAME_CONTEXT_COLUMNS = [
  'wild_days_rest   INTEGER',
  'opp_days_rest    INTEGER',
  'opp_wins         INTEGER',
  'opp_losses       INTEGER',
  'opp_ot_losses    INTEGER',
  'opp_last10_wins  INTEGER',
  'opp_last10_losses INTEGER',
  'context_updated_at TEXT',
];

for (const colDef of GAME_CONTEXT_COLUMNS) {
  try {
    db.exec(`ALTER TABLE games ADD COLUMN ${colDef}`);
  } catch {
    // Column already exists — safe to ignore
  }
}


// ─── Games ────────────────────────────────────────────────────────────────────

const stmtUpsertGame = db.prepare(`
  INSERT INTO games (sportradar_id, scheduled_at, home_team, away_team, is_home, status)
  VALUES (@sportradar_id, @scheduled_at, @home_team, @away_team, @is_home, @status)
  ON CONFLICT(sportradar_id) DO UPDATE SET
    scheduled_at = excluded.scheduled_at,
    home_team    = excluded.home_team,
    away_team    = excluded.away_team,
    is_home      = excluded.is_home,
    status       = CASE
                     WHEN games.status = 'closed' THEN games.status
                     ELSE excluded.status
                   END,
    updated_at   = datetime('now')
`);

function upsertGame(g) {
  return stmtUpsertGame.run(g);
}

function getGameById(id) {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(id);
}

function getGameBySportradarId(sportradarId) {
  return db.prepare('SELECT * FROM games WHERE sportradar_id = ?').get(sportradarId);
}

/** Returns all Wild games for a given calendar date (UTC, 'YYYY-MM-DD'). */
function getGamesForDate(dateStr) {
  return db.prepare(`
    SELECT * FROM games
    WHERE date(scheduled_at) = ?
    ORDER BY scheduled_at
  `).all(dateStr);
}

/**
 * Returns games whose scheduled start was more than 2 hours ago but are
 * not yet marked as closed — these are candidates to fetch final scores.
 */
function getSettlableGames() {
  return db.prepare(`
    SELECT * FROM games
    WHERE result IS NULL
      AND datetime(scheduled_at) < datetime('now', '-2 hours')
    ORDER BY scheduled_at
  `).all();
}

function settleGame(id, { wild_score, opponent_score, result, status }) {
  db.prepare(`
    UPDATE games
    SET wild_score     = @wild_score,
        opponent_score = @opponent_score,
        result         = @result,
        status         = @status,
        settled_at     = datetime('now'),
        updated_at     = datetime('now')
    WHERE id = @id
  `).run({ id, wild_score, opponent_score, result, status });
}

/**
 * Store the user's opening probability estimate as an American moneyline.
 * The raw (vig-inclusive) implied probability is stored alongside so callers
 * don't need to recompute it on every read.
 */
function setMyEstimate(gameId, moneyline) {
  db.prepare(`
    UPDATE games
    SET my_moneyline = @moneyline,
        updated_at   = datetime('now')
    WHERE id = @gameId
  `).run({ gameId, moneyline });
}

/**
 * All Wild games joined with per-bookmaker metrics to expose in the REST API.
 * Includes Pinnacle, DraftKings, FanDuel, and BetMGM columns.
 */
function getAllGames() {
  return db.prepare(`
    SELECT
      g.*,
      mp.my_prob                 AS model_prob,
      pin.opening_wild_moneyline AS pin_opening_ml,
      pin.closing_wild_moneyline AS pin_closing_ml,
      pin.opening_implied_prob   AS pin_opening_prob,
      pin.closing_implied_prob   AS pin_closing_prob,
      pin.clv                    AS pin_clv,
      pin.ev                     AS pin_ev,
      dk.opening_wild_moneyline  AS dk_opening_ml,
      dk.closing_wild_moneyline  AS dk_closing_ml,
      dk.opening_implied_prob    AS dk_opening_prob,
      dk.closing_implied_prob    AS dk_closing_prob,
      dk.clv                     AS dk_clv,
      dk.ev                      AS dk_ev,
      fd.opening_wild_moneyline  AS fd_opening_ml,
      fd.closing_wild_moneyline  AS fd_closing_ml,
      fd.opening_implied_prob    AS fd_opening_prob,
      fd.closing_implied_prob    AS fd_closing_prob,
      fd.clv                     AS fd_clv,
      fd.ev                      AS fd_ev,
      bm.opening_wild_moneyline  AS betmgm_opening_ml,
      bm.closing_wild_moneyline  AS betmgm_closing_ml,
      bm.opening_implied_prob    AS betmgm_opening_prob,
      bm.closing_implied_prob    AS betmgm_closing_prob,
      bm.clv                     AS betmgm_clv,
      bm.ev                      AS betmgm_ev
    FROM games g
    LEFT JOIN model_predictions mp  ON mp.game_id  = g.id
    LEFT JOIN game_metrics pin ON pin.game_id = g.id AND pin.bookmaker = 'pinnacle'
    LEFT JOIN game_metrics dk  ON dk.game_id  = g.id AND dk.bookmaker  = 'draftkings'
    LEFT JOIN game_metrics fd  ON fd.game_id  = g.id AND fd.bookmaker  = 'fanduel'
    LEFT JOIN game_metrics bm  ON bm.game_id  = g.id AND bm.bookmaker  = 'betmgm'
    ORDER BY g.scheduled_at DESC
  `).all();
}

// ─── Game Context ─────────────────────────────────────────────────────────────

function updateGameContext(sportradarId, ctx) {
  db.prepare(`
    UPDATE games
    SET wild_days_rest      = @wild_days_rest,
        opp_days_rest       = @opp_days_rest,
        opp_wins            = @opp_wins,
        opp_losses          = @opp_losses,
        opp_ot_losses       = @opp_ot_losses,
        opp_last10_wins     = @opp_last10_wins,
        opp_last10_losses   = @opp_last10_losses,
        context_updated_at  = datetime('now'),
        updated_at          = datetime('now')
    WHERE sportradar_id = @sportradar_id
  `).run({ sportradar_id: sportradarId, ...ctx });
}

// ─── Odds Snapshots ──────────────────────────────────────────────────────────

const stmtInsertSnapshot = db.prepare(`
  INSERT INTO odds_snapshots
    (game_id, bookmaker, snapshot_type, captured_at, wild_moneyline, opp_moneyline, wild_implied_prob)
  VALUES
    (@game_id, @bookmaker, @snapshot_type, @captured_at, @wild_moneyline, @opp_moneyline, @wild_implied_prob)
`);

function insertSnapshot(s) {
  return stmtInsertSnapshot.run(s);
}

function hasOpeningSnapshot(gameId, bookmaker) {
  const row = db.prepare(`
    SELECT id FROM odds_snapshots
    WHERE game_id = ? AND bookmaker = ? AND snapshot_type = 'opening'
    LIMIT 1
  `).get(gameId, bookmaker);
  return !!row;
}

/** Latest snapshot for a game + bookmaker (most recently captured). */
function getLatestSnapshot(gameId, bookmaker) {
  return db.prepare(`
    SELECT * FROM odds_snapshots
    WHERE game_id = ? AND bookmaker = ?
    ORDER BY captured_at DESC
    LIMIT 1
  `).get(gameId, bookmaker);
}

/**
 * All snapshots of a given type for a game + bookmaker.
 * Returned newest-first so index [0] = most recent, last index = oldest.
 */
function getSnapshotsByType(gameId, bookmaker, type) {
  return db.prepare(`
    SELECT * FROM odds_snapshots
    WHERE game_id = ? AND bookmaker = ? AND snapshot_type = ?
    ORDER BY captured_at DESC
  `).all(gameId, bookmaker, type);
}

/** Full snapshot history for a game (all bookmakers), for the REST detail endpoint. */
function getAllSnapshotsForGame(gameId) {
  return db.prepare(`
    SELECT * FROM odds_snapshots
    WHERE game_id = ?
    ORDER BY bookmaker, captured_at
  `).all(gameId);
}

// ─── Sharp Moves ─────────────────────────────────────────────────────────────

function insertSharpMove(ev) {
  return db.prepare(`
    INSERT INTO sharp_move_events
      (game_id, bookmaker, detected_at, old_moneyline, new_moneyline, move_size)
    VALUES
      (@game_id, @bookmaker, @detected_at, @old_moneyline, @new_moneyline, @move_size)
  `).run(ev);
}

function markSharpMoveAlerted(id) {
  db.prepare('UPDATE sharp_move_events SET alerted = 1 WHERE id = ?').run(id);
}

function getSharpMovesForGame(gameId) {
  return db.prepare(`
    SELECT * FROM sharp_move_events
    WHERE game_id = ?
    ORDER BY detected_at
  `).all(gameId);
}

/** All sharp move events across every game, joined with game context. */
function getAllSharpMoves() {
  return db.prepare(`
    SELECT
      s.*,
      g.scheduled_at  AS game_scheduled_at,
      g.home_team     AS game_home_team,
      g.away_team     AS game_away_team,
      g.is_home       AS game_is_home
    FROM sharp_move_events s
    JOIN games g ON g.id = s.game_id
    ORDER BY s.detected_at DESC
  `).all();
}

// ─── Model Predictions ────────────────────────────────────────────────────────

function insertOrUpdatePrediction(gameId, myProb) {
  db.prepare(`
    INSERT INTO model_predictions (game_id, my_prob)
    VALUES (@gameId, @myProb)
    ON CONFLICT(game_id) DO UPDATE SET
      my_prob    = excluded.my_prob,
      updated_at = datetime('now')
  `).run({ gameId, myProb });
}

/**
 * Returns all (my_prob, outcome) pairs for settled games — used to plot
 * a calibration curve.
 *
 * outcome: 1 = Wild win, 0 = Wild loss.
 */
function getCalibrationData() {
  return db.prepare(`
    SELECT
      g.id          AS game_id,
      g.scheduled_at,
      g.home_team,
      g.away_team,
      g.result,
      CASE WHEN g.result = 'win' THEN 1
           WHEN g.result = 'loss' THEN 0
           ELSE NULL
      END           AS outcome,
      mp.my_prob
    FROM model_predictions mp
    JOIN games g ON g.id = mp.game_id
    ORDER BY g.scheduled_at
  `).all();
}

// ─── Game Metrics ─────────────────────────────────────────────────────────────

function upsertMetrics(m) {
  db.prepare(`
    INSERT INTO game_metrics
      (game_id, bookmaker, opening_wild_moneyline, closing_wild_moneyline,
       opening_implied_prob, closing_implied_prob, clv, ev, calculated_at)
    VALUES
      (@game_id, @bookmaker, @opening_wild_moneyline, @closing_wild_moneyline,
       @opening_implied_prob, @closing_implied_prob, @clv, @ev, datetime('now'))
    ON CONFLICT(game_id, bookmaker) DO UPDATE SET
      opening_wild_moneyline = excluded.opening_wild_moneyline,
      closing_wild_moneyline = excluded.closing_wild_moneyline,
      opening_implied_prob   = excluded.opening_implied_prob,
      closing_implied_prob   = excluded.closing_implied_prob,
      clv                    = excluded.clv,
      ev                     = excluded.ev,
      calculated_at          = excluded.calculated_at
  `).run(m);
}

// ─── Aggregate Stats ──────────────────────────────────────────────────────────

function getStats() {
  const summary = db.prepare(`
    SELECT
      COUNT(*)                                                         AS total_games,
      SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END)             AS settled_games,
      SUM(CASE WHEN result = 'win'     THEN 1 ELSE 0 END)             AS wins,
      SUM(CASE WHEN result = 'loss'    THEN 1 ELSE 0 END)             AS losses,
      ROUND(
        AVG(CASE WHEN result IS NOT NULL
              THEN CASE WHEN result = 'win' THEN 1.0 ELSE 0.0 END
            END) * 100, 2
      )                                                                AS win_rate_pct,
      ROUND(AVG(pin.clv), 4)                                          AS avg_clv_pinnacle,
      ROUND(AVG(dk.clv),  4)                                          AS avg_clv_draftkings,
      ROUND(AVG(fd.clv),  4)                                          AS avg_clv_fanduel,
      ROUND(AVG(bm.clv),  4)                                          AS avg_clv_betmgm,
      ROUND(AVG(pin.ev),  4)                                          AS avg_ev_pinnacle,
      ROUND(AVG(dk.ev),   4)                                          AS avg_ev_draftkings,
      ROUND(AVG(fd.ev),   4)                                          AS avg_ev_fanduel,
      ROUND(AVG(bm.ev),   4)                                          AS avg_ev_betmgm
    FROM games g
    LEFT JOIN game_metrics pin ON pin.game_id = g.id AND pin.bookmaker = 'pinnacle'
    LEFT JOIN game_metrics dk  ON dk.game_id  = g.id AND dk.bookmaker  = 'draftkings'
    LEFT JOIN game_metrics fd  ON fd.game_id  = g.id AND fd.bookmaker  = 'fanduel'
    LEFT JOIN game_metrics bm  ON bm.game_id  = g.id AND bm.bookmaker  = 'betmgm'
  `).get();

  // ROI: assume 1 unit per game, settled at Pinnacle closing line.
  // Falls back to DraftKings if Pinnacle closing not available.
  const closedRows = db.prepare(`
    SELECT
      g.result,
      COALESCE(pin.closing_wild_moneyline, dk.closing_wild_moneyline) AS closing_ml
    FROM games g
    LEFT JOIN game_metrics pin ON pin.game_id = g.id AND pin.bookmaker = 'pinnacle'
    LEFT JOIN game_metrics dk  ON dk.game_id  = g.id AND dk.bookmaker  = 'draftkings'
    WHERE g.result IS NOT NULL
      AND COALESCE(pin.closing_wild_moneyline, dk.closing_wild_moneyline) IS NOT NULL
  `).all();

  const { americanToDecimal } = require('./calculator');
  let totalStake  = 0;
  let totalReturn = 0;

  for (const row of closedRows) {
    totalStake += 1;
    if (row.result === 'win') {
      totalReturn += americanToDecimal(row.closing_ml);
    }
  }

  const roi = totalStake > 0
    ? parseFloat(((totalReturn - totalStake) / totalStake * 100).toFixed(2))
    : null;

  return { ...summary, roi_pct: roi };
}

module.exports = {
  db,
  upsertGame,
  getGameById,
  getGameBySportradarId,
  getGamesForDate,
  getSettlableGames,
  settleGame,
  setMyEstimate,
  updateGameContext,
  getAllGames,
  insertSnapshot,
  hasOpeningSnapshot,
  getLatestSnapshot,
  getSnapshotsByType,
  getAllSnapshotsForGame,
  getAllSharpMoves,
  upsertMetrics,
  insertSharpMove,
  markSharpMoveAlerted,
  getSharpMovesForGame,
  insertOrUpdatePrediction,
  getCalibrationData,
  getStats,
};
