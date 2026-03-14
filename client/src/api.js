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
