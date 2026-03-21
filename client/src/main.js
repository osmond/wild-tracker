import Chart from 'chart.js/auto';
import {
  fetchStats,
  fetchGames,
  fetchGameDetail,
  fetchCalibration,
  fetchSharpMoves,
  fetchDollarTracker,
  fetchPuckLineTracker,
  fetchSplits,
  fetchOUTracker,
  postTotalLine,
  postSync,
  postBackfillOdds,
  postSettle,
} from './api.js';

// ─── State ────────────────────────────────────────────────────────────────────

let oddsChart      = null;
let calibChart     = null;
let dollarChart    = null;
let monthlyChart   = null;
let pucklineChart  = null;
let goalsChart     = null;
let ouChart        = null;
let activeGameId   = null;

// book filter for the odds timeline (null = all)
let visibleBooks   = new Set(['pinnacle', 'draftkings', 'fanduel', 'betmgm']);

// game ids that have at least one sharp move (for the table indicator)
let sharpGameIds   = new Set();

// full games list, kept for client-side filtering
let allGames       = [];

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

  // Streak
  const el = document.querySelector('#stat-streak .stat-value');
  if (el) {
    el.classList.remove('loading');
    if (stats.streak?.count) {
      const isWin = stats.streak.type === 'win';
      el.textContent = `${isWin ? 'W' : 'L'}${stats.streak.count}`;
      el.classList.add(isWin ? 'positive' : 'negative');
    } else {
      el.textContent = '—';
    }
  }
}

// ─── Dollar tracker stat card ─────────────────────────────────────────────────

function renderDollarStatCard(data) {
  const el  = document.querySelector('#stat-dollar-pnl .stat-value');
  const sub = document.getElementById('stat-dollar-pnl-sub');
  if (!el) return;

  el.classList.remove('loading');
  if (data == null) {
    el.textContent = '—';
    return;
  }

  const pnl = data.total_pnl;
  const sign = pnl >= 0 ? '+' : '-';
  el.textContent = `${sign}$${Math.abs(pnl).toFixed(2)}`;
  el.classList.add(pnl >= 0 ? 'positive' : 'negative');
  if (sub) sub.textContent = `${data.settled_games} settled games`;
}

// ─── Splits bar ──────────────────────────────────────────────────────────────

function fmtRecord(wins, losses) {
  if (!wins && !losses) return '—';
  return `${wins}W–${losses}L`;
}

