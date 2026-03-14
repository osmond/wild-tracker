'use strict';

const axios = require('axios');

const BASE_URL   = 'https://api.sportradar.us/nhl/trial/v8/en';
const WILD_ALIAS = 'MIN';

/**
 * Derive the SportRadar season year from a calendar date.
 *
 * The NHL season starts in October of year Y and runs through June of Y+1.
 * SportRadar identifies that season by the fall year (Y).
 *
 *   Jan–Jul  → previous calendar year  (still in the Y season)
 *   Aug–Dec  → current calendar year   (new season is underway / about to start)
 */
function deriveSeasonYear(date = new Date()) {
  return date.getMonth() < 7 ? date.getFullYear() - 1 : date.getFullYear();
}

/**
 * Fetch all Minnesota Wild games from the SportRadar NHL season schedule.
 *
 * @param {number} [year]        Season year (fall half). Defaults to current.
 * @param {string} [seasonType]  'REG' | 'PST' | 'PRE'. Defaults to REG.
 * @returns {Promise<Array>}  Normalised game objects ready for db.upsertGame()
 */
async function fetchSeasonSchedule(year = deriveSeasonYear(), seasonType = 'REG') {
  const url = `${BASE_URL}/seasons/${year}/${seasonType}/schedules.json`;

  const { data } = await axios.get(url, {
    params:  { api_key: process.env.SPORTRADAR_API_KEY },
    timeout: 15_000,
  });

  const games = data.games ?? [];

  return games
    .filter(g => g.home?.alias === WILD_ALIAS || g.away?.alias === WILD_ALIAS)
    .map(g => ({
      sportradar_id: g.id,
      scheduled_at:  g.scheduled,
      home_team:     g.home.name,
      away_team:     g.away.name,
      is_home:       g.home.alias === WILD_ALIAS ? 1 : 0,
      status:
        g.status === 'closed'     ? 'closed'     :
        g.status === 'inprogress' ? 'inprogress' : 'scheduled',
    }));
}

/**
 * Fetch the final score and status for a single game from SportRadar.
 *
 * @param {string} sportradarId  UUID of the game in SportRadar
 * @returns {Promise<{
 *   status: string,
 *   home_alias: string,
 *   away_alias: string,
 *   home_score: number|null,
 *   away_score: number|null
 * }>}
 */
async function fetchGameResult(sportradarId) {
  const url = `${BASE_URL}/games/${sportradarId}/summary.json`;

  const { data } = await axios.get(url, {
    params:  { api_key: process.env.SPORTRADAR_API_KEY },
    timeout: 15_000,
  });

  const game = data.game;
  return {
    status:     game.status,
    home_alias: game.home?.alias  ?? null,
    away_alias: game.away?.alias  ?? null,
    home_score: game.home?.points ?? null,
    away_score: game.away?.points ?? null,
  };
}


// ─── Contextual game data ─────────────────────────────────────────────────────

/**
 * Fetch the full season schedule (all 32 teams) and return a lookup map:
 *   sportradar_game_id → { wild_days_rest, opp_days_rest }
 *
 * Days rest = calendar days between this game and the team's most recent
 * previous game.  Null on the first game of the season for that team.
 */
async function fetchDaysRestMap(year = deriveSeasonYear(), seasonType = 'REG') {
  const url = `${BASE_URL}/seasons/${year}/${seasonType}/schedules.json`;
  const { data } = await axios.get(url, {
    params:  { api_key: process.env.SPORTRADAR_API_KEY },
    timeout: 20_000,
  });

  const allGames = (data.games ?? [])
    .slice()
    .sort((a, b) => new Date(a.scheduled) - new Date(b.scheduled));

  // Build per-alias sorted game-date list
  const teamDates = {}; // alias → [{ gameId, date }]
  for (const g of allGames) {
    for (const alias of [g.home?.alias, g.away?.alias]) {
      if (!alias) continue;
      if (!teamDates[alias]) teamDates[alias] = [];
      teamDates[alias].push({ gameId: g.id, date: new Date(g.scheduled) });
    }
  }

  const result = {};
  for (const game of allGames) {
    const homeAlias = game.home?.alias;
    const awayAlias = game.away?.alias;
    if (homeAlias !== WILD_ALIAS && awayAlias !== WILD_ALIAS) continue;

    const oppAlias = homeAlias === WILD_ALIAS ? awayAlias : homeAlias;
    const gameDate = new Date(game.scheduled);

    const prevWild = (teamDates[WILD_ALIAS] ?? [])
      .filter(g => g.gameId !== game.id && g.date < gameDate).at(-1);
    const prevOpp = (teamDates[oppAlias] ?? [])
      .filter(g => g.gameId !== game.id && g.date < gameDate).at(-1);

    result[game.id] = {
      wild_days_rest: prevWild ? Math.round((gameDate - prevWild.date) / 86_400_000) : null,
      opp_days_rest:  prevOpp  ? Math.round((gameDate - prevOpp.date)  / 86_400_000) : null,
    };
  }
  return result;
}

