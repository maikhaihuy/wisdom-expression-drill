import { config, type Config } from "./config";
import { t } from "./i18n";
import type { Env } from "./index";
import { applyResult, selectBatch, type CardState, type QuietWindow, type Result } from "./srs";
import {
  editMessageReplyMarkup,
  sendMessage,
  TelegramError,
  UserBlockedError,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type TgCallbackQuery,
} from "./telegram";
import { formatTime, isBatchHour, localDate, localHour } from "./time";
import { deactivate, type User } from "./users";
import { escapeHtml } from "./util";

export interface BatchItem {
  id: string;
  en: string;
  cue: string;
  examples: string; // JSON array
  box: number;
  due_at: number;
  hits: number;
  misses: number;
  isNew: boolean;
}

export interface BatchPlan {
  sessionId: string;
  userId: number;
  items: BatchItem[];
  newCount: number;
}

export interface Session {
  id: string;
  user_id: number;
  kind: "batch" | "drill";
  message_id: number | null;
  created_at: number;
  closed_at: number | null;
}

export interface Deps {
  rng: () => number;
  delayMs: number;
}

export const defaultDeps: Deps = { rng: Math.random, delayMs: 50 };

// ---------- Selection ----------

const CANDIDATE_COLUMNS = "e.id, e.en, e.cue, e.examples, c.box, c.due_at, c.hits, c.misses";
const NOT_DUE_LIMIT = 50;
const FRESH_LIMIT = 50;

export function newToday(user: User, now: number): number {
  return user.new_today_date === localDate(now, user.tz_offset_min) ? user.new_today : 0;
}

// Loads candidates for every user in ONE D1 batch (one query against the per-invocation
// limit), then selects each user's batch. Users with nothing to review map to null.
export async function planBatches(
  db: D1Database,
  users: User[],
  now: number,
  cfg: Config,
  rng: () => number,
): Promise<Map<number, BatchPlan | null>> {
  const plans = new Map<number, BatchPlan | null>();
  if (!users.length) return plans;

  const stmts = users.flatMap((u) => [
    db
      .prepare(
        `SELECT ${CANDIDATE_COLUMNS} FROM card_state c JOIN expressions e ON e.id = c.expr_id
         WHERE c.user_id = ?1 AND e.archived = 0 AND c.due_at <= ?2`,
      )
      .bind(u.id, now),
    db
      .prepare(
        `SELECT e.id, e.en, e.cue, e.examples, 0 AS box, 0 AS due_at, 0 AS hits, 0 AS misses FROM expressions e
         WHERE e.archived = 0 AND NOT EXISTS (SELECT 1 FROM card_state c WHERE c.user_id = ?1 AND c.expr_id = e.id)
         ORDER BY e.unit, e.position, e.id LIMIT ?2`,
      )
      .bind(u.id, FRESH_LIMIT),
    db
      .prepare(
        `SELECT ${CANDIDATE_COLUMNS} FROM card_state c JOIN expressions e ON e.id = c.expr_id
         WHERE c.user_id = ?1 AND e.archived = 0 AND c.due_at > ?2
         ORDER BY (c.misses + 1.0) / (c.hits + c.misses + 2) DESC LIMIT ?3`,
      )
      .bind(u.id, now, NOT_DUE_LIMIT),
    db
      .prepare(
        `SELECT expr_id FROM session_items WHERE session_id =
           (SELECT id FROM sessions WHERE user_id = ?1 AND kind = 'batch' ORDER BY created_at DESC LIMIT 1)`,
      )
      .bind(u.id),
  ]);
  const results = await db.batch<Record<string, unknown>>(stmts);

  users.forEach((user, i) => {
    const [due, fresh, notDue, prev] = results.slice(i * 4, i * 4 + 4).map((r) => r.results);
    const asItems = (rows: Record<string, unknown>[], isNew: boolean) => rows.map((r) => ({ ...(r as unknown as BatchItem), isNew }));
    const items = selectBatch({
      due: asItems(due, false),
      fresh: asItems(fresh, true),
      notDue: asItems(notDue, false),
      previousBatchIds: new Set(prev.map((r) => r.expr_id as string)),
      newAllowed: Math.max(0, Math.min(cfg.newPerBatch, cfg.newPerDay - newToday(user, now))),
      min: cfg.batchMin,
      max: cfg.batchMax,
      rng,
    });
    plans.set(
      user.id,
      items.length ? { sessionId: `b-${user.id}-${now}`, userId: user.id, items, newCount: items.filter((x) => x.isNew).length } : null,
    );
  });
  return plans;
}

