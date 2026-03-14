# Wild Odds Tracker

A Node.js application that automatically tracks Minnesota Wild moneyline odds, detects sharp movement, and records results — so you can measure your Closing Line Value (CLV) and Expected Value (EV) over time.

## Quick start

```bash
cp .env.example .env
# Fill in your API keys (see Environment Variables section below)
npm install
npm start
```

The server starts on `http://localhost:3000`.  On startup it immediately syncs the Wild schedule from SportRadar, then runs all three cron jobs on their normal schedules.

## Project structure

```
wild-tracker/
├── index.js                 Express app + REST API entry point
├── src/
│   ├── calculator.js        Pure math: implied prob, CLV, EV, de-juice
│   ├── db.js                SQLite schema + all query helpers
│   ├── mailer.js            Nodemailer Gmail alert composer
│   ├── metrics.js           CLV/EV orchestration per bookmaker
│   ├── odds-fetcher.js      The Odds API (DraftKings, FanDuel, BetMGM, Pinnacle)
│   ├── results-fetcher.js   SportRadar: schedule, results, context, standings
│   └── scheduler.js         node-cron jobs
├── data/                    SQLite database (git-ignored)
├── .env.example
└── test.js                  Smoke tests (npm test)
```

## Environment variables

Copy `.env.example` to `.env` and fill in the values.

| Variable | Required | Description |
|---|---|---|
| `SPORTRADAR_API_KEY` | ✅ | SportRadar NHL API key |
| `ODDS_API_KEY` | ✅ | The Odds API key |
| `ALERT_EMAIL` | optional | Address that receives email alerts |
| `GMAIL_USER` | optional | Gmail address used as sender |
| `GMAIL_APP_PASSWORD` | optional | Gmail [App Password](https://support.google.com/accounts/answer/185833) (16 chars, not your regular password) |
| `PORT` | optional | Express port — default `3000` |
| `DB_PATH` | optional | Absolute path to SQLite file — default `./data/wild.db` |
| `CRON_TZ` | optional | Timezone for cron schedules — default `America/Chicago` |

Email alerts are silently disabled if `GMAIL_USER`, `GMAIL_APP_PASSWORD`, or `ALERT_EMAIL` are absent.

## Database schema

| Table | Purpose |
|---|---|
| `games` | One row per Wild game; schedule, scores, context, result, and user's `my_moneyline` estimate |
| `odds_snapshots` | Every poll per bookmaker, tagged `opening / hourly / closing` |
| `game_metrics` | Per-bookmaker CLV, EV, opening/closing lines; upserted on settle |
| `sharp_move_events` | One row per detected ≥10-cent line move; tracks alert status |
| `model_predictions` | User/model win-probability estimate per game (0–1), used for calibration |

### Context columns on `games`

| Column | Description |
|---|---|
| `wild_days_rest` | Days since Wild's previous game |
| `opp_days_rest` | Days since opponent's previous game |
| `opp_wins` / `opp_losses` / `opp_ot_losses` | Opponent's current season record |
| `opp_last10_wins` / `opp_last10_losses` | Opponent's last-10 record |

## REST API

### Game data

| Method | Route | Description |
|---|---|---|
| `GET` | `/games` | All Wild games (newest first) with per-book metrics |
| `GET` | `/games/:id/snapshots` | Full odds-snapshot history |
| `GET` | `/games/:id/sharp-moves` | All sharp-move events for one game |
| `POST` | `/games/:id/estimate` | Set your opening moneyline estimate `{ "moneyline": -130 }` |
| `POST` | `/games/:id/predict` | Store a win-probability estimate `{ "my_prob": 0.62 }` |

### Analytics

| Method | Route | Description |
|---|---|---|
| `GET` | `/stats` | Win rate, avg CLV per book, avg EV, ROI |
| `GET` | `/stats/calibration` | All `(my_prob, outcome)` pairs for calibration curve plotting |

### Manual triggers

| Method | Route | Description |
|---|---|---|
| `POST` | `/sync` | Re-sync Wild schedule from SportRadar |
| `POST` | `/poll-odds` | Capture an odds snapshot right now |
| `POST` | `/settle` | Try to settle all outstanding games |

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