/**
 * Fetch season standings and return a map: team alias → record object.
 * Shape: { wins, losses, ot_losses, last10_wins, last10_losses }
 *
 * SportRadar returns standings nested under conferences → divisions → teams.
 * The `records` array contains objects with a `record_type` field; we use:
 *   'total'   → season totals
 *   'last_10' → last 10 games (key may be absent on some API tiers)
 */
async function fetchStandings(year = deriveSeasonYear(), seasonType = 'REG') {
  const url = `${BASE_URL}/seasons/${year}/${seasonType}/standings/season.json`;
  const { data } = await axios.get(url, {
    params:  { api_key: process.env.SPORTRADAR_API_KEY },
    timeout: 15_000,
  });

  const standingsMap = {};

  for (const conf of (data.conferences ?? [])) {
    for (const div of (conf.divisions ?? [])) {
      for (const team of (div.teams ?? [])) {
        const alias   = team.alias;
        const records = team.records ?? [];

        const total  = records.find(r => r.record_type === 'total')   ?? {};
        const last10 = records.find(r => r.record_type === 'last_10') ?? {};

        standingsMap[alias] = {
          wins:          total.wins    ?? null,
          losses:        total.losses  ?? null,
          ot_losses:     total.ot_losses ?? null,
          last10_wins:   last10.wins   ?? null,
          last10_losses: last10.losses ?? null,
        };
      }
    }
  }

  return standingsMap;
}

/**
 * Combine fetchDaysRestMap + fetchStandings into one context map keyed by
 * sportradar game UUID, ready to pass to db.updateGameContext().
 *
 * @returns {Promise<Object>}  sportradar_id → context object
 */
async function fetchContextForWildGames(year = deriveSeasonYear(), seasonType = 'REG') {
  const [daysRestMap, standingsMap] = await Promise.all([
    fetchDaysRestMap(year, seasonType),
    fetchStandings(year, seasonType),
  ]);

  // We need to know the opponent alias per game to look up standings.
  // Re-fetch the schedule briefly (or cache — for now re-use the wild-only data).
  const url = `${BASE_URL}/seasons/${year}/${seasonType}/schedules.json`;
  const { data } = await axios.get(url, {
    params:  { api_key: process.env.SPORTRADAR_API_KEY },
    timeout: 15_000,
  });

  const contextMap = {};
  for (const game of (data.games ?? [])) {
    const homeAlias = game.home?.alias;
    const awayAlias = game.away?.alias;
    if (homeAlias !== WILD_ALIAS && awayAlias !== WILD_ALIAS) continue;

    const oppAlias = homeAlias === WILD_ALIAS ? awayAlias : homeAlias;
    const opp      = standingsMap[oppAlias] ?? {};
    const rest     = daysRestMap[game.id]   ?? {};

    contextMap[game.id] = {
      wild_days_rest:    rest.wild_days_rest ?? null,
      opp_days_rest:     rest.opp_days_rest  ?? null,
      opp_wins:          opp.wins            ?? null,
      opp_losses:        opp.losses          ?? null,
      opp_ot_losses:     opp.ot_losses       ?? null,
      opp_last10_wins:   opp.last10_wins     ?? null,
      opp_last10_losses: opp.last10_losses   ?? null,
    };
  }

  return contextMap; // sportradar_id (UUID) → context
}

module.exports = {
  fetchSeasonSchedule,
  fetchGameResult,
  fetchContextForWildGames,
  deriveSeasonYear,
};

