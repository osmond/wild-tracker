'use strict';

const cron = require('node-cron');

const { fetchSeasonSchedule, fetchGameResult, fetchContextForWildGames, deriveSeasonYear } = require('./results-fetcher');
const { fetchWildOdds }                                           = require('./odds-fetcher');
const { sendSharpMoveAlert, sendSettleAlert } = require('./mailer');
const { calculateAndStoreMetrics }                                = require('./metrics');
const { determineResult }                                         = require('./calculator');
const {
  upsertGame,
  getGamesForDate,
  getSettlableGames,
  getAllGames,
  settleGame,
  updateGameContext,
  insertSnapshot,
  hasOpeningSnapshot,
  getLatestSnapshot,
  insertSharpMove,
  markSharpMoveAlerted,
  getSnapshotsByType,
} = require('./db');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** UTC date string 'YYYY-MM-DD' for right now. */
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Match an odds-API event to a stored game row.
 *
 * We match on:
 *   1. Same UTC calendar date (commence_time vs scheduled_at)
 *   2. Same home and away team name (case-insensitive)
 *
 * Both SportRadar and The Odds API use full team names like "Minnesota Wild",
 * so the comparison is reliable in practice.
 */
function matchOddsToGame(oddsEvent, dbGames) {
  const eventDate    = oddsEvent.commence_time.slice(0, 10);
  const homeTeamLow  = oddsEvent.home_team.toLowerCase();
  const awayTeamLow  = oddsEvent.away_team.toLowerCase();

  return dbGames.find(g => {
    const gameDate = g.scheduled_at.slice(0, 10);
    return (
      gameDate === eventDate &&
      g.home_team.toLowerCase() === homeTeamLow &&
      g.away_team.toLowerCase() === awayTeamLow
    );
  });
}

// ─── Job 1: Sync season schedule ─────────────────────────────────────────────

/**
 * Pull the full Wild schedule from SportRadar and upsert every game.
 * Only the status is protected from accidental downgrade once 'closed'.
 */
async function syncSchedule() {
  console.log('[scheduler] Syncing Wild schedule from SportRadar…');
  try {
    const year  = deriveSeasonYear();
    const games = await fetchSeasonSchedule(year);

    for (const g of games) {
      upsertGame(g);
    }
    console.log(`[scheduler] Synced ${games.length} Wild game(s) for the ${year} season.`);

    // Pull contextual data (days rest + opponent standings) and persist it.
    // This is a separate API call; failures here don't abort the schedule sync.
    try {
      const contextMap = await fetchContextForWildGames(year);
      let contextCount = 0;
      for (const [sportradarId, ctx] of Object.entries(contextMap)) {
        updateGameContext(sportradarId, ctx);
        contextCount++;
      }
      console.log(`[scheduler] Context updated for ${contextCount} game(s).`);
    } catch (ctxErr) {
      console.error('[scheduler] Context fetch failed (schedule sync still succeeded):', ctxErr.message);
    }
  } catch (err) {
    console.error('[scheduler] Schedule sync failed:', err.message);
  }
}

// ─── Job 2: Hourly odds poll ──────────────────────────────────────────────────

/**
 * Fetch current NHL odds from The Odds API and store a snapshot for every
 * Wild game on today's schedule.
 *
 * Snapshot type rules:
 *   - First snapshot ever for this game + bookmaker  → 'opening'
 *   - Within CLOSING_WINDOW_MINUTES of puck drop     → 'closing'
 *   - Anything else                                  → 'hourly'
 *
 * Snapshots are skipped once the game has already started (minutesToGame < 0).
 */
const CLOSING_WINDOW_MINUTES = 75; // mark final snapshot(s) before puck drop
const SHARP_MOVE_THRESHOLD   = 10; // American-odds points that trigger a sharp flag

