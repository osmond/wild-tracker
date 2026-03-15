'use strict';

const axios = require('axios');

// Uses the free, keyless NHL public API — no credentials required.
const BASE_URL    = 'https://api-web.nhle.com/v1';
const WILD_ABBREV = 'MIN';

/**
 * Derive the NHL season start year from a calendar date.
 * The season that starts in Oct 2025 and ends Jun 2026 is identified as 2025.
 *
 *   Jan–Jul  → previous calendar year  (still in the Y season)
 *   Aug–Dec  → current calendar year   (new season starting)
 */
function deriveSeasonYear(date = new Date()) {
  return date.getMonth() < 7 ? date.getFullYear() - 1 : date.getFullYear();
}

/** Build the NHL season code string, e.g. 2025 → '20252026'. */
function seasonCode(year) {
  return `${year}${year + 1}`;
}

/** Map an NHL API gameState/gameScheduleState to our status enum. */
function mapGameState(game) {
  const s = game.gameState ?? '';
  if (s === 'OFF' || s === 'FINAL') return 'closed';
  if (s === 'LIVE' || s === 'CRIT') return 'inprogress';
  return 'scheduled';
}

/**
 * Fetch all Minnesota Wild games from the NHL schedule API.
 *
 * @param {number} [year]        Season year (fall half). Defaults to current.
 * @param {string} [seasonType]  'REG' | 'PST' | 'PRE'. Defaults to REG.
 * @returns {Promise<Array>}  Normalised game objects ready for db.upsertGame()
 */
async function fetchSeasonSchedule(year = deriveSeasonYear(), seasonType = 'REG') {
  const url = `${BASE_URL}/club-schedule-season/${WILD_ABBREV}/${seasonCode(year)}`;
  const { data } = await axios.get(url, { timeout: 15_000 });

  // gameType: 1 = preseason, 2 = regular, 3 = playoffs
  const targetType = seasonType === 'PST' ? 3 : seasonType === 'PRE' ? 1 : 2;

  return (data.games ?? [])
    .filter(g => g.gameType === targetType)
    .map(g => ({
      sportradar_id: String(g.id),
      scheduled_at:  g.startTimeUTC,
      home_team:     g.homeTeam.name?.default ?? g.homeTeam.abbrev,
      away_team:     g.awayTeam.name?.default ?? g.awayTeam.abbrev,
      is_home:       g.homeTeam.abbrev === WILD_ABBREV ? 1 : 0,
      status:        mapGameState(g),
    }));
}

/**
 * Fetch the final score and status for a single game from the NHL API.
 *
 * @param {string} gameId  NHL game ID (stored in sportradar_id column)
 */
async function fetchGameResult(gameId) {
  const url = `${BASE_URL}/gamecenter/${gameId}/boxscore`;
  const { data } = await axios.get(url, { timeout: 15_000 });

  return {
    status:     mapGameState(data),
    home_alias: data.homeTeam?.abbrev ?? null,
    away_alias: data.awayTeam?.abbrev ?? null,
    home_score: data.homeTeam?.score  ?? null,
    away_score: data.awayTeam?.score  ?? null,
  };
}


/**
 * Fetch the full NHL schedule for all opponents and return a map:
 *   nhl_game_id → { wild_days_rest, opp_days_rest }
 */
