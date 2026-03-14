'use strict';

const nodemailer = require('nodemailer');

/**
 * Returns a nodemailer transporter configured for Gmail SMTP.
 * Returns null and logs a warning if the required env vars are missing,
 * so the rest of the app continues without email alerts.
 */
function createTransporter() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.warn('[mailer] GMAIL_USER / GMAIL_APP_PASSWORD not set — email alerts disabled.');
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
}

/**
 * Send an email.  Safe to call — silently skips if transport is unconfigured.
 *
 * @param {{ subject: string, text: string }} opts
 */
async function sendAlert({ subject, text }) {
  const { ALERT_EMAIL, GMAIL_USER } = process.env;
  if (!ALERT_EMAIL) return; // Alerting not configured

  const transporter = createTransporter();
  if (!transporter) return;

  try {
    await transporter.sendMail({
      from:    `"Wild Odds Tracker" <${GMAIL_USER}>`,
      to:      ALERT_EMAIL,
      subject,
      text,
    });
    console.log(`[mailer] Alert sent: ${subject}`);
  } catch (err) {
    console.error('[mailer] Failed to send email:', err.message);
  }
}

// ─── Alert composers ──────────────────────────────────────────────────────────

/**
 * Send a sharp-move alert.
 *
 * @param {{
 *   game:          object,   // games DB row
 *   bookmaker:     string,
 *   old_moneyline: number,
 *   new_moneyline: number,
 *   move_size:     number,
 * }} opts
 */
function sendSharpMoveAlert({ game, bookmaker, old_moneyline, new_moneyline, move_size }) {
  const opponent  = game.is_home ? game.away_team : game.home_team;
  const venue     = game.is_home ? 'vs' : '@';
  const signOld   = old_moneyline > 0 ? '+' : '';
  const signNew   = new_moneyline > 0 ? '+' : '';
  const gameDate  = new Date(game.scheduled_at).toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const subject = `[Wild Tracker] Sharp Move: ${bookmaker} ${signOld}${old_moneyline} → ${signNew}${new_moneyline}`;
  const text = [
    `Sharp line movement detected!`,
    ``,
    `Game:       Minnesota Wild ${venue} ${opponent}`,
    `Date:       ${gameDate} CT`,
    `Book:       ${bookmaker}`,
    `Movement:   ${signOld}${old_moneyline} → ${signNew}${new_moneyline} (${move_size} cents)`,
  ].join('\n');

  return sendAlert({ subject, text });
}

/**
 * Send a game-settled alert.
 *
 * @param {{
 *   game:       object,  // games DB row (already updated)
 *   pin_clv:    number|null,
 *   dk_clv:     number|null,
 *   fd_clv:     number|null,
 *   betmgm_clv: number|null,
 * }} opts
 */
function sendSettleAlert({ game, pin_clv, dk_clv, fd_clv, betmgm_clv }) {
  const opponent  = game.is_home ? game.away_team : game.home_team;
  const venue     = game.is_home ? 'vs' : '@';
  const resultStr = game.result ? game.result.toUpperCase() : 'UNKNOWN';

  const fmtClv = (v, label) =>
    v != null ? `${label} CLV:    ${v > 0 ? '+' : ''}${v.toFixed(2)}%` : null;

  const clvLines = [
    fmtClv(pin_clv,    'Pinnacle  '),
    fmtClv(dk_clv,     'DraftKings'),
    fmtClv(fd_clv,     'FanDuel   '),
    fmtClv(betmgm_clv, 'BetMGM    '),
  ].filter(Boolean);

  const subject = `[Wild Tracker] Game Settled: Wild ${resultStr} ${venue} ${opponent} `
    + `(${game.wild_score}–${game.opponent_score})`;

  const text = [
    `Game Result`,
    ``,
    `Minnesota Wild ${venue} ${opponent}`,
    `Final score: Wild ${game.wild_score}–${game.opponent_score}  (${resultStr})`,
    ``,
    ...(clvLines.length ? ['Closing Line Value:', ...clvLines] : ['No CLV data yet.']),
  ].join('\n');

  return sendAlert({ subject, text });
}

module.exports = { sendSharpMoveAlert, sendSettleAlert };