function renderSplits(splits) {
  const set = (id, wins, losses) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = fmtRecord(wins, losses);
    if (wins || losses) {
      const rate = wins / (wins + losses);
      el.classList.add(rate >= 0.5 ? 'split-positive' : 'split-negative');
    }
  };
  set('split-home',       splits.home.wins,       splits.home.losses);
  set('split-away',       splits.away.wins,       splits.away.losses);
  set('split-b2b',        splits.b2b.wins,        splits.b2b.losses);
  set('split-vs-winning', splits.vs_winning.wins, splits.vs_winning.losses);
  set('split-vs-losing',  splits.vs_losing.wins,  splits.vs_losing.losses);
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
    const isB2B      = g.wild_days_rest === 1;

    return `<tr class="game-row" data-id="${g.id}" data-active="false"
      data-is-home="${g.is_home}"
      data-opp-winning="${g.opp_wins != null && g.opp_wins / Math.max(g.opp_wins + g.opp_losses + (g.opp_ot_losses ?? 0), 1) >= 0.5 ? '1' : '0'}"
      data-b2b="${isB2B ? '1' : '0'}">
      <td class="col-date">${fmtDate(g.scheduled_at)}</td>
      <td class="col-matchup">${escHtml(opp)}${hasSharp ? '<span class="sharp-dot" title="Sharp move detected"></span>' : ''}${isB2B ? '<span class="b2b-badge" title="Back-to-back game">B2B</span>' : ''}</td>
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

  // Re-apply the current filter selection
  applyGamesFilter();
}

// Opponent / context filter
function applyGamesFilter() {
  const filter = document.getElementById('opp-strength-filter')?.value ?? 'all';
  document.querySelectorAll('#games-tbody .game-row').forEach(row => {
    let visible = true;
    if (filter === 'winning')  visible = row.dataset.oppWinning === '1';
    if (filter === 'losing')   visible = row.dataset.oppWinning === '0';
    if (filter === 'b2b')      visible = row.dataset.b2b === '1';
    row.style.display = visible ? '' : 'none';
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

// ─── Dollar tracker ───────────────────────────────────────────────────────────

function renderDollarTracker(data) {
  const tbody   = document.getElementById('dollar-tbody');
  const counter = document.getElementById('dollar-game-count');
  if (!tbody) return;

  if (counter) counter.textContent = `${data.total_games} games`;

  if (!data.bets.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No games yet.</td></tr>';
    return;
  }

  tbody.innerHTML = data.bets.map(b => {
    const opp    = b.is_home ? b.away_team : b.home_team;
    const ha     = b.is_home ? 'home' : 'away';
    const mlTxt  = fmtML(b.bet_ml);

    let resultCell, profitCell, runningCell;

    if (b.result === 'win' && b.profit != null) {
      const score = b.wild_score != null ? ` ${b.wild_score}–${b.opponent_score}` : '';
      resultCell  = `<span class="badge badge-green">W${escHtml(score)}</span>`;
      profitCell  = `<span class="dollar-profit positive">+$${b.profit.toFixed(2)}</span>`;
    } else if (b.result === 'win' && b.no_odds) {
      const score = b.wild_score != null ? ` ${b.wild_score}–${b.opponent_score}` : '';
      resultCell  = `<span class="badge badge-green">W${escHtml(score)}</span>`;
      profitCell  = `<span class="dollar-potential">no odds</span>`;
    } else if (b.result === 'loss') {
      const score = b.wild_score != null ? ` ${b.wild_score}–${b.opponent_score}` : '';
      resultCell  = `<span class="badge badge-red">L${escHtml(score)}</span>`;
      profitCell  = `<span class="dollar-profit negative">-$1.00</span>`;
    } else {
      const label = b.status === 'inprogress' ? 'Live' : 'Upcoming';
      resultCell  = `<span class="badge badge-neutral">${label}</span>`;
      profitCell  = b.potential_profit != null
        ? `<span class="dollar-potential">+$${b.potential_profit.toFixed(2)} if W</span>`
        : '<span class="dollar-potential">—</span>';
    }

    const runPnl  = b.running_pnl;
    const runSign = runPnl >= 0 ? '+' : '';
    const runCls  = runPnl >= 0 ? 'positive' : 'negative';
    runningCell = b.result != null
      ? `<span class="dollar-running ${runCls}">${runSign}$${Math.abs(runPnl).toFixed(2)}</span>`
      : `<span class="dollar-running neutral">${runSign}$${Math.abs(runPnl).toFixed(2)}</span>`;

    return `<tr class="dollar-row">
      <td class="col-date">${fmtDate(b.scheduled_at)}</td>
      <td class="col-matchup">${escHtml(opp)}</td>
      <td><span class="ha-badge ha-${ha}">${ha.toUpperCase()}</span></td>
      <td class="col-ml">${mlTxt}</td>
      <td>${resultCell}</td>
      <td class="col-right">${profitCell}</td>
      <td class="col-right">${runningCell}</td>
    </tr>`;
  }).join('');

  // Running P&L chart — only settled games (those with a result)
  const settled = data.bets.filter(b => b.result != null);
  if (!settled.length) return;

  const labels = settled.map(b => fmtDate(b.scheduled_at));
  const values = settled.map(b => b.running_pnl);
  const colors = values.map(v => v >= 0 ? '#3fb950' : '#f85149');

  if (dollarChart) dollarChart.destroy();

  const ctx = document.getElementById('dollar-pnl-chart')?.getContext('2d');
  if (!ctx) return;

  dollarChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Running P&L ($1/game)',
        data: values,
        borderColor: '#388bfd',
        backgroundColor: 'rgba(56,139,253,0.08)',
        fill: true,
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: colors,
        pointBorderColor: colors,
        tension: 0,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            label: (item) => {
              const v = item.raw;
              const sign = v >= 0 ? '+' : '';
              return ` P&L: ${sign}$${Math.abs(v).toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxTicksLimit: 12, maxRotation: 0 },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
        y: {
          ticks: {
            color: '#8b949e',
            callback: (v) => `$${v.toFixed(2)}`,
          },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
      },
    },
  });

  // Monthly breakdown bar chart
  renderMonthlyChart(settled);
}

