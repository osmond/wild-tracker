'use strict';

const axios = require('axios');
const { calcImpliedProb } = require('./calculator');

const BASE_URL    = 'https://api.the-odds-api.com/v4';
const SPORT_KEY   = 'icehockey_nhl';
const BOOKMAKERS  = 'draftkings,fanduel,betmgm,pinnacle';
const WILD_NAME   = 'Minnesota Wild';

/**
 * Fetch live NHL moneyline, totals, and spreads odds from The Odds API and
 * return only events that involve the Minnesota Wild.
 *
 * Each element in the returned array represents one bookmaker's line for
 * one Wild game — so a single game will produce up to four objects
 * (DraftKings, FanDuel, BetMGM, Pinnacle) if all bookmakers post the game.
 *
 * @returns {Promise<Array<{
 *   odds_api_id:       string,
 *   commence_time:     string,   // ISO-8601 UTC
 *   home_team:         string,
 *   away_team:         string,
 *   is_home:           0|1,
 *   bookmaker:         string,
 *   wild_moneyline:    number,   // American odds for Wild (h2h)
 *   opp_moneyline:     number,
 *   wild_implied_prob: number,   // de-juiced [0, 1]
 *   total_line:        number|null,
 *   over_odds:         number|null,
 *   under_odds:        number|null,
 *   spread_line:       number|null, // Wild's spread (e.g. -1.5 or +1.5)
 *   wild_spread_odds:  number|null,
 *   opp_spread_odds:   number|null,
 * }>>}
 */