// Records a sent batch: closes the user's open batches (every item becomes skip; marks
// were never applied), creates the session and its items, and counts new expressions.
// Returns the message ids of the batches it closed, so their buttons can be removed.
export async function createBatch(db: D1Database, plan: BatchPlan, messageId: number | null, user: User, now: number): Promise<number[]> {
  const today = localDate(now, user.tz_offset_min);
  const [, closed] = await db.batch<{ message_id: number | null }>([
    db
      .prepare(
        `UPDATE session_items SET result = 'skip', answered_at = NULL WHERE session_id IN
           (SELECT id FROM sessions WHERE user_id = ? AND kind = 'batch' AND closed_at IS NULL)`,
      )
      .bind(plan.userId),
    db
      .prepare("UPDATE sessions SET closed_at = ? WHERE user_id = ? AND kind = 'batch' AND closed_at IS NULL RETURNING message_id")
      .bind(now, plan.userId),
    db
      .prepare("INSERT INTO sessions (id, user_id, kind, message_id, created_at) VALUES (?, ?, 'batch', ?, ?)")
      .bind(plan.sessionId, plan.userId, messageId, now),
    db
      .prepare("INSERT INTO session_items (session_id, pos, expr_id) SELECT ?1, key + 1, value FROM json_each(?2)")
      .bind(plan.sessionId, JSON.stringify(plan.items.map((x) => x.id))),
    db
      .prepare(
        `UPDATE users SET new_today = CASE WHEN new_today_date = ?2 THEN new_today + ?3 ELSE ?3 END, new_today_date = ?2
         WHERE id = ?1`,
      )
      .bind(plan.userId, today, plan.newCount),
  ]);
  return closed.results.map((r) => r.message_id).filter((id): id is number => id !== null);
}

// ---------- Rendering ----------

const MARK_LABEL: Record<string, string> = { hit: "✓", miss: "✗" };

export function batchKeyboard(sessionId: string, marks: (Result | null)[], extraRows: InlineKeyboardButton[][] = []): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  marks.forEach((m, i) => {
    if (i % 5 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: `${i + 1} ${(m && MARK_LABEL[m]) ?? "·"}`, callback_data: `t:${sessionId}:${i + 1}` });
  });
  rows.push([
    { text: t.allCorrect, callback_data: `a:${sessionId}` },
    { text: t.commit, callback_data: `c:${sessionId}` },
  ]);
  return { inline_keyboard: [...rows, ...extraRows] };
}

// The open batch's marks live only in its inline keyboard: item buttons are labelled
// `<pos> ·|✓|✗` with callback_data `t:<sid>:<pos>`. These two PURE functions read and
// cycle them, so a toggle needs no D1 round trip.

const LABEL_MARK: Record<string, Result | null> = { "·": null, "✓": "hit", "✗": "miss" };
const ITEM_DATA = /^t:[^:]+:(\d+)$/;
const ITEM_LABEL = /^(\d+) (·|✓|✗)$/;

export function readMarks(keyboard: InlineKeyboardMarkup | undefined): Map<number, Result | null> {
  const marks = new Map<number, Result | null>();
  for (const button of keyboard?.inline_keyboard.flat() ?? []) {
    const pos = ITEM_DATA.exec(button.callback_data ?? "")?.[1];
    const label = ITEM_LABEL.exec(button.text);
    if (pos && label) marks.set(Number(pos), LABEL_MARK[label[2]]);
  }
  return marks;
}

const NEXT_MARK: Record<string, string> = { "·": "✓", "✓": "✗", "✗": "·" };

// Cycles item `pos` · → ✓ → ✗ → ·. Every other button, and every callback_data, is kept.
// Returns null when the keyboard has no such item.
export function toggleKeyboard(keyboard: InlineKeyboardMarkup | undefined, pos: number): InlineKeyboardMarkup | null {
  let found = false;
  const rows = (keyboard?.inline_keyboard ?? []).map((row) =>
    row.map((button) => {
      const label = ITEM_LABEL.exec(button.text);
      if (!label || Number(ITEM_DATA.exec(button.callback_data ?? "")?.[1]) !== pos) return button;
      found = true;
      return { ...button, text: `${label[1]} ${NEXT_MARK[label[2]]}` };
    }),
  );
  return found ? { inline_keyboard: rows } : null;
}

