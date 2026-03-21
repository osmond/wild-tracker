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

// ─── Phase B schema migrations ────────────────────────────────────────────────

// games: settlement results for total and puck line
const GAMES_PHASE_B_COLUMNS = [
  'total_result           TEXT',    // null | 'over' | 'under' | 'push'
  'puckline_minus_covered INTEGER', // null | 0 | 1  (win by 2+)
];

// odds_snapshots: total and spread markets
const SNAPSHOTS_PHASE_B_COLUMNS = [
  'total_line       REAL',
  'over_odds        INTEGER',
  'under_odds       INTEGER',
  'spread_line      REAL',
  'wild_spread_odds INTEGER',
  'opp_spread_odds  INTEGER',
];

// game_metrics: total and spread opening/closing lines
const METRICS_PHASE_B_COLUMNS = [
  'opening_total_line      REAL',
  'closing_total_line      REAL',
  'opening_over_odds       INTEGER',
  'closing_over_odds       INTEGER',
  'opening_under_odds      INTEGER',
  'closing_under_odds      INTEGER',
  'opening_wild_spread_odds INTEGER',
  'closing_wild_spread_odds INTEGER',
  'opening_opp_spread_odds  INTEGER',
  'closing_opp_spread_odds  INTEGER',
];

for (const colDef of GAMES_PHASE_B_COLUMNS) {
  try { db.exec(`ALTER TABLE games ADD COLUMN ${colDef}`); } catch { /* exists */ }
}
for (const colDef of SNAPSHOTS_PHASE_B_COLUMNS) {
  try { db.exec(`ALTER TABLE odds_snapshots ADD COLUMN ${colDef}`); } catch { /* exists */ }
}
for (const colDef of METRICS_PHASE_B_COLUMNS) {
  try { db.exec(`ALTER TABLE game_metrics ADD COLUMN ${colDef}`); } catch { /* exists */ }
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

function settleGame(id, { wild_score, opponent_score, result, status, total_result, puckline_minus_covered }) {
  db.prepare(`
    UPDATE games
    SET wild_score              = @wild_score,
        opponent_score         = @opponent_score,
        result                 = @result,
        status                 = @status,
        total_result           = @total_result,
        puckline_minus_covered = @puckline_minus_covered,
        settled_at             = datetime('now'),
        updated_at             = datetime('now')
    WHERE id = @id
  `).run({
    id,
    wild_score,
    opponent_score,
    result,
    status,
    total_result:           total_result           ?? null,
    puckline_minus_covered: puckline_minus_covered ?? null,
  });
}

/**
 * Backfill total_result + puckline_minus_covered for an already-settled game.
 * Called by the manual entry API when a total line is posted for a closed game.
 */
function updateGameTotalResult(id, { total_result, puckline_minus_covered }) {
  db.prepare(`
    UPDATE games
    SET total_result           = @total_result,
        puckline_minus_covered = @puckline_minus_covered,
        updated_at             = datetime('now')
    WHERE id = @id
  `).run({ id, total_result: total_result ?? null, puckline_minus_covered: puckline_minus_covered ?? null });
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
    (game_id, bookmaker, snapshot_type, captured_at,
     wild_moneyline, opp_moneyline, wild_implied_prob,
     total_line, over_odds, under_odds,
     spread_line, wild_spread_odds, opp_spread_odds)
  VALUES
    (@game_id, @bookmaker, @snapshot_type, @captured_at,
     @wild_moneyline, @opp_moneyline, @wild_implied_prob,
     @total_line, @over_odds, @under_odds,
     @spread_line, @wild_spread_odds, @opp_spread_odds)
`);

function insertSnapshot(s) {
  return stmtInsertSnapshot.run({
    total_line:       null,
    over_odds:        null,
    under_odds:       null,
    spread_line:      null,
    wild_spread_odds: null,
    opp_spread_odds:  null,
    ...s,
  });
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
      (game_id, bookmaker,
       opening_wild_moneyline, closing_wild_moneyline,
       opening_implied_prob, closing_implied_prob,
       clv, ev,
       opening_total_line, closing_total_line,
       opening_over_odds,  closing_over_odds,
       opening_under_odds, closing_under_odds,
       opening_wild_spread_odds, closing_wild_spread_odds,
       opening_opp_spread_odds,  closing_opp_spread_odds,
       calculated_at)
    VALUES
      (@game_id, @bookmaker,
       @opening_wild_moneyline, @closing_wild_moneyline,
       @opening_implied_prob,   @closing_implied_prob,
       @clv, @ev,
       @opening_total_line,      @closing_total_line,
       @opening_over_odds,       @closing_over_odds,
       @opening_under_odds,      @closing_under_odds,
       @opening_wild_spread_odds, @closing_wild_spread_odds,
       @opening_opp_spread_odds,  @closing_opp_spread_odds,
       datetime('now'))
    ON CONFLICT(game_id, bookmaker) DO UPDATE SET
      opening_wild_moneyline    = excluded.opening_wild_moneyline,
      closing_wild_moneyline    = excluded.closing_wild_moneyline,
      opening_implied_prob      = excluded.opening_implied_prob,
      closing_implied_prob      = excluded.closing_implied_prob,
      clv                       = excluded.clv,
      ev                        = excluded.ev,
      opening_total_line        = COALESCE(excluded.opening_total_line,        opening_total_line),
      closing_total_line        = COALESCE(excluded.closing_total_line,        closing_total_line),
      opening_over_odds         = COALESCE(excluded.opening_over_odds,         opening_over_odds),
      closing_over_odds         = COALESCE(excluded.closing_over_odds,         closing_over_odds),
      opening_under_odds        = COALESCE(excluded.opening_under_odds,        opening_under_odds),
      closing_under_odds        = COALESCE(excluded.closing_under_odds,        closing_under_odds),
      opening_wild_spread_odds  = COALESCE(excluded.opening_wild_spread_odds,  opening_wild_spread_odds),
      closing_wild_spread_odds  = COALESCE(excluded.closing_wild_spread_odds,  closing_wild_spread_odds),
      opening_opp_spread_odds   = COALESCE(excluded.opening_opp_spread_odds,   opening_opp_spread_odds),
      closing_opp_spread_odds   = COALESCE(excluded.closing_opp_spread_odds,   closing_opp_spread_odds),
      calculated_at             = excluded.calculated_at
  `).run({
    opening_total_line:       null,
    closing_total_line:       null,
    opening_over_odds:        null,
    closing_over_odds:        null,
    opening_under_odds:       null,
    closing_under_odds:       null,
    opening_wild_spread_odds: null,
    closing_wild_spread_odds: null,
    opening_opp_spread_odds:  null,
    closing_opp_spread_odds:  null,
    ...m,
  });
}