async function pollOdds() {
  const today      = todayUTC();
  const todayGames = getGamesForDate(today);

  if (todayGames.length === 0) return;

  console.log(`[scheduler] Polling odds for ${todayGames.length} Wild game(s) today…`);

  try {
    const oddsData = await fetchWildOdds();
    const now      = new Date().toISOString();

    for (const odds of oddsData) {
      const game = matchOddsToGame(odds, todayGames);
      if (!game) continue;

      const gameTime     = new Date(odds.commence_time);
      const minsToGame   = (gameTime - Date.now()) / 60_000;

      // Don't snapshot once the puck is already in play
      if (minsToGame < 0) continue;

      // Get the most recent snapshot BEFORE inserting — used for both
      // duplicate-close suppression and sharp-move detection.
      const prevSnap = getLatestSnapshot(game.id, odds.bookmaker);

      // Determine snapshot type
      let snapshotType;
      if (!hasOpeningSnapshot(game.id, odds.bookmaker)) {
        snapshotType = 'opening';
      } else if (minsToGame <= CLOSING_WINDOW_MINUTES) {
        snapshotType = 'closing';
      } else {
        snapshotType = 'hourly';
      }

      // Skip duplicate closes if the odds haven't moved
      if (snapshotType === 'closing') {
        if (prevSnap && prevSnap.wild_moneyline === odds.wild_moneyline) continue;
      }

      insertSnapshot({
        game_id:           game.id,
        bookmaker:         odds.bookmaker,
        snapshot_type:     snapshotType,
        captured_at:       now,
        wild_moneyline:    odds.wild_moneyline,
        opp_moneyline:     odds.opp_moneyline,
        wild_implied_prob: odds.wild_implied_prob,
      });

      const sign = odds.wild_moneyline > 0 ? '+' : '';
      console.log(
        `[scheduler] [${snapshotType.padEnd(7)}] ${odds.bookmaker.padEnd(10)} ` +
        `Wild ${sign}${odds.wild_moneyline}  (${(odds.wild_implied_prob * 100).toFixed(1)}% true prob)`,
      );

      // ── Sharp-move detection ───────────────────────────────────────────
      if (prevSnap && snapshotType !== 'opening') {
        const moveSize = Math.abs(odds.wild_moneyline - prevSnap.wild_moneyline);
        if (moveSize >= SHARP_MOVE_THRESHOLD) {
          const moveRow = insertSharpMove({
            game_id:       game.id,
            bookmaker:     odds.bookmaker,
            detected_at:   now,
            old_moneyline: prevSnap.wild_moneyline,
            new_moneyline: odds.wild_moneyline,
            move_size:     moveSize,
          });

          const signOld = prevSnap.wild_moneyline > 0 ? '+' : '';
          console.log(
            `[scheduler] ⚠️  SHARP MOVE ${odds.bookmaker} ` +
            `${signOld}${prevSnap.wild_moneyline} → ${sign}${odds.wild_moneyline} (${moveSize} cents)`,
          );

          // Non-blocking email alert
          sendSharpMoveAlert({
            game,
            bookmaker:     odds.bookmaker,
            old_moneyline: prevSnap.wild_moneyline,
            new_moneyline: odds.wild_moneyline,
            move_size:     moveSize,
          })
            .then(() => markSharpMoveAlerted(moveRow.lastInsertRowid))
            .catch(err => console.error('[scheduler] Sharp move email failed:', err.message));
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] Odds poll failed:', err.message);
  }
}

// ─── Job 3: Settle completed games ───────────────────────────────────────────

/**
 * For every game whose puck drop was 2+ hours ago and isn't yet closed,
 * fetch the SportRadar summary and write the final score + result.
 * Metrics (CLV, EV) are recalculated immediately after settling.
 */
async function settleGames() {
  const candidates = getSettlableGames();
  if (candidates.length === 0) return;

  console.log(`[scheduler] Checking results for ${candidates.length} game(s)…`);

  for (const game of candidates) {
    try {
      const result = await fetchGameResult(game.sportradar_id);

      if (result.status !== 'closed') {
        console.log(`[scheduler] Game ${game.id} still in progress (status: ${result.status}).`);
        continue;
      }

      const isHome     = game.is_home === 1;
      const wildScore  = isHome ? result.home_score : result.away_score;
      const oppScore   = isHome ? result.away_score : result.home_score;
      const gameResult = determineResult(isHome, result.home_score, result.away_score);

      settleGame(game.id, {
        wild_score:     wildScore,
        opponent_score: oppScore,
        result:         gameResult,
        status:         'closed',
      });

      console.log(
        `[scheduler] Settled game ${game.id}: ` +
        `${game.home_team} vs ${game.away_team} — ` +
        `Wild ${wildScore}–${oppScore} (${gameResult ?? 'no result'})`,
      );

      // Recalculate CLV / EV now that closing line is locked in
      calculateAndStoreMetrics(game.id, game.my_moneyline);

      // Fetch updated metrics from DB for the alert
      const allGames = getAllGames();
      const settled  = allGames.find(g => g.id === game.id) ?? {};
      sendSettleAlert({
        game:       { ...game, wild_score: wildScore, opponent_score: oppScore, result: gameResult },
        pin_clv:    settled.pin_clv    ?? null,
        dk_clv:     settled.dk_clv     ?? null,
        fd_clv:     settled.fd_clv     ?? null,
        betmgm_clv: settled.betmgm_clv ?? null,
      }).catch(err => console.error('[scheduler] Settle email failed:', err.message));
    } catch (err) {
      console.error(`[scheduler] Failed to settle game ${game.sportradar_id}:`, err.message);
    }
  }
}

// ─── Cron registration ───────────────────────────────────────────────────────

/**
 * Register all three cron jobs and kick off an immediate schedule sync.
 *
 * Schedules (all times Central; adjust TZ env var if needed):
 *   06:00 daily  — sync season schedule from SportRadar
 *   :00 hourly   — capture odds snapshot (no-op on non-game days)
 *   :00 & :30    — attempt to settle completed games
 */
function start() {
  const TZ = process.env.CRON_TZ || 'America/Chicago';

  cron.schedule('0 6 * * *',    syncSchedule, { timezone: TZ });
  cron.schedule('0 * * * *',    pollOdds,     { timezone: TZ });
  cron.schedule('*/30 * * * *', settleGames);

  console.log(`[scheduler] Jobs registered (tz: ${TZ}).`);

  // Sync schedule immediately so the DB is populated before the first poll
  syncSchedule();
}

module.exports = { start, syncSchedule, pollOdds, settleGames };