async function fetchWildOdds() {
  const { data, headers } = await axios.get(`${BASE_URL}/sports/${SPORT_KEY}/odds`, {
    params: {
      apiKey:      process.env.ODDS_API_KEY,
      regions:     'us',
      markets:     'h2h,totals,spreads',
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

      // ── Totals market ──────────────────────────────────────────────────
      const totalsMarket = bm.markets?.find(m => m.key === 'totals');
      const overOutcome  = totalsMarket?.outcomes?.find(o => o.name === 'Over');
      const underOutcome = totalsMarket?.outcomes?.find(o => o.name === 'Under');

      // ── Spreads market ─────────────────────────────────────────────────
      const spreadsMarket    = bm.markets?.find(m => m.key === 'spreads');
      const wildSpreadOutcome = spreadsMarket?.outcomes?.find(o => o.name === WILD_NAME);
      const oppSpreadOutcome  = spreadsMarket?.outcomes?.find(o => o.name !== WILD_NAME);

      results.push({
        odds_api_id:       event.id,
        commence_time:     event.commence_time,
        home_team:         event.home_team,
        away_team:         event.away_team,
        is_home:           isHome ? 1 : 0,
        bookmaker:         bm.key,
        wild_moneyline:    wildOutcome.price,
        opp_moneyline:     oppOutcome.price,
        wild_implied_prob: calcImpliedProb(wildOutcome.price, oppOutcome.price),
        // Totals
        total_line:        overOutcome?.point  ?? null,
        over_odds:         overOutcome?.price  ?? null,
        under_odds:        underOutcome?.price ?? null,
        // Spreads
        spread_line:       wildSpreadOutcome?.point ?? null,
        wild_spread_odds:  wildSpreadOutcome?.price ?? null,
        opp_spread_odds:   oppSpreadOutcome?.price  ?? null,
      });
    }
  }

  return results;
}

/**
 * Fetch historical NHL odds from The Odds API at a specific past timestamp.
 * Returns the bookmaker lines for the Wild game on that date, or null if
 * the Wild were not listed.
 *
 * NOTE: This endpoint costs 10 API credits per call (vs 1 for live odds).
 *
 * @param {string} isoTimestamp  ISO-8601 UTC datetime (e.g. game's scheduled_at)
 * @returns {Promise<{ lines: Array|null, remaining: string|undefined, used: string|undefined }>}
 */
async function fetchHistoricalWildOdds(isoTimestamp) {
  const { data: body, headers } = await axios.get(`${BASE_URL}/sports/${SPORT_KEY}/odds-history`, {
    params: {
      apiKey:     process.env.ODDS_API_KEY,
      regions:    'us',
      markets:    'h2h,totals,spreads',
      bookmakers: BOOKMAKERS,
      oddsFormat: 'american',
      date:       isoTimestamp,
    },
    timeout: 15_000,
  });

  const remaining = headers['x-requests-remaining'];
  const used      = headers['x-requests-used'];

  const events = Array.isArray(body) ? body : (body.data ?? []);

  // Find the Wild event in this snapshot
  const wildEvent = events.find(
    e => e.home_team === WILD_NAME || e.away_team === WILD_NAME,
  );

  if (!wildEvent) return { lines: null, remaining, used };

  const lines = [];

  for (const bm of wildEvent.bookmakers ?? []) {
    const totalsMarket   = bm.markets?.find(m => m.key === 'totals');
    const overOutcome    = totalsMarket?.outcomes?.find(o => o.name === 'Over');
    const underOutcome   = totalsMarket?.outcomes?.find(o => o.name === 'Under');
    const spreadsMarket  = bm.markets?.find(m => m.key === 'spreads');
    const wildSpread     = spreadsMarket?.outcomes?.find(o => o.name === WILD_NAME);
    const oppSpread      = spreadsMarket?.outcomes?.find(o => o.name !== WILD_NAME);

    if (!overOutcome && !wildSpread) continue;

    lines.push({
      bookmaker:        bm.key,
      total_line:       overOutcome?.point   ?? null,
      over_odds:        overOutcome?.price   ?? null,
      under_odds:       underOutcome?.price  ?? null,
      wild_spread_odds: wildSpread?.price    ?? null,
      opp_spread_odds:  oppSpread?.price     ?? null,
    });
  }

  return { lines, remaining, used };
}

/**
 * Fetch historical NHL odds for a Wild game from ESPN's public summary API.
 * No API key required. ESPN typically retains betting data going back ~16 weeks.
 *
 * ESPN uses DraftKings as its primary odds provider.
 *
 * @param {string} scheduledAt  ISO-8601 UTC datetime stored in games.scheduled_at
 * @param {boolean|0|1} isHome  Whether the Wild are the home team
 * @returns {Promise<{ lines: Array|null }>}
 */
async function fetchHistoricalWildOddsFromESPN(scheduledAt, isHome) {
  const dt = new Date(scheduledAt);
  // ESPN uses ET/local US dates. Try the UTC date and the day before
  // (games at midnight UTC are the previous evening in ET).
  const datesToTry = [dt, new Date(dt.getTime() - 86_400_000)].map(d =>
    d.toISOString().slice(0, 10).replace(/-/g, ''),
  );

  let espnEventId = null;
  for (const date of datesToTry) {
    const { data: scoreboard } = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${date}`,
      { timeout: 10_000 },
    );
    const ev = (scoreboard.events ?? []).find(e =>
      e.competitions?.[0]?.competitors?.some(c => c.team?.abbreviation === 'MIN'),
    );
    if (ev) { espnEventId = ev.id; break; }
  }

  if (!espnEventId) return { lines: null };

  const { data: summary } = await axios.get(
    `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event=${espnEventId}`,
    { timeout: 10_000 },
  );

  const pc = summary.pickcenter?.[0];
  if (!pc) return { lines: null };

  const homeSpreadOdds = pc.homeTeamOdds?.spreadOdds ?? null;
  const awaySpreadOdds = pc.awayTeamOdds?.spreadOdds ?? null;

  const lines = [{
    bookmaker:        'draftkings',
    total_line:       pc.overUnder    ?? null,
    over_odds:        pc.overOdds     ?? null,
    under_odds:       pc.underOdds    ?? null,
    wild_spread_odds: isHome ? homeSpreadOdds : awaySpreadOdds,
    opp_spread_odds:  isHome ? awaySpreadOdds : homeSpreadOdds,
  }];

  if (lines[0].total_line == null && lines[0].wild_spread_odds == null) {
    return { lines: null };
  }

  return { lines };
}

/**
 * Fetch open + closing moneyline snapshots for a past Wild game from ESPN.
 * ESPN exposes both the opening and closing moneyline in the summary endpoint,
 * giving us 2 data points for the odds timeline even for completed games.
 *
 * @param {string} scheduledAt  ISO-8601 UTC datetime stored in games.scheduled_at
 * @param {boolean|0|1} isHome  Whether the Wild are the home team
 * @returns {Promise<{ open: object|null, close: object|null }>}
 *   Each snapshot has: { wild_moneyline, opp_moneyline, wild_implied_prob,
 *                        total_line, over_odds, under_odds,
 *                        spread_line, wild_spread_odds, opp_spread_odds }
 */
async function fetchESPNSnapshots(scheduledAt, isHome) {
  const dt = new Date(scheduledAt);
  const datesToTry = [dt, new Date(dt.getTime() - 86_400_000)].map(d =>
    d.toISOString().slice(0, 10).replace(/-/g, ''),
  );

  let espnEventId = null;
  for (const date of datesToTry) {
    const { data: scoreboard } = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=${date}`,
      { timeout: 10_000 },
    );
    const ev = (scoreboard.events ?? []).find(e =>
      e.competitions?.[0]?.competitors?.some(c => c.team?.abbreviation === 'MIN'),
    );
    if (ev) { espnEventId = ev.id; break; }
  }

  if (!espnEventId) return { open: null, close: null };

  const { data: summary } = await axios.get(
    `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event=${espnEventId}`,
    { timeout: 10_000 },
  );

  const pc = summary.pickcenter?.[0];
  if (!pc) return { open: null, close: null };

  // Parse American-odds strings like "+150" or "-180"
  const parseOdds = (s) => (s == null ? null : parseInt(s, 10));
  // Parse line strings like "o5.5" or "+1.5" → float
  const parseLine = (s) => (s == null ? null : parseFloat(s.replace(/^[uo]/, '')));

  const ml  = pc.moneyline;       // { home: { open: { odds }, close: { odds } }, away: … }
  const tot = pc.total;           // { over: { open: { line, odds }, close: … }, under: … }
  const spd = pc.pointSpread;     // { home: { open: { line, odds }, close: … }, away: … }

  const homeKey = isHome ? 'home' : 'away';
  const awayKey = isHome ? 'away' : 'home';

  function buildSnapshot(phase) {
    const wildML  = parseOdds(ml?.[homeKey]?.[phase]?.odds);
    const oppML   = parseOdds(ml?.[awayKey]?.[phase]?.odds);
    if (wildML == null) return null;

    const wildImplied = wildML < 0
      ? (-wildML) / (-wildML + 100)
      : 100 / (wildML + 100);

    const totalLine      = parseLine(tot?.over?.[phase]?.line);
    const overOdds       = parseOdds(tot?.over?.[phase]?.odds);
    const underOdds      = parseOdds(tot?.under?.[phase]?.odds);
    const wildSpreadOdds = parseOdds(spd?.[homeKey]?.[phase]?.odds);
    const oppSpreadOdds  = parseOdds(spd?.[awayKey]?.[phase]?.odds);
    const spreadLine     = parseLine(spd?.[homeKey]?.[phase]?.line);

    return {
      wild_moneyline:   wildML,
      opp_moneyline:    oppML,
      wild_implied_prob: wildImplied,
      total_line:       totalLine,
      over_odds:        overOdds,
      under_odds:       underOdds,
      spread_line:      spreadLine,
      wild_spread_odds: wildSpreadOdds,
      opp_spread_odds:  oppSpreadOdds,
    };
  }

  return {
    open:  buildSnapshot('open'),
    close: buildSnapshot('close'),
  };
}

module.exports = { fetchWildOdds, fetchHistoricalWildOdds, fetchHistoricalWildOddsFromESPN, fetchESPNSnapshots };