/**
 * Upsert a manually-entered total / spread line for a specific game.
 * bookmaker is always 'manual'; used by POST /games/:id/total-line.
 */
function upsertManualLine(gameId, { total_line, over_odds, under_odds, wild_spread_odds, opp_spread_odds }) {
  db.prepare(`
    INSERT INTO game_metrics
      (game_id, bookmaker,
       closing_total_line, closing_over_odds, closing_under_odds,
       closing_wild_spread_odds, closing_opp_spread_odds,
       calculated_at)
    VALUES
      (@game_id, 'manual',
       @total_line, @over_odds, @under_odds,
       @wild_spread_odds, @opp_spread_odds,
       datetime('now'))
    ON CONFLICT(game_id, bookmaker) DO UPDATE SET
      closing_total_line       = COALESCE(@total_line,       closing_total_line),
      closing_over_odds        = COALESCE(@over_odds,        closing_over_odds),
      closing_under_odds       = COALESCE(@under_odds,       closing_under_odds),
      closing_wild_spread_odds = COALESCE(@wild_spread_odds, closing_wild_spread_odds),
      closing_opp_spread_odds  = COALESCE(@opp_spread_odds,  closing_opp_spread_odds),
      calculated_at            = datetime('now')
  `).run({
    game_id:          gameId,
    total_line:       total_line       ?? null,
    over_odds:        over_odds        ?? null,
    under_odds:       under_odds       ?? null,
    wild_spread_odds: wild_spread_odds ?? null,
    opp_spread_odds:  opp_spread_odds  ?? null,
  });
}

// ─── Dollar Bet Tracker ───────────────────────────────────────────────────────

/**
 * Returns every Wild game with the best available moneyline for a hypothetical
 * $1 bet on the Wild:
 *   - Settled games  → prefer closing line, fall back to opening
 *   - Upcoming games → prefer opening line (closing not yet available)
 * Ordered chronologically (oldest first) so callers can compute a running P&L.
 */