async function fetchDaysRestMap(year = deriveSeasonYear(), seasonType = 'REG') {
  const code       = seasonCode(year);
  const targetType = seasonType === 'PST' ? 3 : seasonType === 'PRE' ? 1 : 2;

  const { data: wildData } = await axios.get(
    `${BASE_URL}/club-schedule-season/${WILD_ABBREV}/${code}`,
    { timeout: 20_000 },
  );
  const wildGames = (wildData.games ?? []).filter(g => g.gameType === targetType);

  // Sorted Wild game dates for days-rest calculation
  const wildDates = wildGames
    .map(g => ({ id: String(g.id), date: new Date(g.startTimeUTC) }))
    .sort((a, b) => a.date - b.date);

  // Unique opponents
  const opponentAbbrevs = [...new Set(wildGames.map(g =>
    g.homeTeam.abbrev === WILD_ABBREV ? g.awayTeam.abbrev : g.homeTeam.abbrev,
  ))];

  // Fetch each opponent's schedule in parallel
  const oppDateMap = {};
  await Promise.all(opponentAbbrevs.map(async abbrev => {
    try {
      const { data } = await axios.get(
        `${BASE_URL}/club-schedule-season/${abbrev}/${code}`,
        { timeout: 15_000 },
      );
      oppDateMap[abbrev] = (data.games ?? [])
        .filter(g => g.gameType === targetType)
        .map(g => ({ id: String(g.id), date: new Date(g.startTimeUTC) }))
        .sort((a, b) => a.date - b.date);
    } catch {
      oppDateMap[abbrev] = [];
    }
  }));

  const result = {};
  for (const game of wildGames) {
    const gameId   = String(game.id);
    const gameDate = new Date(game.startTimeUTC);
    const opp      = game.homeTeam.abbrev === WILD_ABBREV ? game.awayTeam.abbrev : game.homeTeam.abbrev;

    const prevWild = wildDates.filter(g => g.id !== gameId && g.date < gameDate).at(-1);
    const prevOpp  = (oppDateMap[opp] ?? []).filter(g => g.id !== gameId && g.date < gameDate).at(-1);

    result[gameId] = {
      wild_days_rest: prevWild ? Math.round((gameDate - prevWild.date) / 86_400_000) : null,
      opp_days_rest:  prevOpp  ? Math.round((gameDate - prevOpp.date)  / 86_400_000) : null,
    };
  }
  return result;
}

/**
 * Fetch current NHL standings and return a map: team abbrev → record object.
 */
async function fetchStandings() {
  const { data } = await axios.get(`${BASE_URL}/standings/now`, { timeout: 15_000 });

  const standingsMap = {};
  for (const team of (data.standings ?? [])) {
    const abbrev = team.teamAbbrev?.default ?? team.teamAbbrev;
    if (!abbrev) continue;

    // l10Record is a string like "7-2-1" (W-L-OTL)
    const l10parts = (team.l10Record ?? '').split('-').map(Number);

    standingsMap[abbrev] = {
      wins:          team.wins     ?? null,
      losses:        team.losses   ?? null,
      ot_losses:     team.otLosses ?? null,
      last10_wins:   l10parts[0]   ?? null,
      last10_losses: l10parts[1]   ?? null,
    };
  }
  return standingsMap;
}

/**
 * Combine fetchDaysRestMap + fetchStandings into one context map keyed by
 * NHL game ID (stored in the sportradar_id column), ready for db.updateGameContext().
 *
 * @returns {Promise<Object>}  nhl_game_id → context object
 */
async function fetchContextForWildGames(year = deriveSeasonYear(), seasonType = 'REG') {
  const code       = seasonCode(year);
  const targetType = seasonType === 'PST' ? 3 : seasonType === 'PRE' ? 1 : 2;

  const [daysRestMap, standingsMap] = await Promise.all([
    fetchDaysRestMap(year, seasonType),
    fetchStandings(),
  ]);

  const { data } = await axios.get(
    `${BASE_URL}/club-schedule-season/${WILD_ABBREV}/${code}`,
    { timeout: 15_000 },
  );

  const contextMap = {};
  for (const game of (data.games ?? [])) {
    if (game.gameType !== targetType) continue;
    const gameId  = String(game.id);
    const opp     = game.homeTeam.abbrev === WILD_ABBREV ? game.awayTeam.abbrev : game.homeTeam.abbrev;
    const oppRec  = standingsMap[opp] ?? {};
    const rest    = daysRestMap[gameId] ?? {};

    contextMap[gameId] = {
      wild_days_rest:    rest.wild_days_rest ?? null,
      opp_days_rest:     rest.opp_days_rest  ?? null,
      opp_wins:          oppRec.wins         ?? null,
      opp_losses:        oppRec.losses       ?? null,
      opp_ot_losses:     oppRec.ot_losses    ?? null,
      opp_last10_wins:   oppRec.last10_wins  ?? null,
      opp_last10_losses: oppRec.last10_losses ?? null,
    };
  }
  return contextMap;
}

module.exports = {
  fetchSeasonSchedule,
  fetchGameResult,
  fetchContextForWildGames,
  deriveSeasonYear,
};

