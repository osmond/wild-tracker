/**
 * Thin wrappers over the Express API. All paths use /api prefix, which
 * Vite's dev-server proxy rewrites to http://localhost:3000 in development.
 * In production the static build should be served from the same origin as
 * the Express server, so /api/* routes resolve naturally.
 */

const BASE = '/api';

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

/** GET /stats — aggregate CLV, win rate, ROI */
export function fetchStats() {
  return apiFetch('/stats');
}

/** GET /stats/calibration — { count, calibration: [{ game_id, my_prob, outcome, … }] } */
export function fetchCalibration() {
  return apiFetch('/stats/calibration');
}

/** GET /games — { count, games: [game…] } */
export function fetchGames() {
  return apiFetch('/games');
}

/**
 * GET /games/:id — { game, snapshots: [snapshot…] }
 * Single game detail with full odds-snapshot history.
 */
export function fetchGameDetail(gameId) {
  return apiFetch(`/games/${gameId}`);
}

/** GET /sharp-moves — { count, sharp_moves: [move…] } */
export function fetchSharpMoves() {
  return apiFetch('/sharp-moves');
}

/**
 * GET /dollar-tracker — { total_games, settled_games, total_pnl, bets: […] }
 * All games with hypothetical $1-bet profit/loss at market closing line.
 */
export function fetchDollarTracker() {
  return apiFetch('/dollar-tracker');
}

/**
 * GET /puck-line-tracker — { total_games, settled_games, minus_covered, plus_covered, bets: […] }
 * All games with derived ±1.5 puck line coverage results and total goals.
 */
export function fetchPuckLineTracker() {
  return apiFetch('/puck-line-tracker');
}

/**
 * GET /stats/splits — { home, away, b2b, vs_winning, vs_losing }
 * W/L records broken down by home/away, back-to-back, and opponent strength.
 */
export function fetchSplits() {
  return apiFetch('/stats/splits');
}

/**
 * GET /ou-tracker — { total_games, over_pnl, under_pnl, overs, unders, pushes, bets: […] }
 * All games with total line, over/under odds, result, and running $1 P&L curves.
 */
export function fetchOUTracker() {
  return apiFetch('/ou-tracker');
}

/**
 * POST /games/:id/total-line — manually enter a total line for a game.
 * @param {number} gameId
 * @param {{ total_line?: number, over_odds?: number, under_odds?: number,
 *           wild_spread_odds?: number, opp_spread_odds?: number }} body
 */
export function postTotalLine(gameId, body) {
  return apiFetch(`/games/${gameId}/total-line`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

/**
 * POST /sync — trigger a schedule sync for the given season type.
 * @param {'REG'|'PST'} [type='REG']
 */
export function postSync(type = 'REG') {
  const headers = {};
  if (import.meta.env.VITE_ADMIN_KEY) {
    headers['Authorization'] = `Bearer ${import.meta.env.VITE_ADMIN_KEY}`;
  }
  return apiFetch(`/sync?type=${encodeURIComponent(type)}`, { method: 'POST', headers });
}

/**
 * POST /games/:id/predict — log model probability for a game.
 * @param {number} gameId
 * @param {number} myProb  float, exclusive of 0 and 1
 */
export async function postPredict(gameId, myProb) {
  const res = await fetch(`${BASE}/games/${gameId}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ my_prob: myProb }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /games/${gameId}/predict → ${res.status}: ${text}`);
  }
  return res.json();
}
