import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { handleUpdate } from "../src/bot";
import type { Deps } from "../src/review";
import type { InlineKeyboardMarkup, TgUpdate } from "../src/telegram";
import type { User } from "../src/users";

// 2026-10-26 07:00 UTC = 14:00 in UTC+7.
export const T0 = Date.UTC(2026, 9, 26, 7, 0, 0) / 1000;
export const HOUR = 3600;
export const DAY = 86400;
export const TZ7 = 420;

export const deps: Deps = { rng: () => 0.5, delayMs: 0 };

// ---------- Telegram mock ----------

export interface TgCall {
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

// Records every Bot API call. `respond` may return a Response to override the default success.
export function mockTelegram(respond?: (call: TgCall) => Response | undefined) {
  const calls: TgCall[] = [];
  let nextMessageId = 500;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = String(input instanceof Request ? input.url : input).split("/").pop()!;
    const call = { method, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    const override = respond?.(call);
    if (override) return override;
    const result = method === "sendMessage" ? { message_id: nextMessageId++, chat: { id: call.body.chat_id, type: "private" } } : true;
    return Response.json({ ok: true, result });
  });
  return {
    calls,
    sent: () => calls.filter((c) => c.method === "sendMessage"),
    lastText: () => calls.filter((c) => c.method === "sendMessage").at(-1)?.body.text as string | undefined,
    answers: () => calls.filter((c) => c.method === "answerCallbackQuery"),
    edits: () => calls.filter((c) => c.method === "editMessageReplyMarkup"),
  };
}

export const forbidden = () => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 });

// ---------- Seeding ----------

export async function addUser(id: number, fields: Partial<User> = {}): Promise<User> {
  const u: User = {
    id,
    name: `user${id}`,
    role: "member",
    tz_offset_min: TZ7,
    active: 1,
    paused_until: null,
    last_drill_date: null,
    new_today: 0,
    new_today_date: null,
    created_at: T0 - 30 * DAY,
    ...fields,
  };
  await env.DB.prepare(
    `INSERT INTO users (id, name, role, tz_offset_min, active, paused_until, last_drill_date, new_today, new_today_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(u.id, u.name, u.role, u.tz_offset_min, u.active, u.paused_until, u.last_drill_date, u.new_today, u.new_today_date, u.created_at)
    .run();
  return u;
}

export interface ExprSeed {
  id: string;
  en?: string;
  cue?: string;
  examples?: string[];
  unit?: number;
  position?: number;
  archived?: number;
}

export async function addExpressions(seeds: (ExprSeed | string)[]): Promise<void> {
  const stmts = seeds.map((s) => {
    const e = typeof s === "string" ? { id: s } : s;
    return env.DB.prepare(
      `INSERT INTO expressions (id, en, cue, examples, tags, unit, position, content_hash, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, 'h', ?, 0, 0)`,
    ).bind(e.id, e.en ?? `en ${e.id}`, e.cue ?? `cue ${e.id}`, JSON.stringify(e.examples ?? [`example ${e.id}`]), e.unit ?? 1, e.position ?? 1, e.archived ?? 0);
  });
  if (stmts.length) await env.DB.batch(stmts);
}

export const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);

export interface StateSeed {
  box?: number;
  due_at?: number;
  hits?: number;
  misses?: number;
  lapses?: number;
}

export async function setState(userId: number, exprId: string, s: StateSeed = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO card_state (user_id, expr_id, box, due_at, hits, misses, lapses, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(userId, exprId, s.box ?? 1, s.due_at ?? T0 - HOUR, s.hits ?? 0, s.misses ?? 0, s.lapses ?? 0)
    .run();
}

export async function getState(userId: number, exprId: string) {
  return env.DB.prepare("SELECT box, due_at, hits, misses, lapses, last_seen_at FROM card_state WHERE user_id = ? AND expr_id = ?")
    .bind(userId, exprId)
    .first();
}

export async function allStates(userId: number) {
  const { results } = await env.DB.prepare("SELECT * FROM card_state WHERE user_id = ? ORDER BY expr_id").bind(userId).all();
  return results;
}

// Creates a session with items. `results` per item; answered_at defaults to created_at for hit/miss.
export async function addSession(
  id: string,
  userId: number,
  exprIds: string[],
  opts: { createdAt?: number; closedAt?: number | null; results?: (string | null)[]; answeredAt?: number; messageId?: number } = {},
): Promise<void> {
  const createdAt = opts.createdAt ?? T0 - 2 * HOUR;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, user_id, kind, message_id, created_at, closed_at) VALUES (?, ?, 'batch', ?, ?, ?)").bind(
      id,
      userId,
      opts.messageId ?? 77,
      createdAt,
      opts.closedAt === undefined ? null : opts.closedAt,
    ),
    ...exprIds.map((e, i) => {
      const r = opts.results?.[i] ?? null;
      const answered = r === "hit" || r === "miss" ? (opts.answeredAt ?? createdAt) : null;
      return env.DB.prepare("INSERT INTO session_items (session_id, pos, expr_id, result, answered_at) VALUES (?, ?, ?, ?, ?)").bind(
        id,
        i + 1,
        e,
        r,
        answered,
      );
    }),
  ]);
}

export async function getSessionRow(id: string) {
  return env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<{ closed_at: number | null; message_id: number | null; user_id: number }>();
}

export async function itemResults(sessionId: string) {
  const { results } = await env.DB.prepare("SELECT expr_id, result, answered_at FROM session_items WHERE session_id = ? ORDER BY pos")
    .bind(sessionId)
    .all<{ expr_id: string; result: string | null; answered_at: number | null }>();
  return results;
}

export async function latestBatch(userId: number) {
  return env.DB.prepare("SELECT * FROM sessions WHERE user_id = ? AND kind = 'batch' ORDER BY created_at DESC LIMIT 1")
    .bind(userId)
    .first<{ id: string; closed_at: number | null; message_id: number | null }>();
}

export async function count(table: string, where = "1"): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<number>("n")) ?? 0;
}

// ---------- Updates ----------

let updateId = 1;

export function msg(fromId: number, text: string, opts: { chatType?: "private" | "group"; firstName?: string } = {}): TgUpdate {
  const chatType = opts.chatType ?? "private";
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      chat: { id: chatType === "private" ? fromId : -100123, type: chatType },
      from: { id: fromId, first_name: opts.firstName ?? `First${fromId}` },
      text,
    },
  };
}

export function callback(fromId: number, data: string, opts: { messageId?: number; markup?: InlineKeyboardMarkup; chatType?: "private" | "group" } = {}): TgUpdate {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: fromId, first_name: `First${fromId}` },
      data,
      message: {
        message_id: opts.messageId ?? 77,
        chat: { id: opts.chatType === "group" ? -100123 : fromId, type: opts.chatType ?? "private" },
        reply_markup: opts.markup,
      },
    },
  };
}

// Runs one update like the webhook does, waits for its background work, and returns the
// callback answer (null for messages and ignored updates).
export async function send(update: TgUpdate, now = T0, withEnv: Cloudflare.Env = env) {
  const ctx = createExecutionContext();
  const answer = await handleUpdate(withEnv, update, now, ctx, deps);
  await waitOnExecutionContext(ctx);
  return answer;
}