function getDollarBetGames() {
  return db.prepare(`
    SELECT
      g.id,
      g.scheduled_at,
      g.home_team,
      g.away_team,
      g.is_home,
      g.status,
      g.result,
      g.wild_score,
      g.opponent_score,
      COALESCE(
        pin.closing_wild_moneyline, dk.closing_wild_moneyline,
        fd.closing_wild_moneyline,  bm.closing_wild_moneyline,
        pin.opening_wild_moneyline, dk.opening_wild_moneyline,
        fd.opening_wild_moneyline,  bm.opening_wild_moneyline
      ) AS bet_ml
    FROM games g
    LEFT JOIN game_metrics pin ON pin.game_id = g.id AND pin.bookmaker = 'pinnacle'
    LEFT JOIN game_metrics dk  ON dk.game_id  = g.id AND dk.bookmaker  = 'draftkings'
    LEFT JOIN game_metrics fd  ON fd.game_id  = g.id AND fd.bookmaker  = 'fanduel'
    LEFT JOIN game_metrics bm  ON bm.game_id  = g.id AND bm.bookmaker  = 'betmgm'
    ORDER BY g.scheduled_at ASC
  `).all();
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

  // Include current streak inline so the stats endpoint returns everything
  const streakGames = db.prepare(`
    SELECT result FROM games
    WHERE result IS NOT NULL
    ORDER BY scheduled_at DESC
  `).all();
  let streak = { type: null, count: 0 };
  if (streakGames.length) {
    const first = streakGames[0].result;
    let count = 0;
    for (const g of streakGames) {
      if (g.result === first) count++;
      else break;
    }
    streak = { type: first, count };
  }

  return { ...summary, roi_pct: roi, streak };
}

// ─── Puck Line Tracker ───────────────────────────────────────────────────────

/**
 * Returns every Wild game with derived puck line coverage results.
 * covers_minus_1_5: Wild won by 2+ (covers -1.5 favourite line)
 * covers_plus_1_5:  Wild won OR lost by exactly 1 (covers +1.5 dog line)
 * total_goals:      combined final score
 * Ordered chronologically so callers can compute a running record.
 */
function getPuckLineGames() {
  return db.prepare(`
    SELECT
      g.id,
      g.scheduled_at,
      g.home_team,
      g.away_team,
      g.is_home,
      g.status,
      g.result,
      g.wild_score,
      g.opponent_score,
      g.wild_days_rest,
      g.opp_wins,
      g.opp_losses,
      g.opp_ot_losses,
      CASE WHEN g.wild_score IS NOT NULL
        THEN g.wild_score - g.opponent_score
      END AS goal_diff,
      CASE WHEN g.wild_score IS NOT NULL
        THEN CASE WHEN (g.wild_score - g.opponent_score) >= 2 THEN 1 ELSE 0 END
      END AS covers_minus_1_5,
      CASE WHEN g.wild_score IS NOT NULL
        THEN CASE WHEN (g.wild_score - g.opponent_score) >= -1 THEN 1 ELSE 0 END
      END AS covers_plus_1_5,
      CASE WHEN g.wild_score IS NOT NULL
        THEN g.wild_score + g.opponent_score
      END AS total_goals,
      gm.closing_wild_spread_odds,
      gm.closing_opp_spread_odds
    FROM games g
    LEFT JOIN game_metrics gm ON gm.game_id = g.id
    ORDER BY g.scheduled_at ASC
  `).all();
}

// ─── Splits ──────────────────────────────────────────────────────────────────

/**
 * Home/Away, back-to-back, and opponent-strength W/L splits.
 */
function getSplits() {
  const haRows = db.prepare(`
    SELECT
      is_home,
      SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
    FROM games
    WHERE result IS NOT NULL
    GROUP BY is_home
  `).all();

  const home = haRows.find(r => r.is_home === 1) ?? { wins: 0, losses: 0 };
  const away = haRows.find(r => r.is_home === 0) ?? { wins: 0, losses: 0 };

  const b2b = db.prepare(`
    SELECT
      SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
    FROM games
    WHERE wild_days_rest = 1 AND result IS NOT NULL
  `).get();

  const vsWinning = db.prepare(`
    SELECT
      SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
    FROM games
    WHERE result IS NOT NULL
      AND opp_wins IS NOT NULL
      AND (opp_wins * 1.0 / NULLIF(opp_wins + opp_losses + opp_ot_losses, 0)) >= 0.5
  `).get();

  const vsLosing = db.prepare(`
    SELECT
      SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
    FROM games
    WHERE result IS NOT NULL
      AND opp_wins IS NOT NULL
      AND (opp_wins * 1.0 / NULLIF(opp_wins + opp_losses + opp_ot_losses, 0)) < 0.5
  `).get();

  return {
    home:       { wins: home.wins ?? 0,        losses: home.losses ?? 0 },
    away:       { wins: away.wins ?? 0,        losses: away.losses ?? 0 },
    b2b:        { wins: b2b?.wins ?? 0,        losses: b2b?.losses ?? 0 },
    vs_winning: { wins: vsWinning?.wins ?? 0,  losses: vsWinning?.losses ?? 0 },
    vs_losing:  { wins: vsLosing?.wins ?? 0,   losses: vsLosing?.losses ?? 0 },
    last10:     computeLast10(),
  };
}

