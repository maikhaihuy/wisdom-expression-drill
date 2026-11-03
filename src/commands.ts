import { config } from "./config";
import { t } from "./i18n";
import type { Env } from "./index";
import { deliverBatch, drillRow, type Deps } from "./review";
import type { InlineKeyboardMarkup } from "./telegram";
import { formatDateTime, localDate } from "./time";
import { inviteCommand, type User } from "./users";
import { escapeHtml } from "./util";

export interface Reply {
  text: string;
  reply_markup?: InlineKeyboardMarkup;
}

const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;

// Returns the reply to send, or null when the command already sent its own message.
export async function handleCommand(env: Env, user: User, cmd: string, arg: string, now: number, deps: Deps): Promise<Reply | null> {
  const db = env.DB;
  switch (cmd) {
    case "next":
      return (await deliverBatch(env, user, now, deps.rng)) ? null : { text: t.emptyBank };

    case "drill": {
      const cfg = config(env);
      return { text: t.drillOpen(Math.round(cfg.drillSeconds / 60), cfg.cardSeconds), reply_markup: { inline_keyboard: [drillRow(cfg.drillUrl)] } };
    }

    case "pause": {
      const seconds = parsePause(arg);
      if (seconds === null) return { text: t.pauseUsage };
      const until = now + seconds;
      await db.prepare("UPDATE users SET paused_until = ? WHERE id = ?").bind(until, user.id).run();
      return { text: t.paused(formatDateTime(until, user.tz_offset_min)) };
    }

    case "resume":
      await db.prepare("UPDATE users SET paused_until = NULL WHERE id = ?").bind(user.id).run();
      return { text: t.resumed };

    case "tz": {
      const minutes = parseTz(arg);
      if (minutes === null) return { text: t.tzUsage };
      await db.prepare("UPDATE users SET tz_offset_min = ? WHERE id = ?").bind(minutes, user.id).run();
      return { text: t.tzSet(formatOffset(minutes), formatDateTime(now, minutes)) };
    }

    case "stats":
      return { text: t.stats(await getStats(db, user, now)) };

    case "hard":
      return { text: await hardList(db, user) };

    case "invite":
      return { text: await inviteCommand(db, user, now) };

    case "members":
      return { text: user.role === "admin" ? await membersList(db, user, now) : t.adminOnly };

    default:
      return { text: user.role === "admin" ? t.help + t.adminHelp : t.help };
  }
}

// ---------- Argument parsing (pure) ----------

// '3h' or '2d', from 1 hour to 30 days. Returns seconds.
export function parsePause(arg: string): number | null {
  const m = /^(\d+)\s*([hd])$/.exec(arg.trim().toLowerCase());
  if (!m) return null;
  const seconds = Number(m[1]) * (m[2] === "h" ? HOUR : DAY);
  return seconds >= HOUR && seconds <= 30 * DAY ? seconds : null;
}

