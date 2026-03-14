'use strict';

const axios = require('axios');
const { calcImpliedProb } = require('./calculator');

const BASE_URL    = 'https://api.the-odds-api.com/v4';
const SPORT_KEY   = 'icehockey_nhl';
const BOOKMAKERS  = 'draftkings,fanduel,betmgm,pinnacle';
const WILD_NAME   = 'Minnesota Wild';

/**
 * Fetch live NHL moneyline odds from The Odds API and return only events
 * that involve the Minnesota Wild.
 *
 * Each element in the returned array represents one bookmaker's line for
 * one Wild game — so a single game will produce two objects (DraftKings +
 * Pinnacle) if both bookmakers have the game listed.
 *
 * @returns {Promise<Array<{
 *   odds_api_id:     string,
 *   commence_time:   string,   // ISO-8601 UTC
 *   home_team:       string,
 *   away_team:       string,
 *   is_home:         0|1,
 *   bookmaker:       string,
 *   wild_moneyline:  number,   // American odds for Wild
 *   opp_moneyline:   number,   // American odds for opponent
 *   wild_implied_prob: number  // de-juiced [0, 1]
 * }>>}
 */
async function fetchWildOdds() {
  const { data, headers } = await axios.get(`${BASE_URL}/sports/${SPORT_KEY}/odds`, {
    params: {
      apiKey:      process.env.ODDS_API_KEY,
      regions:     'us',
      markets:     'h2h',
      bookmakers:  BOOKMAKERS,
      oddsFormat:  'american',
    },
    timeout: 15_000,
  });

  // Log remaining quota so the user can monitor API usage
  const remaining = headers['x-requests-remaining'];
  const used      = headers['x-requests-used'];
  if (remaining !== undefined) {
    console.log(`[odds-fetcher] Odds API quota — used: ${used}, remaining: ${remaining}`);
  }

  const wildEvents = data.filter(
    event => event.home_team === WILD_NAME || event.away_team === WILD_NAME,
  );

  const results = [];

  for (const event of wildEvents) {
    const isHome = event.home_team === WILD_NAME;

    for (const bm of event.bookmakers) {
      const h2h = bm.markets?.find(m => m.key === 'h2h');
      if (!h2h) continue;

      const wildOutcome = h2h.outcomes.find(o => o.name === WILD_NAME);
      const oppOutcome  = h2h.outcomes.find(o => o.name !== WILD_NAME);
      if (!wildOutcome || !oppOutcome) continue;

      results.push({
        odds_api_id:      event.id,
        commence_time:    event.commence_time,
        home_team:        event.home_team,
        away_team:        event.away_team,
        is_home:          isHome ? 1 : 0,
        bookmaker:        bm.key,
        wild_moneyline:   wildOutcome.price,
        opp_moneyline:    oppOutcome.price,
        wild_implied_prob: calcImpliedProb(wildOutcome.price, oppOutcome.price),
      });
    }
  }

  return results;
}

module.exports = { fetchWildOdds };