function computeLast10() {
  const rows = db.prepare(`
    SELECT result FROM games
    WHERE result IS NOT NULL
    ORDER BY scheduled_at DESC
    LIMIT 10
  `).all();
  const wins   = rows.filter(r => r.result === 'win').length;
  const losses = rows.filter(r => r.result === 'loss').length;
  return { wins, losses };
}

// ─── Current Streak ──────────────────────────────────────────────────────────

function getCurrentStreak() {
  const games = db.prepare(`
    SELECT result FROM games
    WHERE result IS NOT NULL
    ORDER BY scheduled_at DESC
  `).all();

  if (!games.length) return { type: null, count: 0 };
  const first = games[0].result;
  let count = 0;
  for (const g of games) {
    if (g.result === first) count++;
    else break;
  }
  return { type: first, count };
}

// ─── O/U Tracker ─────────────────────────────────────────────────────────────

/**
 * Returns every Wild game with:
 *   - total_goals (derived from final score)
 *   - best closing total_line (prefer pinnacle → dk → fd → betmgm → manual)
 *   - best closing over/under odds (same preference)
 *   - total_result already stored on the game row  ('over'|'under'|'push'|null)
 * Ordered chronologically so callers can build running P&L curves.
 */
function getOUTrackerGames() {
  return db.prepare(`
    SELECT
      g.id,
      g.scheduled_at,
      g.home_team,
      g.away_team,
      g.is_home,
      g.status,
      g.result,
      g.wild_score,
      g.opponent_score,
      g.total_result,
      CASE WHEN g.wild_score IS NOT NULL
           THEN g.wild_score + g.opponent_score
           ELSE NULL
      END AS total_goals,
      COALESCE(
        pin.closing_total_line, dk.closing_total_line,
        fd.closing_total_line,  bm.closing_total_line,
        man.closing_total_line
      ) AS total_line,
      COALESCE(
        pin.closing_over_odds, dk.closing_over_odds,
        fd.closing_over_odds,  bm.closing_over_odds,
        man.closing_over_odds
      ) AS over_odds,
      COALESCE(
        pin.closing_under_odds, dk.closing_under_odds,
        fd.closing_under_odds,  bm.closing_under_odds,
        man.closing_under_odds
      ) AS under_odds
    FROM games g
    LEFT JOIN game_metrics pin ON pin.game_id = g.id AND pin.bookmaker = 'pinnacle'
    LEFT JOIN game_metrics dk  ON dk.game_id  = g.id AND dk.bookmaker  = 'draftkings'
    LEFT JOIN game_metrics fd  ON fd.game_id  = g.id AND fd.bookmaker  = 'fanduel'
    LEFT JOIN game_metrics bm  ON bm.game_id  = g.id AND bm.bookmaker  = 'betmgm'
    LEFT JOIN game_metrics man ON man.game_id  = g.id AND man.bookmaker = 'manual'
    ORDER BY g.scheduled_at ASC
  `).all();
}

// ─── Odds Backfill ────────────────────────────────────────────────────────────

/**
 * Returns all settled games that have no closing total line in game_metrics.
 * Used by the automated odds backfill route.
 */
function getGamesNeedingOddsBackfill() {
  return db.prepare(`
    SELECT g.id, g.scheduled_at, g.home_team, g.away_team, g.is_home,
           g.wild_score, g.opponent_score, g.result
    FROM games g
    WHERE g.status = 'closed'
      AND g.id NOT IN (
        SELECT DISTINCT game_id FROM game_metrics
        WHERE closing_total_line IS NOT NULL
      )
    ORDER BY g.scheduled_at ASC
  `).all();
}

/** Closed games that have no entries in odds_snapshots at all. */
function getGamesNeedingSnapshotBackfill() {
  return db.prepare(`
    SELECT g.id, g.scheduled_at, g.home_team, g.away_team, g.is_home
    FROM games g
    WHERE g.status = 'closed'
      AND g.id NOT IN (
        SELECT DISTINCT game_id FROM odds_snapshots
      )
    ORDER BY g.scheduled_at ASC
  `).all();
}

module.exports = {
  db,
  upsertGame,
  getGameById,
  getGameBySportradarId,
  getGamesForDate,
  getSettlableGames,
  settleGame,
  updateGameTotalResult,
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
  upsertManualLine,
  insertSharpMove,
  markSharpMoveAlerted,
  getSharpMovesForGame,
  insertOrUpdatePrediction,
  getCalibrationData,
  getDollarBetGames,
  getStats,
  getPuckLineGames,
  getSplits,
  getCurrentStreak,
  getOUTrackerGames,
  getGamesNeedingOddsBackfill,
  getGamesNeedingSnapshotBackfill,
};
