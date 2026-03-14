import Chart from 'chart.js/auto';
import {
  fetchStats,
  fetchGames,
  fetchGameDetail,
  fetchCalibration,
  fetchSharpMoves,
} from './api.js';

// ─── State ────────────────────────────────────────────────────────────────────

let oddsChart      = null;
let calibChart     = null;
let activeGameId   = null;

// book filter for the odds timeline (null = all)
let visibleBooks   = new Set(['pinnacle', 'draftkings', 'fanduel', 'betmgm']);

// game ids that have at least one sharp move (for the table indicator)
let sharpGameIds   = new Set();

// ─── Palette – one colour per bookmaker ───────────────────────────────────────
const BOOK_COLORS = {
  pinnacle:   '#388bfd',
  draftkings: '#3fb950',
  fanduel:    '#f0883e',
  betmgm:     '#bc8cff',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    hour12: true, timeZone: 'UTC',
  });
}

function fmtML(ml) {
  if (ml == null) return '—';
  return ml > 0 ? `+${ml}` : String(ml);
}

function fmtPct(val, decimals = 1) {
  if (val == null) return '—';
  const p = (val * 100).toFixed(decimals);
  return `${val > 0 ? '+' : ''}${p}%`;
}

function opponent(game) {
  return game.is_home ? game.away_team : game.home_team;
}

// ─── Stats bar ────────────────────────────────────────────────────────────────

function renderStats(stats, sharpCount) {
  const setText = (selector, text) => {
    const el = document.querySelector(selector);
    if (el) { el.textContent = text; el.classList.remove('loading'); }
  };
  const setClass = (selector, cls) => {
    const el = document.querySelector(selector);
    if (el) el.classList.add(cls);
  };

  // Win rate
  setText('#stat-win-rate .stat-value',
    stats.win_rate_pct != null ? `${stats.win_rate_pct}%` : '—');
  setText('#stat-win-record',
    `${stats.wins ?? 0}W – ${stats.losses ?? 0}L`);

  // CLV (prefer Pinnacle, fall back to DraftKings, then FanDuel)
  const clvRaw = stats.avg_clv_pinnacle ?? stats.avg_clv_draftkings ?? stats.avg_clv_fanduel;
  const clvText = clvRaw != null ? fmtPct(clvRaw, 2) : '—';
  setText('#stat-clv .stat-value', clvText);
  if (clvRaw != null) setClass('#stat-clv .stat-value', clvRaw >= 0 ? 'positive' : 'negative');

  // ROI
  const roiText = stats.roi_pct != null ? `${stats.roi_pct}%` : '—';
  setText('#stat-roi .stat-value', roiText);
  if (stats.roi_pct != null) setClass('#stat-roi .stat-value', stats.roi_pct >= 0 ? 'positive' : 'negative');

  // Sharp moves count
  setText('#stat-sharp .stat-value', sharpCount != null ? String(sharpCount) : '—');
}

// ─── Games table ──────────────────────────────────────────────────────────────

function clvBadge(clv) {
  if (clv == null) return '<span class="badge badge-neutral">—</span>';
  const cls = clv > 0 ? 'badge-green' : 'badge-red';
  return `<span class="badge ${cls}">${fmtPct(clv, 1)}</span>`;
}

function resultBadge(game) {
  if (game.status !== 'closed' || !game.result) {
    const label = game.status === 'inprogress' ? 'Live' : 'Upcoming';
    return `<span class="badge badge-neutral">${label}</span>`;
  }
  const win = game.result === 'win';
  const score = game.wild_score != null
    ? ` ${game.wild_score}–${game.opponent_score}` : '';
  return `<span class="badge ${win ? 'badge-green' : 'badge-red'}">${win ? 'W' : 'L'}${score}</span>`;
}