// '+7', '-5', '+5:30' (sign optional), from -12:00 to +14:00. Returns minutes.
export function parseTz(arg: string): number | null {
  const m = /^([+-])?(\d{1,2})(?::([0-5]\d))?$/.exec(arg.trim());
  if (!m) return null;
  const minutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  return minutes >= -720 && minutes <= 840 ? minutes : null;
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const mm = abs % 60;
  return `${sign}${Math.floor(abs / 60)}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - DAY * 1000).toISOString().slice(0, 10);

// Consecutive local days with a graded answer, ending today (or yesterday if today has none yet).
export function computeStreak(dates: string[], today: string): number {
  const days = new Set(dates);
  let d = days.has(today) ? today : prevDay(today);
  let n = 0;
  while (days.has(d)) {
    n++;
    d = prevDay(d);
  }
  return n;
}

// ---------- Statistics ----------

const GRADED = "si.result IN ('hit', 'miss') AND si.answered_at IS NOT NULL";

export async function getStats(db: D1Database, user: User, now: number) {
  const [bank, boxes, week, days] = await db.batch<Record<string, number | string | null>>([
    db.prepare("SELECT COUNT(*) AS n FROM expressions WHERE archived = 0"),
    db
      .prepare(
        `SELECT c.box, COUNT(*) AS n FROM card_state c JOIN expressions e ON e.id = c.expr_id
         WHERE c.user_id = ? AND e.archived = 0 GROUP BY c.box`,
      )
      .bind(user.id),
    db
      .prepare(
        `SELECT SUM(si.result = 'hit') AS hits, COUNT(*) AS graded FROM session_items si JOIN sessions s ON s.id = si.session_id
         WHERE s.user_id = ? AND ${GRADED} AND si.answered_at >= ?`,
      )
      .bind(user.id, now - WEEK),
    db
      .prepare(
        `SELECT DISTINCT date(si.answered_at + ?2 * 60, 'unixepoch') AS d FROM session_items si JOIN sessions s ON s.id = si.session_id
         WHERE s.user_id = ?1 AND ${GRADED} ORDER BY d DESC LIMIT 400`,
      )
      .bind(user.id, user.tz_offset_min),
  ]);

  const perBox = [0, 0, 0, 0, 0, 0];
  for (const row of boxes.results) perBox[(row.box as number) - 1] = row.n as number;
  const graded = (week.results[0]?.graded as number) ?? 0;
  return {
    bank: bank.results[0].n as number,
    seen: perBox.reduce((a, b) => a + b, 0),
    boxes: perBox,
    accuracy: graded ? ((week.results[0].hits as number) ?? 0) / graded : null,
    streak: computeStreak(days.results.map((r) => r.d as string), localDate(now, user.tz_offset_min)),
  };
}

async function hardList(db: D1Database, user: User): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT e.en, e.cue, c.hits, c.misses FROM card_state c JOIN expressions e ON e.id = c.expr_id
       WHERE c.user_id = ? AND e.archived = 0 AND c.hits + c.misses >= 3
       ORDER BY (c.misses + 1.0) / (c.hits + c.misses + 2) DESC, c.misses DESC LIMIT 10`,
    )
    .bind(user.id)
    .all<{ en: string; cue: string; hits: number; misses: number }>();
  if (!results.length) return t.hardEmpty;
  const lines = results.map((r) => `• <b>${escapeHtml(r.en)}</b> — ${escapeHtml(r.cue)} (✓${r.hits} ✗${r.misses})`);
  return `${t.hardTitle}\n${lines.join("\n")}`;
}

async function membersList(db: D1Database, admin: User, now: number): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.role, u.active,
         (SELECT MAX(si.answered_at) FROM session_items si JOIN sessions s ON s.id = si.session_id
          WHERE s.user_id = u.id AND ${GRADED}) AS last_at,
         (SELECT SUM(si.result = 'hit') FROM session_items si JOIN sessions s ON s.id = si.session_id
          WHERE s.user_id = u.id AND ${GRADED} AND si.answered_at >= ?1) AS hits7,
         (SELECT COUNT(*) FROM session_items si JOIN sessions s ON s.id = si.session_id
          WHERE s.user_id = u.id AND ${GRADED} AND si.answered_at >= ?1) AS graded7
       FROM users u ORDER BY u.created_at, u.id`,
    )
    .bind(now - WEEK)
    .all<{ id: number; name: string; role: string; active: number; last_at: number | null; hits7: number | null; graded7: number }>();

  const lines = results.map((u) => {
    const status = u.active ? "🟢" : "⚪️";
    const role = u.role === "admin" ? " (admin)" : "";
    const last = u.last_at ? localDate(u.last_at, admin.tz_offset_min) : t.never;
    const acc = u.graded7 ? `${Math.round(((u.hits7 ?? 0) / u.graded7) * 100)}%` : "–";
    return `${status} ${escapeHtml(u.name)}${role} · ${last} · 7 ngày: ${acc}`;
  });
  return `${t.membersTitle}\n${lines.join("\n")}`;
}