export function drillRow(drillUrl: string): InlineKeyboardButton[] {
  return [{ text: t.drillButton, web_app: { url: drillUrl } }];
}

export function renderBatch(plan: BatchPlan, now: number, tzMin: number, drillUrl: string | null): { text: string; reply_markup: InlineKeyboardMarkup } {
  const lines = plan.items.map((it, i) => `${i + 1}. ${escapeHtml(it.cue)}\n   <tg-spoiler>${escapeHtml(it.en)}</tg-spoiler>`);
  const text = [t.batchHeader(formatTime(now, tzMin), plan.items.length, plan.newCount), lines.join("\n"), t.batchFooter].join("\n\n");
  const marks = plan.items.map(() => null);
  return { text, reply_markup: batchKeyboard(plan.sessionId, marks, drillUrl ? [drillRow(drillUrl)] : []) };
}

// ---------- Delivery ----------

async function sendPlan(env: Env, user: User, plan: BatchPlan, now: number, drillUrl: string | null): Promise<void> {
  const msg = renderBatch(plan, now, user.tz_offset_min, drillUrl);
  const sent = await sendMessage(env.TELEGRAM_BOT_TOKEN, user.id, msg.text, { parse_mode: "HTML", reply_markup: msg.reply_markup });
  const closed = await createBatch(env.DB, plan, sent.message_id, user, now);
  // Item taps never read D1, so a closed batch must not keep tappable buttons.
  for (const messageId of closed) await editKeyboard(env.TELEGRAM_BOT_TOKEN, user.id, messageId, { inline_keyboard: [] });
}