function renderGamesTable(games) {
  const tbody  = document.getElementById('games-tbody');
  const counter = document.getElementById('games-count');

  if (counter) counter.textContent = `${games.length} games`;

  if (!games.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="empty">No games found. Run the scheduler to populate data.</td></tr>';
    return;
  }

  tbody.innerHTML = games.map(g => {
    const opp        = opponent(g);
    const ha         = g.is_home ? 'home' : 'away';
    const openML     = fmtML(g.pin_opening_ml ?? g.dk_opening_ml ?? g.fd_opening_ml);
    const closeML    = fmtML(g.pin_closing_ml ?? g.dk_closing_ml ?? g.fd_closing_ml);
    const clv        = g.pin_clv ?? g.dk_clv ?? g.fd_clv;
    const hasSharp   = sharpGameIds.has(g.id);

    return `<tr class="game-row" data-id="${g.id}" data-active="false">
      <td class="col-date">${fmtDate(g.scheduled_at)}</td>
      <td class="col-matchup">${escHtml(opp)}${hasSharp ? '<span class="sharp-dot" title="Sharp move detected"></span>' : ''}</td>
      <td><span class="ha-badge ha-${ha}">${ha.toUpperCase()}</span></td>
      <td class="col-ml">${openML}</td>
      <td class="col-ml">${closeML}</td>
      <td>${clvBadge(clv)}</td>
      <td>${resultBadge(g)}</td>
      <td class="col-expand">&#x25BE;</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.game-row').forEach(row => {
    row.addEventListener('click', () => onGameRowClick(Number(row.dataset.id), row));
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Game detail panel ────────────────────────────────────────────────────────

async function onGameRowClick(gameId, row) {
  const panel = document.getElementById('game-detail');

  // Toggle closed if clicking the same row again
  if (activeGameId === gameId) {
    closeDetailPanel();
    return;
  }

  // Deactivate previous row
  document.querySelectorAll('.game-row[data-active="true"]')
    .forEach(r => { r.dataset.active = 'false'; });

  row.dataset.active = 'true';
  activeGameId = gameId;

  // Show the panel in a loading state
  panel.hidden = false;
  document.getElementById('detail-title').textContent = 'Loading…';
  document.getElementById('book-filters').innerHTML   = '';

  if (oddsChart) { oddsChart.destroy(); oddsChart = null; }

  try {
    const { game, snapshots } = await fetchGameDetail(gameId);
    const opp  = opponent(game);
    const ha   = game.is_home ? 'vs' : '@';
    document.getElementById('detail-title').textContent =
      `Odds Timeline — Wild ${ha} ${opp} · ${fmtDate(game.scheduled_at)}`;

    renderOddsTimeline(snapshots ?? []);
  } catch (err) {
    document.getElementById('detail-title').textContent = 'Error loading timeline';
    console.error('Game detail error:', err);
  }
}

function closeDetailPanel() {
  document.getElementById('game-detail').hidden = true;
  document.querySelectorAll('.game-row[data-active="true"]')
    .forEach(r => { r.dataset.active = 'false'; });
  activeGameId = null;
  if (oddsChart) { oddsChart.destroy(); oddsChart = null; }
}

// ─── Odds timeline chart ──────────────────────────────────────────────────────

function renderOddsTimeline(snapshots) {
  if (!snapshots.length) {
    document.getElementById('detail-title').textContent += ' — No snapshot data yet';
    return;
  }

  // Group by bookmaker  →  { pinnacle: [snap…], … }
  const byBook = {};
  for (const snap of snapshots) {
    (byBook[snap.bookmaker] ??= []).push(snap);
  }

  const books = Object.keys(byBook).sort();

  // Reset visible books to what's actually present
  visibleBooks = new Set(books);

  // Build book-filter chips
  const filterContainer = document.getElementById('book-filters');
  filterContainer.innerHTML = '';
  books.forEach(book => {
    const chip = document.createElement('button');
    chip.className = 'book-chip active';
    chip.textContent = book;
    chip.dataset.book = book;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBook(book, chip);
    });
    filterContainer.appendChild(chip);
  });

  // Collect all unique timestamps (x-axis labels)
  const allTimes = [...new Set(snapshots.map(s => s.captured_at))].sort();

  const datasets = books.map(book => {
    const snapMap = Object.fromEntries(
      byBook[book].map(s => [s.captured_at, s.wild_moneyline])
    );
    return {
      label: book,
      data: allTimes.map(t => ({
        x: t,
        y: snapMap[t] ?? null,
      })),
      borderColor: BOOK_COLORS[book] ?? '#8b949e',
      backgroundColor: BOOK_COLORS[book] ?? '#8b949e',
      borderWidth: 2,
      pointRadius: 3,
      pointHoverRadius: 5,
      spanGaps: true,
      tension: 0,
    };
  });

  if (oddsChart) oddsChart.destroy();

  const ctx = document.getElementById('odds-timeline-chart').getContext('2d');
  oddsChart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: false, // we use custom chips
        },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            title: (items) => fmtDateTime(items[0].raw.x),
            label: (item) => {
              const v = item.raw.y;
              return v != null ? ` ${item.dataset.label}: ${fmtML(v)}` : null;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'category',
          ticks: {
            color: '#8b949e',
            maxTicksLimit: 8,
            maxRotation: 0,
            callback: (_, i) => {
              const t = allTimes[i];
              return t ? fmtDateTime(t).split(',')[0] : '';
            },
          },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
        y: {
          ticks: {
            color: '#8b949e',
            callback: (v) => fmtML(v),
          },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
      },
    },
  });
}

function toggleBook(book, chip) {
  if (visibleBooks.has(book)) {
    visibleBooks.delete(book);
    chip.classList.remove('active');
  } else {
    visibleBooks.add(book);
    chip.classList.add('active');
  }

  if (!oddsChart) return;
  oddsChart.data.datasets.forEach(ds => {
    const meta = oddsChart.getDatasetMeta(oddsChart.data.datasets.indexOf(ds));
    meta.hidden = !visibleBooks.has(ds.label);
  });
  oddsChart.update();
}

// ─── Calibration chart ────────────────────────────────────────────────────────

function renderCalibration(rows) {
  const emptyEl = document.getElementById('calibration-empty');
  const wrapEl  = document.querySelector('.calibration-wrap');

  // Only plot rows that have both a prediction and a settled outcome
  const settled = rows.filter(r => r.outcome !== null && r.outcome !== undefined && r.my_prob != null);

  if (!settled.length) {
    if (emptyEl) emptyEl.hidden = false;
    if (wrapEl)  wrapEl.style.display = 'none';
    return;
  }

  if (emptyEl) emptyEl.hidden = true;

  // Scatter data  (raw points)
  const rawPoints = settled.map(r => ({ x: r.my_prob, y: r.outcome }));

  // Binned averages: 10 equally-spaced bins from 0 to 1
  const bins = Array.from({ length: 10 }, (_, i) => {
    const lo = i * 0.1;
    const hi = lo + 0.1;
    const inBin = settled.filter(r => r.my_prob >= lo && r.my_prob < hi);
    if (!inBin.length) return null;
    const avgProb = inBin.reduce((s, r) => s + r.my_prob, 0) / inBin.length;
    const avgOut  = inBin.reduce((s, r) => s + r.outcome, 0) / inBin.length;
    return { x: avgProb, y: avgOut };
  }).filter(Boolean);

  if (calibChart) calibChart.destroy();

  const ctx = document.getElementById('calibration-chart').getContext('2d');
  calibChart = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        {
          // Perfect calibration diagonal
          label: 'Perfect calibration',
          type: 'line',
          data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          borderColor: '#30363d',
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
        {
          // Raw observations
          label: 'Predictions',
          data: rawPoints,
          backgroundColor: 'rgba(56,139,253,0.35)',
          borderColor: 'rgba(56,139,253,0.6)',
          pointRadius: 5,
          pointHoverRadius: 7,
        },
        {
          // Binned average line
          label: 'Calibration (binned)',
          type: 'line',
          data: bins,
          borderColor: '#3fb950',
          backgroundColor: '#3fb950',
          borderWidth: 2,
          pointRadius: 5,
          pointHoverRadius: 7,
          fill: false,
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#8b949e', boxWidth: 12, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            label: (item) => {
              if (item.datasetIndex === 0) return null;
              const { x, y } = item.raw;
              return ` Predicted ${(x * 100).toFixed(0)}% → Actual ${(y * 100).toFixed(0)}%`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: 0, max: 1,
          title: { display: true, text: 'Predicted probability', color: '#8b949e', font: { size: 11 } },
          ticks: {
            color: '#8b949e',
            callback: (v) => `${(v * 100).toFixed(0)}%`,
          },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
        y: {
          type: 'linear',
          min: -0.05, max: 1.05,
          title: { display: true, text: 'Actual outcome', color: '#8b949e', font: { size: 11 } },
          ticks: {
            color: '#8b949e',
            callback: (v) => v === 0 ? 'Loss' : v === 1 ? 'Win' : '',
          },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
      },
    },
  });
}

// ─── Sharp moves feed ─────────────────────────────────────────────────────────

function renderSharpFeed(moves) {
  const list    = document.getElementById('sharp-moves-list');
  const counter = document.getElementById('sharp-count');

  if (counter) counter.textContent = `${moves.length} total`;

  if (!moves.length) {
    list.innerHTML = '<div class="feed-empty">No sharp moves detected yet.</div>';
    return;
  }

  list.innerHTML = moves.map(m => {
    const direction  = m.new_moneyline < m.old_moneyline ? 'down' : 'up';
    const dirLabel   = direction === 'up' ? '▲ Favourite' : '▼ Underdog';
    const gameLabel  = m.game_is_home
      ? `Wild vs ${escHtml(m.game_away_team)}`
      : `Wild @ ${escHtml(m.game_home_team)}`;

    return `<div class="sharp-item">
      <span class="sharp-game">${gameLabel}</span>
      <div class="sharp-meta">
        <span class="sharp-book">${escHtml(m.bookmaker)}</span>
        <span class="sharp-move-line">${fmtML(m.old_moneyline)} → ${fmtML(m.new_moneyline)}</span>
        <span class="sharp-direction sharp-${direction}">${dirLabel}</span>
      </div>
      <span class="sharp-date">${fmtDateTime(m.detected_at)}</span>
    </div>`;
  }).join('');
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

async function loadAll() {
  const btn = document.getElementById('btn-refresh');
  if (btn) btn.classList.add('spinning');

  const [statsRes, gamesRes, calibRes, sharpRes] = await Promise.allSettled([
    fetchStats(),
    fetchGames(),
    fetchCalibration(),
    fetchSharpMoves(),
  ]);

  // Build the sharp game id set before rendering the table
  if (sharpRes.status === 'fulfilled') {
    sharpGameIds = new Set((sharpRes.value.sharp_moves ?? []).map(m => m.game_id));
    renderSharpFeed(sharpRes.value.sharp_moves ?? []);
  } else {
    console.warn('Sharp moves fetch failed:', sharpRes.reason);
    document.getElementById('sharp-moves-list').innerHTML =
      '<div class="feed-empty">Could not load sharp moves.</div>';
  }

  if (gamesRes.status === 'fulfilled') {
    renderGamesTable(gamesRes.value.games ?? []);
  } else {
    console.warn('Games fetch failed:', gamesRes.reason);
    document.getElementById('games-tbody').innerHTML =
      '<tr><td colspan="8" class="empty">Could not load games — is the backend running?</td></tr>';
  }

  if (statsRes.status === 'fulfilled') {
    renderStats(
      statsRes.value,
      sharpRes.status === 'fulfilled' ? sharpRes.value.count : null,
    );
  } else {
    console.warn('Stats fetch failed:', statsRes.reason);
  }

  if (calibRes.status === 'fulfilled') {
    renderCalibration(calibRes.value.calibration ?? []);
  } else {
    console.warn('Calibration fetch failed:', calibRes.reason);
  }

  // If a game was open, refresh its detail panel too
  if (activeGameId !== null) {
    const activeRow = document.querySelector(`.game-row[data-id="${activeGameId}"]`);
    if (activeRow) onGameRowClick(activeGameId, activeRow);
  }

  if (btn) btn.classList.remove('spinning');
}

// ─── Wire up controls ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-refresh')?.addEventListener('click', loadAll);
  document.getElementById('detail-close')?.addEventListener('click', closeDetailPanel);
  loadAll();
});