// ─── Monthly P&L bar chart ───────────────────────────────────────────────────

function renderMonthlyChart(settled) {
  const ctx = document.getElementById('dollar-monthly-chart')?.getContext('2d');
  if (!ctx) return;

  const monthMap = {};
  for (const b of settled) {
    if (b.profit == null) continue;
    const key = new Date(b.scheduled_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', timeZone: 'UTC',
    });
    if (!monthMap[key]) monthMap[key] = 0;
    monthMap[key] += b.profit;
  }

  const entries = Object.entries(monthMap);
  if (!entries.length) return;

  const labels = entries.map(([k]) => k);
  const values = entries.map(([, v]) => parseFloat(v.toFixed(2)));
  const colors = values.map(v => v >= 0 ? 'rgba(63,185,80,0.7)' : 'rgba(248,81,73,0.7)');
  const borderColors = values.map(v => v >= 0 ? '#3fb950' : '#f85149');

  if (monthlyChart) monthlyChart.destroy();
  monthlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Monthly P&L',
        data: values,
        backgroundColor: colors,
        borderColor: borderColors,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            label: (item) =>
              ` ${item.raw >= 0 ? '+' : ''}$${Math.abs(item.raw).toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxRotation: 0 },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
        y: {
          ticks: { color: '#8b949e', callback: (v) => `$${v.toFixed(2)}` },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
      },
    },
  });
}

// ─── Puck line tracker ───────────────────────────────────────────────────────────

function coverBadge(covered) {
  if (covered === null || covered === undefined) {
    return '<span class="badge badge-neutral">—</span>';
  }
  return covered
    ? '<span class="badge badge-green">✓ Yes</span>'
    : '<span class="badge badge-red">✕ No</span>';
}

function renderPuckLineTracker(data) {
  const tbody   = document.getElementById('puckline-tbody');
  const counter = document.getElementById('puckline-game-count');
  const summary = document.getElementById('puckline-summary');
  if (!tbody) return;

  if (counter) counter.textContent = `${data.settled_games} settled`;

  // Summary chips
  if (summary) {
    const minusPct = data.settled_games
      ? ((data.minus_covered / data.settled_games) * 100).toFixed(1)
      : null;
    const plusPct = data.settled_games
      ? ((data.plus_covered / data.settled_games) * 100).toFixed(1)
      : null;
    const fmtSpreadPnl = (v) => {
      if (v == null) return '';
      const sign = v >= 0 ? '+' : '';
      const cls  = v >= 0 ? 'positive' : 'negative';
      return `<span class="pl-chip-pnl ${cls}">${sign}$${Math.abs(v).toFixed(2)}</span>`;
    };
    summary.innerHTML = `
      <div class="pl-chip">
        <span class="pl-chip-label">-1.5 Record</span>
        <span class="pl-chip-value">${data.minus_covered}W–${data.minus_not_covered}L</span>
        ${minusPct != null ? `<span class="pl-chip-pct">${minusPct}%</span>` : ''}
        ${fmtSpreadPnl(data.minus_pnl)}
      </div>
      <div class="pl-chip">
        <span class="pl-chip-label">+1.5 Record</span>
        <span class="pl-chip-value">${data.plus_covered}W–${data.plus_not_covered}L</span>
        ${plusPct != null ? `<span class="pl-chip-pct">${plusPct}%</span>` : ''}
        ${fmtSpreadPnl(data.plus_pnl)}
      </div>`;
  }

  // Table (newest first = reverse the bets array for display)
  const settled = data.bets.filter(b => b.covers_minus_1_5 !== null);
  const display = [...data.bets].reverse();

  if (!display.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No settled games yet.</td></tr>';
  } else {
    tbody.innerHTML = display.map(b => {
      const opp  = b.is_home ? b.away_team : b.home_team;
      const ha   = b.is_home ? 'home' : 'away';
      const score = b.wild_score != null
        ? `<span class="badge ${b.result === 'win' ? 'badge-green' : b.result === 'loss' ? 'badge-red' : 'badge-neutral'}">${b.wild_score}–${b.opponent_score}</span>`
        : `<span class="badge badge-neutral">${b.status === 'inprogress' ? 'Live' : 'Upcoming'}</span>`;
      const fmtPl = (v) => {
        if (v == null) return '<span class="dollar-potential">—</span>';
        const sign = v > 0 ? '+' : '';
        const cls  = v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral';
        return `<span class="dollar-profit ${cls}">${sign}$${Math.abs(v).toFixed(2)}</span>`;
      };
      return `<tr>
        <td class="col-date">${fmtDate(b.scheduled_at)}</td>
        <td class="col-matchup">${escHtml(opp)}</td>
        <td><span class="ha-badge ha-${ha}">${ha.toUpperCase()}</span></td>
        <td>${score}</td>
        <td>${coverBadge(b.covers_minus_1_5)}</td>
        <td>${coverBadge(b.covers_plus_1_5)}</td>
        <td class="col-right">${b.total_goals ?? '—'}</td>
        <td class="col-right" title="${b.wild_spread_odds != null ? `Wild -1.5 odds: ${b.wild_spread_odds > 0 ? '+' : ''}${b.wild_spread_odds}` : 'No odds captured yet'}">${fmtPl(b.minus_pnl)}</td>
        <td class="col-right" title="${b.opp_spread_odds  != null ? `Wild +1.5 odds: ${b.opp_spread_odds > 0 ? '+' : ''}${b.opp_spread_odds}` : 'No odds captured yet'}">${fmtPl(b.plus_pnl)}</td>
      </tr>`;
    }).join('');
  }

  // Coverage trend chart (one line each for -1.5 and +1.5)
  if (!settled.length) return;

  const chartLabels   = settled.map(b => fmtDate(b.scheduled_at));
  const minusData     = settled.map(b => b.minus_running_covered);
  const plusData      = settled.map(b => b.plus_running_covered);
  const totalData     = settled.map(b => b.minus_running_total);

  if (pucklineChart) pucklineChart.destroy();
  const ctx = document.getElementById('puckline-chart')?.getContext('2d');
  if (!ctx) return;

  pucklineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [
        {
          label: '-1.5 Cumulative Covers',
          data: minusData,
          borderColor: '#f0883e',
          backgroundColor: 'rgba(240,136,62,0.08)',
          fill: false,
          borderWidth: 2,
          pointRadius: 2,
          tension: 0,
        },
        {
          label: '+1.5 Cumulative Covers',
          data: plusData,
          borderColor: '#3fb950',
          backgroundColor: 'rgba(63,185,80,0.08)',
          fill: false,
          borderWidth: 2,
          pointRadius: 2,
          tension: 0,
        },
        {
          label: 'Games Played',
          data: totalData,
          borderColor: '#30363d',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#8b949e', boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxTicksLimit: 12, maxRotation: 0 },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
        y: {
          ticks: { color: '#8b949e' },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
      },
    },
  });
}

// ─── Total goals scatter ──────────────────────────────────────────────────────────

function renderTotalGoalsChart(bets) {
  const ctx = document.getElementById('total-goals-chart')?.getContext('2d');
  if (!ctx) return;

  const settled = bets.filter(b => b.total_goals != null);
  if (!settled.length) return;

  const avg = settled.reduce((s, b) => s + b.total_goals, 0) / settled.length;

  const labels  = settled.map(b => fmtDate(b.scheduled_at));
  const values  = settled.map(b => b.total_goals);
  const colors  = values.map(v => v > avg ? 'rgba(56,139,253,0.7)' : 'rgba(139,148,158,0.5)');

  if (goalsChart) goalsChart.destroy();
  goalsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Total Goals',
          data: values,
          backgroundColor: colors,
          borderColor: colors,
          borderWidth: 0,
          borderRadius: 2,
        },
        {
          label: `Season Avg (${avg.toFixed(1)})`,
          type: 'line',
          data: Array(labels.length).fill(avg),
          borderColor: '#ddbd5e',
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#8b949e', boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            label: (item) => item.dataset.type === 'line'
              ? null
              : ` ${item.raw} total goals`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxTicksLimit: 12, maxRotation: 0 },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
        y: {
          min: 0,
          ticks: { color: '#8b949e', stepSize: 1 },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
      },
    },
  });
}

// ─── O/U Tracker ──────────────────────────────────────────────────────────────────────────

function ouResultBadge(result) {
  if (!result) return '<span class="badge badge-neutral">—</span>';
  if (result === 'over')  return '<span class="badge badge-green">OVER</span>';
  if (result === 'under') return '<span class="badge badge-blue">UNDER</span>';
  return '<span class="badge badge-neutral">PUSH</span>';
}

function fmtPnl(v) {
  if (v == null) return '<span class="dollar-potential">—</span>';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const cls  = v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral';
  return `<span class="dollar-profit ${cls}">${sign}$${Math.abs(v).toFixed(2)}</span>`;
}

function renderOUTracker(data) {
  const tbody   = document.getElementById('ou-tbody');
  const counter = document.getElementById('ou-game-count');
  const summary = document.getElementById('ou-summary');
  if (!tbody) return;

  const withLine = data.bets.filter(b => b.total_line != null);
  if (counter) counter.textContent = `${withLine.length} with line`;

  // Summary chips
  if (summary) {
    const overSign  = data.over_pnl  >= 0 ? '+' : '';
    const underSign = data.under_pnl >= 0 ? '+' : '';
    const overCls   = data.over_pnl  >= 0 ? 'positive' : 'negative';
    const underCls  = data.under_pnl >= 0 ? 'positive' : 'negative';
    summary.innerHTML = `
      <div class="pl-chip">
        <span class="pl-chip-label">Overs</span>
        <span class="pl-chip-value">${data.overs}W–${data.unders + data.pushes}L</span>
      </div>
      <div class="pl-chip">
        <span class="pl-chip-label">Unders</span>
        <span class="pl-chip-value">${data.unders}W–${data.overs + data.pushes}L</span>
      </div>
      <div class="pl-chip">
        <span class="pl-chip-label">$1/game Over P&amp;L</span>
        <span class="pl-chip-value ${overCls}">${overSign}$${Math.abs(data.over_pnl).toFixed(2)}</span>
      </div>
      <div class="pl-chip">
        <span class="pl-chip-label">$1/game Under P&amp;L</span>
        <span class="pl-chip-value ${underCls}">${underSign}$${Math.abs(data.under_pnl).toFixed(2)}</span>
      </div>`;
  }

  // Table (newest first)
  const display = [...data.bets].reverse();
  if (!display.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No games yet.</td></tr>';
  } else {
    tbody.innerHTML = display.map(b => {
      const opp  = b.is_home ? b.away_team : b.home_team;
      const ha   = b.is_home ? 'home' : 'away';
      const score = b.wild_score != null
        ? `<span class="badge ${b.result === 'win' ? 'badge-green' : b.result === 'loss' ? 'badge-red' : 'badge-neutral'}">${b.wild_score}–${b.opponent_score}</span>`
        : `<span class="badge badge-neutral">${b.status === 'inprogress' ? 'Live' : 'Upcoming'}</span>`;

      const totalDisplay = b.total_goals != null ? b.total_goals : '—';
      const lineDisplay  = b.total_line  != null
        ? `${b.total_line} <button class="enter-line-btn" data-game-id="${b.game_id}" data-total-line="${b.total_line}">edit</button>`
        : `<button class="enter-line-btn" data-game-id="${b.game_id}">+ line</button>`;

      return `<tr>
        <td class="col-date">${fmtDate(b.scheduled_at)}</td>
        <td class="col-matchup">${escHtml(opp)}</td>
        <td><span class="ha-badge ha-${ha}">${ha.toUpperCase()}</span></td>
        <td>${score}</td>
        <td class="col-right">${totalDisplay}</td>
        <td>${lineDisplay}</td>
        <td>${ouResultBadge(b.total_result)}</td>
        <td class="col-right">${fmtPnl(b.over_profit)}</td>
        <td class="col-right">${fmtPnl(b.under_profit)}</td>
      </tr>`;
    }).join('');
  }

  // P&L chart
  const settled = data.bets.filter(b => b.over_running_pnl != null);
  if (!settled.length) return;

  const labels     = settled.map(b => fmtDate(b.scheduled_at));
  const overData   = settled.map(b => b.over_running_pnl);
  const underData  = settled.map(b => b.under_running_pnl);

  if (ouChart) ouChart.destroy();
  const ctx = document.getElementById('ou-pnl-chart')?.getContext('2d');
  if (!ctx) return;

  ouChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Bet Over P&L',
          data: overData,
          borderColor: '#3fb950',
          backgroundColor: 'rgba(63,185,80,0.06)',
          fill: true,
          borderWidth: 2,
          pointRadius: 2,
          tension: 0,
        },
        {
          label: 'Bet Under P&L',
          data: underData,
          borderColor: '#388bfd',
          backgroundColor: 'rgba(56,139,253,0.06)',
          fill: true,
          borderWidth: 2,
          pointRadius: 2,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#8b949e', boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#161b22',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
          callbacks: {
            label: (item) => {
              const sign = item.raw >= 0 ? '+' : '';
              return ` ${item.dataset.label}: ${sign}$${Math.abs(item.raw).toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxTicksLimit: 12, maxRotation: 0 },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
        y: {
          ticks: { color: '#8b949e', callback: (v) => `$${v.toFixed(2)}` },
          grid: { color: '#21262d' },
          border: { color: '#30363d' },
        },
      },
    },
  });
}

