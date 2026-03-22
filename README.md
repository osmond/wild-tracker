# Wild Odds Tracker

A Node.js application that automatically tracks Minnesota Wild moneyline odds, detects sharp movement, and records results — so you can measure your Closing Line Value (CLV) and Expected Value (EV) over time. Includes a Vite + Chart.js dashboard for visualising everything in the browser.

## Quick start

```bash
cp .env.example .env
# Fill in your API keys (see Environment Variables section below)
npm install
npm start
```

The server starts on `http://localhost:3000` and serves the pre-built client from `client/dist/` when it exists. On startup it immediately syncs the Wild schedule from SportRadar, then runs all three cron jobs on their normal schedules.

### Running the dev client

The front-end dev server runs on `http://localhost:5173` and proxies all `/api/*` requests to the Express server on port 3000.

```bash
# In a second terminal:
npm run client:dev
```

### Building for production

```bash
npm run build          # installs client deps + builds Vite bundle into client/dist/
npm start              # Express serves the built dashboard at http://localhost:3000
```

## Project structure

```
wild-tracker/
├── index.js                 Express app + REST API entry point
├── src/
│   ├── calculator.js        Pure math: implied prob, CLV, EV, de-juice
│   ├── db.js                SQLite schema + all query helpers
│   ├── mailer.js            Nodemailer Gmail alert composer
│   ├── metrics.js           CLV/EV orchestration per bookmaker
│   ├── odds-fetcher.js      The Odds API + ESPN public API (odds + history)
│   ├── results-fetcher.js   SportRadar: schedule, results, context, standings
│   └── scheduler.js         node-cron jobs
├── client/
│   ├── index.html           Single-page dashboard shell
│   ├── vite.config.js       Vite config (dev proxy → :3000, build → dist/)
│   └── src/
│       ├── api.js           Thin fetch wrappers for every REST endpoint
│       ├── main.js          Dashboard JS — charts, tables, stats bar
│       └── style.css        Dark-theme stylesheet
├── data/                    SQLite database (git-ignored)
├── .env.example
└── test.js                  Smoke tests (npm test)
```

## npm scripts

| Script | What it does |
|---|---|
| `npm start` | Start Express server (`node index.js`) |
| `npm run dev` | Start Express with `--watch` auto-reload |
| `npm test` | Run smoke tests |
| `npm run client:dev` | Start Vite dev server on :5173 |
| `npm run client:build` | Build Vite bundle into `client/dist/` |
| `npm run client:install` | Install client npm dependencies |
| `npm run build` | `client:install` + `client:build` (production build) |

## Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable | Required | Description |
|---|---|---|
| `ODDS_API_KEY` | ✅ | The Odds API key |
| `SPORTRADAR_API_KEY` | recommended | SportRadar NHL API key — server starts without it but schedule/result data will fall back to the free NHL API only |
| `ALERT_EMAIL` | optional | Address that receives email alerts |
| `GMAIL_USER` | optional | Gmail address used as sender |
| `GMAIL_APP_PASSWORD` | optional | Gmail [App Password](https://support.google.com/accounts/answer/185833) (16 chars, not your regular password) |
| `ADMIN_KEY` | optional | Shared secret that protects write/trigger endpoints. Set to any random string to enable. If absent, all endpoints are unrestricted (dev convenience). |
| `PORT` | optional | Express port — default `3000` |
| `DB_PATH` | optional | Absolute path to SQLite file — default `./data/wild.db` |
| `CRON_TZ` | optional | Timezone for cron schedules — default `America/Chicago` |

Email alerts are silently disabled if `GMAIL_USER`, `GMAIL_APP_PASSWORD`, or `ALERT_EMAIL` are absent.

### Client-side env (Vite)

Create `client/.env.local` to configure the browser dashboard:

| Variable | Description |
|---|---|
| `VITE_ADMIN_KEY` | Same value as `ADMIN_KEY`. Passed as `Authorization: Bearer …` on admin button clicks in the UI. |

## Database schema

| Table | Purpose |
|---|---|
| `games` | One row per Wild game; schedule, scores, context, result, puck-line and total results, and user's `my_moneyline` estimate |
| `odds_snapshots` | Every poll per bookmaker, tagged `opening / hourly / closing`; includes total and spread markets |
| `game_metrics` | Per-bookmaker CLV, EV, opening/closing moneylines, totals, and spreads; upserted on settle |
| `sharp_move_events` | One row per detected ≥10-cent line move; tracks alert status |
| `model_predictions` | User/model win-probability estimate per game (0–1), used for calibration |

### Context columns on `games`

| Column | Description |
|---|---|
| `wild_days_rest` | Days since Wild's previous game |
| `opp_days_rest` | Days since opponent's previous game |
| `opp_wins` / `opp_losses` / `opp_ot_losses` | Opponent's current season record |
| `opp_last10_wins` / `opp_last10_losses` | Opponent's last-10 record |
| `total_result` | `over` / `under` / `push` / `null` once settled |
| `puckline_minus_covered` | `1` if Wild won by 2+ (covered -1.5), `0` otherwise, `null` if unsettled |

## REST API

### Authentication

Protected endpoints require `Authorization: Bearer <ADMIN_KEY>` when `ADMIN_KEY` is set in `.env`. If `ADMIN_KEY` is not configured, all endpoints are open (development convenience).

### Game data

| Method | Route | Description |
|---|---|---|
| `GET` | `/games` | All Wild games (newest first) with per-book metrics |
| `GET` | `/games/:id` | Single game detail merged with all odds snapshots |
| `GET` | `/games/:id/snapshots` | Full odds-snapshot history |
| `GET` | `/games/:id/sharp-moves` | All sharp-move events for one game |
| `POST` | `/games/:id/estimate` | Set your opening moneyline estimate `{ "moneyline": -130 }` |
| `POST` | `/games/:id/predict` | Store a win-probability estimate `{ "my_prob": 0.62 }` |
| `POST` | `/games/:id/total-line` | Manually enter a total line and/or spread odds for a game (useful for historical backfill). Body: `{ "total_line": 6.5, "over_odds": -115, "under_odds": -105, "wild_spread_odds": 180, "opp_spread_odds": -210 }` |

### Analytics

| Method | Route | Description |
|---|---|---|
| `GET` | `/stats` | Win rate, avg CLV per book, avg EV, ROI, current streak |
| `GET` | `/stats/splits` | W/L records by home/away, back-to-back, vs .500+, vs <.500, and last-10 |
| `GET` | `/stats/calibration` | All `(my_prob, outcome)` pairs for calibration curve plotting |
| `GET` | `/dollar-tracker` | Every game with a hypothetical $1 bet on the Wild at market closing line — per-game profit/loss and cumulative running P&L |
| `GET` | `/puck-line-tracker` | Puck line (±1.5) coverage results and running per-game P&L derived from closing spread odds |
| `GET` | `/ou-tracker` | Total goals tracker — over/under result per game with running $1 P&L for "bet every over" and "bet every under" strategies |
| `GET` | `/sharp-moves` | All detected sharp-move events across every game, newest first |

### Manual triggers (admin-protected)

| Method | Route | Description |
|---|---|---|
| `POST` | `/sync` | Re-sync Wild schedule from SportRadar. Optional query/body: `?type=REG\|PST\|PRE` |
| `POST` | `/poll-odds` | Capture an odds snapshot right now |
| `POST` | `/settle` | Try to settle all outstanding games |
| `POST` | `/admin/settle` | Same as `/settle` — explicit admin path used by the UI |
| `POST` | `/admin/backfill-odds` | Fetch historical total/spread odds from ESPN's public API for all settled games missing a closing total line. Add `?dryRun=true` to preview without writing. |
| `POST` | `/admin/backfill-snapshots` | For every closed game with no snapshots, fetch ESPN opening/closing moneylines and insert synthetic `opening`/`hourly` snapshots. |

## Client dashboard

The front-end is a single-page dashboard built with vanilla JS + [Chart.js](https://www.chartjs.org/). It is bundled by Vite and served statically by Express in production.

### Sections

| Section | What it shows |
|---|---|
| **Stats bar** | Win rate, avg CLV, ROI, $1/game P&L, sharp-move count, current streak, O/U record |
| **Splits bar** | Home/Away, Back-to-Back, vs .500+, vs <.500, Last-10 W/L records |
| **Games table** | All games with opening/closing moneylines, CLV, result; click any row to expand the odds timeline chart and context strip |
| **$1 Bet Tracker** | Running P&L line chart + monthly bar chart + per-game table for a hypothetical $1 bet on the Wild every game |
| **Puck Line Coverage** | ±1.5 coverage rates and running P&L curves with a per-game table |
| **Total Goals Per Game** | Bar chart of combined final-score goals for every settled game |
| **O/U Tracker** | Over/under results with running P&L curves for both sides and a per-game table |

### Admin tools (header buttons)

The header exposes three admin buttons — **Settle**, **Backfill Odds**, and **Backfill Timeline** — that POST to the corresponding `/admin/*` endpoints. Set `VITE_ADMIN_KEY` in `client/.env.local` to authorise them.

The **Regular Season / Playoffs** toggle switches the schedule-sync target between `REG` and `PST` season types.

## Cron schedule (Central Time)

| Job | Schedule | What |
|---|---|---|
| `syncSchedule` | 06:00 daily + startup | Upserts Wild games + contextual data from SportRadar |
| `pollOdds` | Top of every hour | Captures opening/hourly/closing snapshots; detects sharp moves |
| `settleGames` | Every 30 minutes | Fetches final scores; calculates CLV/EV; sends settle email |

## Metrics explained

### Implied probability
De-juiced win probability derived from both sides of the market (vig removed).

$$\text{prob}_i = \frac{\text{raw}_i}{\text{raw}_1 + \text{raw}_2}$$

### CLV (Closing Line Value)
Measures whether `closing_prob` validated your opening estimate.

$$\text{CLV\%} = \left(\frac{p_\text{close}}{p_\text{mine}} - 1\right) \times 100$$

Positive CLV → market moved to confirm your view.

### EV (Expected Value)
Expected return per unit at the opening line, given your probability.

$$\text{EV\%} = \bigl(p_\text{mine} \times d_\text{open} - 1\bigr) \times 100$$

where $d_\text{open}$ is the decimal equivalent of the Wild's opening American odds.

### Sharp move detection
Any line movement of **≥ 10 American-odds points** between consecutive snapshots triggers a `sharp_move_events` row and an email alert.

### ROI
Assumes 1 unit wagered per game at the Pinnacle closing line (falls back to DraftKings).

## Bookmakers tracked

- **Pinnacle** (sharpest market, CLV reference)
- **DraftKings**
- **FanDuel**
- **BetMGM**

Historical backfill uses **ESPN's free public summary API** (no key required). ESPN typically retains betting data for ~16 weeks; earlier games may return `not_found`.