// Sends a batch right away (/next). Returns false when there is nothing to review.
export async function deliverBatch(env: Env, user: User, now: number, rng: () => number): Promise<boolean> {
  const plan = (await planBatches(env.DB, [user], now, config(env), rng)).get(user.id);
  if (!plan) return false;
  await sendPlan(env, user, plan, now, null);
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Hourly cron. D1 cost: 1 user query + 1 candidate batch + 1 write batch per user.
export async function runSchedule(env: Env, now: number, deps: Deps = defaultDeps): Promise<void> {
  const cfg = config(env);
  const { results } = await env.DB.prepare("SELECT * FROM users WHERE active = 1 AND (paused_until IS NULL OR paused_until <= ?)")
    .bind(now)
    .all<User>();
  const users = results.filter((u) => isBatchHour(now, u.tz_offset_min, cfg.batchHours));
  const plans = await planBatches(env.DB, users, now, cfg, deps.rng);

  let sent = 0;
  for (const user of users) {
    const plan = plans.get(user.id);
    if (!plan) continue;
    if (sent++ && deps.delayMs) await sleep(deps.delayMs);
    try {
      const tz = user.tz_offset_min;
      const drill = localHour(now, tz) === cfg.drillReminderHour && user.last_drill_date !== localDate(now, tz);
      await sendPlan(env, user, plan, now, drill ? cfg.drillUrl : null);
    } catch (err) {
      if (err instanceof UserBlockedError) await deactivate(env.DB, user.id);
      else console.error(`batch for user ${user.id} failed`, err);
    }
  }
}

// ---------- Grading ----------

export function getSession(db: D1Database, id: string): Promise<Session | null> {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<Session>();
}

export function getOpenBatch(db: D1Database, userId: number): Promise<Session | null> {
  return db
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND kind = 'batch' AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .bind(userId)
    .first<Session>();
}

async function getMarks(db: D1Database, sessionId: string): Promise<(Result | null)[]> {
  const { results } = await db
    .prepare("SELECT result FROM session_items WHERE session_id = ? ORDER BY pos")
    .bind(sessionId)
    .all<{ result: Result | null }>();
  return results.map((r) => r.result);
}

const OPEN = "EXISTS (SELECT 1 FROM sessions WHERE id = ?1 AND closed_at IS NULL)";

export interface CommitSummary {
  hits: number;
  graded: number;
  misses: { en: string; cue: string; example: string | null }[];
}

interface CommitRow {
  pos: number;
  expr_id: string;
  result: Result | null;
  en: string;
  cue: string;
  examples: string;
  box: number | null;
  due_at: number | null;
  hits: number | null;
  misses: number | null;
  lapses: number | null;
  last_seen_at: number | null;
}

// Applies the final results in one transaction. Every write is guarded by the session
// still being open and the close comes last, so a second commit applies nothing.
// `resolve` turns the current marks into final results. Returns null if already closed.
export async function commitBatch(
  db: D1Database,
  session: Session,
  user: User,
  resolve: (marks: (Result | null)[]) => Result[],
  now: number,
  quiet: QuietWindow,
): Promise<CommitSummary | null> {
  const { results: rows } = await db
    .prepare(
      `SELECT si.pos, si.expr_id, si.result, e.en, e.cue, e.examples,
              c.box, c.due_at, c.hits, c.misses, c.lapses, c.last_seen_at
       FROM session_items si
       JOIN expressions e ON e.id = si.expr_id
       LEFT JOIN card_state c ON c.user_id = ?2 AND c.expr_id = si.expr_id
       WHERE si.session_id = ?1 ORDER BY si.pos`,
    )
    .bind(session.id, user.id)
    .all<CommitRow>();
  const final = resolve(rows.map((r) => r.result));

  const stmts: D1PreparedStatement[] = [];
  rows.forEach((row, i) => {
    const r = final[i];
    stmts.push(
      db
        .prepare(`UPDATE session_items SET result = ?3, answered_at = ?4 WHERE session_id = ?1 AND pos = ?2 AND ${OPEN}`)
        .bind(session.id, row.pos, r, r === "skip" ? null : now),
    );
    const prev: CardState | null = row.box === null ? null : (row as unknown as CardState);
    const next = applyResult(prev, r, now, "batch", user.tz_offset_min, quiet);
    if (next && next !== prev) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO card_state (user_id, expr_id, box, due_at, hits, misses, lapses, last_seen_at)
             SELECT ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${OPEN}
             ON CONFLICT (user_id, expr_id) DO UPDATE SET box = excluded.box, due_at = excluded.due_at, hits = excluded.hits,
               misses = excluded.misses, lapses = excluded.lapses, last_seen_at = excluded.last_seen_at`,
          )
          .bind(session.id, user.id, row.expr_id, next.box, next.due_at, next.hits, next.misses, next.lapses, next.last_seen_at),
      );
    }
  });
  stmts.push(db.prepare("UPDATE sessions SET closed_at = ?2 WHERE id = ?1 AND closed_at IS NULL").bind(session.id, now));

  const res = await db.batch(stmts);
  if (!res[res.length - 1].meta.changes) return null;

  const misses = rows
    .filter((_, i) => final[i] === "miss")
    .map((row) => ({ en: row.en, cue: row.cue, example: (JSON.parse(row.examples) as string[])[0] ?? null }));
  const hits = final.filter((r) => r === "hit").length;
  return { hits, graded: hits + misses.length, misses };
}

export function renderSummary(s: CommitSummary): string {
  const parts = [t.score(s.hits, s.graded)];
  if (s.misses.length) {
    const lines = s.misses.map(
      (m) => `✗ <b>${escapeHtml(m.en)}</b> — ${escapeHtml(m.cue)}${m.example ? `\n   <i>${escapeHtml(m.example)}</i>` : ""}`,
    );
    parts.push(`${t.reviewAgain}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

// ---------- Text grading ----------

// Returns one result per item, or null when the text is not a valid grade for n items.
export function parseGradeText(text: string, n: number): Result[] | null {
  const s = text.toLowerCase().replaceAll(",", " ").trim().replace(/\s+/g, " ");
  if (!s || n < 1) return null;

  if (s === "ok" || s === "all o") return Array<Result>(n).fill("hit");

  if (/^x( \d+)+$/.test(s)) {
    const nums = s.split(" ").slice(1).map(Number);
    if (nums.some((k) => k < 1 || k > n)) return null;
    const r = Array<Result>(n).fill("hit");
    for (const k of nums) r[k - 1] = "miss";
    return r;
  }

  if (/^[ox]+$/.test(s)) {
    if (s.length !== n) return null;
    return [...s].map((c) => (c === "o" ? "hit" : "miss"));
  }

  const r = Array<Result>(n).fill("skip");
  for (const token of s.split(" ")) {
    const m = /^(\d+)-?([ox])$/.exec(token);
    if (!m) return null;
    const k = Number(m[1]);
    if (k < 1 || k > n) return null;
    r[k - 1] = m[2] === "o" ? "hit" : "miss";
  }
  return r;
}

export async function handleGradeText(env: Env, user: User, text: string, now: number): Promise<string> {
  const session = await getOpenBatch(env.DB, user.id);
  if (!session) return t.noOpenBatch;
  const n = (await getMarks(env.DB, session.id)).length;
  const results = parseGradeText(text, n);
  if (!results) return t.gradeHelp;
  const cfg = config(env);
  const summary = await commitBatch(env.DB, session, user, () => results, now, cfg.quiet);
  if (!summary) return t.noOpenBatch;
  // The item buttons would otherwise stay tappable on a closed batch. Keep the drill
  // button if the batch was sent with one (DRILL_REMINDER_HOUR, not drilled today).
  if (session.message_id) {
    const tz = user.tz_offset_min;
    const keepDrill = localHour(session.created_at, tz) === cfg.drillReminderHour && user.last_drill_date !== localDate(now, tz);
    await editKeyboard(env.TELEGRAM_BOT_TOKEN, user.id, session.message_id, { inline_keyboard: keepDrill ? [drillRow(cfg.drillUrl)] : [] });
  }
  return renderSummary(summary);
}

// ---------- Buttons ----------
// Each handler returns the notice for the callback answer, which index.ts sends in the
// webhook response, so the button spinner stops without an extra Bot API call.

// Rows without callbacks (the drill web_app button) survive keyboard edits.
function keptRows(cq: TgCallbackQuery): InlineKeyboardButton[][] {
  return (cq.message?.reply_markup?.inline_keyboard ?? []).filter((row) => row.some((b) => b.web_app));
}

// `t:<sid>:<pos>`: no D1 at all. The tapped keyboard is the source of truth for open marks,
// and the edit runs after the answer. Only the chat owner can tap their own message.
export function handleToggle(env: Env, cq: TgCallbackQuery, ctx: ExecutionContext): string | undefined {
  const pos = /^t:[^:]+:(\d+)$/.exec(cq.data ?? "")?.[1];
  const msg = cq.message;
  const next = pos && msg ? toggleKeyboard(msg.reply_markup, Number(pos)) : null;
  if (msg && next) ctx.waitUntil(editKeyboard(env.TELEGRAM_BOT_TOKEN, msg.chat.id, msg.message_id, next).catch(logError("toggle edit")));
  return undefined;
}

// `c:<sid>` commits, `a:<sid>` marks the rest correct and commits. The marks come from the
// keyboard that was tapped, so what is saved is exactly what the user sees.
export async function handleCommit(env: Env, user: User, cq: TgCallbackQuery, now: number, ctx: ExecutionContext): Promise<string | undefined> {
  const m = /^([ac]):([^:]+)$/.exec(cq.data ?? "");
  const session = m ? await getSession(env.DB, m[2]) : null;

  // Isolation: a commit may only act on the caller's own batch.
  if (!m || !session || session.kind !== "batch" || session.user_id !== user.id) return t.notYourBatch;
  if (session.closed_at !== null) return t.batchClosed;

  const marks = readMarks(cq.message?.reply_markup);
  const fill: Result = m[1] === "a" ? "hit" : "skip";
  const summary = await commitBatch(env.DB, session, user, (stored) => stored.map((_, i) => marks.get(i + 1) ?? fill), now, config(env).quiet);
  if (!summary) return t.batchClosed;

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = cq.message?.chat.id ?? user.id;
  const messageId = cq.message?.message_id ?? session.message_id;
  ctx.waitUntil(
    (async () => {
      if (messageId) await editKeyboard(token, chatId, messageId, { inline_keyboard: keptRows(cq) });
      await sendMessage(token, chatId, renderSummary(summary), { parse_mode: "HTML" });
    })().catch(logError("commit summary")),
  );
  return undefined;
}

const logError = (what: string) => (err: unknown) => console.error(`${what} failed`, err);

// Keyboard edits are cosmetic: "message is not modified" (a repeated edit) is expected and
// ignored, and other failures are logged without failing the update.
async function editKeyboard(token: string, chatId: number, messageId: number, markup: InlineKeyboardMarkup): Promise<void> {
  try {
    await editMessageReplyMarkup(token, chatId, messageId, markup);
  } catch (err) {
    if (err instanceof UserBlockedError) throw err;
    if (err instanceof TelegramError && err.description.includes("message is not modified")) return;
    console.warn("editMessageReplyMarkup failed", err);
  }
}