// ─── Refresh ──────────────────────────────────────────────────────────────────────────

async function loadAll() {
  const btn = document.getElementById('btn-refresh');
  if (btn) btn.classList.add('spinning');

  const [statsRes, gamesRes, calibRes, sharpRes, dollarRes, pucklineRes, splitsRes, ouRes] =
    await Promise.allSettled([
      fetchStats(),
      fetchGames(),
      fetchCalibration(),
      fetchSharpMoves(),
      fetchDollarTracker(),
      fetchPuckLineTracker(),
      fetchSplits(),
      fetchOUTracker(),
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
    allGames = gamesRes.value.games ?? [];
    renderGamesTable(allGames);
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

  if (splitsRes.status === 'fulfilled') {
    renderSplits(splitsRes.value);
  } else {
    console.warn('Splits fetch failed:', splitsRes.reason);
  }

  if (calibRes.status === 'fulfilled') {
    renderCalibration(calibRes.value.calibration ?? []);
  } else {
    console.warn('Calibration fetch failed:', calibRes.reason);
  }

  if (dollarRes.status === 'fulfilled') {
    renderDollarTracker(dollarRes.value);
    renderDollarStatCard(dollarRes.value);
  } else {
    console.warn('Dollar tracker fetch failed:', dollarRes.reason);
    document.getElementById('dollar-tbody').innerHTML =
      '<tr><td colspan="7" class="empty">Could not load dollar tracker.</td></tr>';
  }

  if (pucklineRes.status === 'fulfilled') {
    renderPuckLineTracker(pucklineRes.value);
    renderTotalGoalsChart(pucklineRes.value.bets ?? []);
  } else {
    console.warn('Puck line fetch failed:', pucklineRes.reason);
    const el = document.getElementById('puckline-tbody');
    if (el) el.innerHTML = '<tr><td colspan="7" class="empty">Could not load puck line data.</td></tr>';
  }

  if (ouRes.status === 'fulfilled') {
    renderOUTracker(ouRes.value);
  } else {
    console.warn('O/U tracker fetch failed:', ouRes.reason);
    const el = document.getElementById('ou-tbody');
    if (el) el.innerHTML = '<tr><td colspan="9" class="empty">Could not load O/U data.</td></tr>';
  }

  // If a game was open, refresh its detail panel too
  if (activeGameId !== null) {
    const activeRow = document.querySelector(`.game-row[data-id="${activeGameId}"]`);
    if (activeRow) onGameRowClick(activeGameId, activeRow);
  }

  if (btn) btn.classList.remove('spinning');
}

// ─── Wire up controls ─────────────────────────────────────────────────────────

// ─── Season label ─────────────────────────────────────────────────────────────

/**
 * NHL season year: the season starting in YEAR runs as "YEAR–YY".
 * The season starts in October, so months Jan–Sep belong to the prior season.
 * e.g. March 2026 → season start 2025 → "2025–26"
 */
function currentSeasonLabel() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed
  const startYear = month >= 10 ? year : year - 1;
  const endYY = String(startYear + 1).slice(-2);
  return `Minnesota Wild · ${startYear}–${endYY}`;
}

document.addEventListener('DOMContentLoaded', () => {
  const seasonEl = document.getElementById('season-label');
  if (seasonEl) seasonEl.textContent = currentSeasonLabel();

  document.getElementById('btn-refresh')?.addEventListener('click', loadAll);
  document.getElementById('detail-close')?.addEventListener('click', closeDetailPanel);

  // Season type toggle — syncs the correct schedule then refreshes
  document.getElementById('season-toggle')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.season-toggle-btn');
    if (!btn) return;
    const type = btn.dataset.type;
    document.querySelectorAll('.season-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
    btn.disabled = true;
    try {
      await postSync(type);
      loadAll();
    } catch (err) {
      console.error('Sync failed:', err);
      alert('Sync failed — check the server console.');
    } finally {
      btn.disabled = false;
    }
  });

  // Opponent filter re-renders only the table rows client-side
  document.getElementById('opp-strength-filter')?.addEventListener('change', applyGamesFilter);

  // Settle past games (fetch final scores)
  document.getElementById('btn-settle')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-settle');
    btn.disabled = true;
    btn.textContent = 'Settling...';
    try {
      const result = await postSettle();
      alert(`Settle complete: ${result.settled} games settled. ${result.remaining} still pending.`);
      await loadAll();
    } catch (err) {
      console.error('Settle failed:', err);
      alert('Settle failed — check the console.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Settle Games';
    }
  });

  // Backfill historical odds from The Odds API
  document.getElementById('btn-backfill')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-backfill');
    btn.disabled = true;
    btn.textContent = 'Fetching…';
    try {
      const result = await postBackfillOdds();
      const note = result.not_found > 0 ? ` (${result.not_found} games too old — ESPN keeps ~16 weeks of data)` : '';
      alert(`Backfill complete: ${result.filled}/${result.total} games filled.${note}`);
      loadAll();
    } catch (err) {
      console.error('Backfill failed:', err);
      alert('Backfill failed — check the console. You may be out of Odds API credits.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Backfill Odds';
    }
  });

  // O/U "enter line" buttons (event delegation — rows are re-rendered each load)
  document.getElementById('ou-tbody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('.enter-line-btn');
    if (!btn) return;
    e.stopPropagation();
    const gameId   = Number(btn.dataset.gameId);
    const existing = btn.dataset.totalLine ?? '';
    const lineStr  = prompt(`Enter total line for game ${gameId}${existing ? ` (current: ${existing})` : ''}:`);
    if (!lineStr) return;
    const total_line = parseFloat(lineStr);
    if (isNaN(total_line) || total_line <= 0) { alert('Invalid total — enter a positive number like 6.5'); return; }
    try {
      await postTotalLine(gameId, { total_line });
      loadAll();
    } catch (err) {
      console.error('Failed to save total line:', err);
      alert('Failed to save. Check the console.');
    }
  });

  loadAll();
});
