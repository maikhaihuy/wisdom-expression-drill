// Reflex drill API for the Mini App: POST /api/drill/{units,start,answers,finish}.
// Identity comes only from the X-Init-Data header; body user ids are never read.

import { config } from "./config";
import { t } from "./i18n";
import type { Env } from "./index";
import { authenticate } from "./initdata";
import { applyResult, orderUnits, selectDrillDeck, selectUnitDeck, type CardState, type UnitCount } from "./srs";
import { sendMessage, UserBlockedError } from "./telegram";
import { localDate } from "./time";
import { deactivate, type User } from "./users";
import { escapeHtml } from "./util";

const LEARNED_LIMIT = 500;
const MAX_ANSWERS_PER_REQUEST = 100;
const MAX_POS = 10_000;
const MAX_LATENCY_MS = 600_000;
const MAX_UNIT = 10_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function handleDrillApi(request: Request, env: Env, ctx: ExecutionContext, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  const action = new URL(request.url).pathname.replace(/^\/api\/drill\//, "");
  if (!["units", "start", "answers", "finish"].includes(action)) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = await authenticate(env.DB, env.TELEGRAM_BOT_TOKEN, request.headers.get("x-init-data"), now);
  if (!auth.ok) return json({ error: auth.error }, 401);
  const user = auth.user;

  if (action === "units") return units(env, user);
  if (action === "start") {
    const unit = parseStartUnit(await request.text().catch(() => ""));
    if (unit === undefined) return json({ error: "invalid_unit" }, 422);
    return start(env, user, unit, now);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.sessionId !== "string") return json({ error: "invalid_body" }, 422);

  const session = await env.DB.prepare("SELECT id, user_id, kind, unit, closed_at FROM sessions WHERE id = ?")
    .bind(body.sessionId)
    .first<{ id: string; user_id: number; kind: string; unit: number | null; closed_at: number | null }>();
  // Another user's session is indistinguishable from a missing one.
  if (!session || session.kind !== "drill" || session.user_id !== user.id) return json({ error: "session_not_found" }, 404);

  if (action === "answers") {
    if (session.closed_at !== null) return json({ error: "session_closed" }, 409);
    return answers(env, user, session.id, body.answers, now);
  }
  return finish(env, user, session.id, session.unit, session.closed_at === null, now, ctx);
}

// ---------- units ----------

async function units(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT e.unit, COUNT(c.expr_id) AS learned, COUNT(*) AS total
     FROM expressions e LEFT JOIN card_state c ON c.expr_id = e.id AND c.user_id = ? AND c.box >= 1
     WHERE e.archived = 0 AND e.unit >= 1 GROUP BY e.unit`,
  )
    .bind(user.id)
    .all<UnitCount>();
  return json({ units: orderUnits(results) });
}

// ---------- start ----------

// Start body: empty, or JSON with an optional `unit`. Returns null for all units, the unit
// number, or undefined when the body or unit is invalid.
export function parseStartUnit(text: string): number | null | undefined {
  if (!text.trim()) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const unit = (body as Record<string, unknown>).unit;
  if (unit === undefined || unit === null) return null;
  return Number.isInteger(unit) && (unit as number) >= 1 && (unit as number) <= MAX_UNIT ? (unit as number) : undefined;
}

interface LearnedRow {
  id: string;
  en: string;
  cue: string;
  examples: string;
  box: number;
  due_at: number;
  hits: number;
  misses: number;
}

async function start(env: Env, user: User, unit: number | null, now: number): Promise<Response> {
  const cfg = config(env);
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.en, e.cue, e.examples, c.box, c.due_at, c.hits, c.misses
     FROM card_state c JOIN expressions e ON e.id = c.expr_id
     WHERE c.user_id = ?1 AND e.archived = 0 AND c.box >= 1 AND (?3 IS NULL OR e.unit = ?3)
     ORDER BY (c.misses + 1.0) / (c.hits + c.misses + 2) DESC LIMIT ?2`,
  )
    .bind(user.id, LEARNED_LIMIT, unit)
    .all<LearnedRow>();

  const deck = unit === null ? selectDrillDeck(results, cfg.drillDeckSize, now, Math.random) : selectUnitDeck(results, cfg.drillDeckSize, Math.random);
  if (!deck.length) return json({ error: unit === null ? "no_learned" : "no_learned_in_unit" }, 409);

  const suffix = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  const sessionId = `d-${user.id}-${now}-${suffix}`;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, kind, unit, created_at) VALUES (?, ?, 'drill', ?, ?)").bind(sessionId, user.id, unit, now).run();

  return json({
    sessionId,
    unit,
    cardSeconds: cfg.cardSeconds,
    totalSeconds: cfg.drillSeconds,
    cards: deck.map((c) => ({ exprId: c.id, cue: c.cue, en: c.en, example: (JSON.parse(c.examples) as string[])[0] ?? null })),
  });
}

// ---------- answers ----------

export interface DrillAnswer {
  pos: number;
  exprId: string;
  result: "hit" | "miss";
  latencyMs: number | null;
}

// Validates the answer list. `firstTry` from the client is ignored: the server decides it.
export function parseAnswers(raw: unknown): DrillAnswer[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ANSWERS_PER_REQUEST) return null;
  const out: DrillAnswer[] = [];
  for (const a of raw) {
    if (typeof a !== "object" || a === null) return null;
    const { pos, exprId, result, latencyMs } = a as Record<string, unknown>;
    if (!Number.isInteger(pos) || (pos as number) < 1 || (pos as number) > MAX_POS) return null;
    if (typeof exprId !== "string" || !exprId) return null;
    if (result !== "hit" && result !== "miss") return null;
    const latency = latencyMs === null || latencyMs === undefined ? null : Math.round(Number(latencyMs));
    if (latency !== null && !(latency >= 0 && latency <= MAX_LATENCY_MS)) return null;
    out.push({ pos: pos as number, exprId, result, latencyMs: latency });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

const OPEN = "EXISTS (SELECT 1 FROM sessions WHERE id = ?1 AND closed_at IS NULL)";

async function answers(env: Env, user: User, sessionId: string, raw: unknown, now: number): Promise<Response> {
  const list = parseAnswers(raw);
  if (!list) return json({ error: "invalid_answers" }, 422);
  const db = env.DB;
  const exprIds = [...new Set(list.map((a) => a.exprId))];

  const [stored, states] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT pos, expr_id FROM session_items WHERE session_id = ?").bind(sessionId),
    db
      .prepare(
        `SELECT expr_id, box, due_at, hits, misses, lapses, last_seen_at FROM card_state
         WHERE user_id = ? AND expr_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(user.id, JSON.stringify(exprIds)),
  ]);

  // Drill decks only hold learned cards, so every answer must have review state.
  const state = new Map(states.results.map((r) => [r.expr_id as string, r as unknown as CardState]));
  if (exprIds.some((id) => !state.has(id))) return json({ error: "unknown_expression" }, 422);

  const storedPos = new Set(stored.results.map((r) => r.pos as number));
  const seen = new Set(stored.results.map((r) => r.expr_id as string));
  const stmts: D1PreparedStatement[] = [];
  const inserts: number[] = [];

  for (const a of list) {
    if (storedPos.has(a.pos)) continue; // resubmission
    storedPos.add(a.pos);
    const firstTry = !seen.has(a.exprId);
    seen.add(a.exprId);

    if (firstTry) {
      const next = applyResult(state.get(a.exprId)!, a.result, now, "drill", user.tz_offset_min)!;
      state.set(a.exprId, next);
      // Guarded inside the transaction: applies only if this position and expression are
      // not stored yet, so a concurrent duplicate submission cannot apply it twice.
      stmts.push(
        db
          .prepare(
            `UPDATE card_state SET box = ?4, due_at = ?5, hits = ?6, misses = ?7, lapses = ?8, last_seen_at = ?9
             WHERE user_id = ?2 AND expr_id = ?3 AND ${OPEN}
               AND NOT EXISTS (SELECT 1 FROM session_items WHERE session_id = ?1 AND (pos = ?10 OR expr_id = ?3))`,
          )
          .bind(sessionId, user.id, a.exprId, next.box, next.due_at, next.hits, next.misses, next.lapses, next.last_seen_at, a.pos),
      );
    }
    inserts.push(stmts.length);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO session_items (session_id, pos, expr_id, result, latency_ms, first_try, answered_at)
           SELECT ?1, ?2, ?3, ?4, ?5, NOT EXISTS (SELECT 1 FROM session_items WHERE session_id = ?1 AND expr_id = ?3), ?6
           WHERE ${OPEN}`,
        )
        .bind(sessionId, a.pos, a.exprId, a.result, a.latencyMs, now),
    );
  }

  if (!stmts.length) return json({ ok: true, stored: 0 });
  const res = await db.batch(stmts);
  return json({ ok: true, stored: inserts.reduce((n, i) => n + (res[i].meta.changes ?? 0), 0) });
}

// ---------- finish ----------

export interface DrillItemRow {
  result: "hit" | "miss";
  latency_ms: number | null;
  first_try: number;
  en: string;
  cue: string;
}

export interface DrillSummary {
  cards: number;
  firstTryAccuracy: number | null;
  medianLatencyMs: number | null;
  missed: { en: string; cue: string }[];
}

// PURE: summary over first-try answers (one per expression).
export function summarizeDrill(rows: DrillItemRow[]): DrillSummary {
  const first = rows.filter((r) => r.first_try);
  const hits = first.filter((r) => r.result === "hit").length;
  const latencies = first.map((r) => r.latency_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const mid = latencies.length >> 1;
  const median = latencies.length ? (latencies.length % 2 ? latencies[mid] : Math.round((latencies[mid - 1] + latencies[mid]) / 2)) : null;
  return {
    cards: first.length,
    firstTryAccuracy: first.length ? hits / first.length : null,
    medianLatencyMs: median,
    missed: first.filter((r) => r.result === "miss").map((r) => ({ en: r.en, cue: r.cue })),
  };
}

export function renderDrillSummary(s: DrillSummary, unit: number | null = null): string {
  const head = t.drillSummary(s.cards, s.firstTryAccuracy, s.medianLatencyMs);
  const parts = [unit === null ? head : `${t.drillUnitHeader(unit)}\n${head}`];
  if (s.missed.length) parts.push(`${t.reviewAgain}\n${s.missed.map((m) => `✗ <b>${escapeHtml(m.en)}</b> — ${escapeHtml(m.cue)}`).join("\n")}`);
  return parts.join("\n\n");
}

async function finish(env: Env, user: User, sessionId: string, unit: number | null, open: boolean, now: number, ctx: ExecutionContext): Promise<Response> {
  const db = env.DB;
  const read = db
    .prepare(
      `SELECT si.result, si.latency_ms, si.first_try, e.en, e.cue FROM session_items si
       JOIN expressions e ON e.id = si.expr_id WHERE si.session_id = ? ORDER BY si.pos`,
    )
    .bind(sessionId);

  let rows: DrillItemRow[];
  let closedNow = false;
  if (open) {
    const [close, , items] = await db.batch<DrillItemRow>([
      db.prepare("UPDATE sessions SET closed_at = ? WHERE id = ? AND closed_at IS NULL").bind(now, sessionId),
      // Only an all-units drill marks the day as drilled.
      db
        .prepare("UPDATE users SET last_drill_date = ? WHERE id = ? AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND closed_at = ? AND unit IS NULL)")
        .bind(localDate(now, user.tz_offset_min), user.id, sessionId, now),
      read,
    ]);
    closedNow = (close.meta.changes ?? 0) > 0;
    rows = items.results;
  } else {
    rows = (await read.all<DrillItemRow>()).results;
  }

  const summary = summarizeDrill(rows);
  // Only the request that closed the session announces it, so a retried finish is silent.
  if (closedNow && summary.cards > 0) ctx.waitUntil(notify(env, user, summary, unit));
  return json({ ...summary, unit });
}

async function notify(env: Env, user: User, summary: DrillSummary, unit: number | null): Promise<void> {
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, user.id, renderDrillSummary(summary, unit), { parse_mode: "HTML" });
  } catch (err) {
    if (err instanceof UserBlockedError) await deactivate(env.DB, user.id);
    else console.error("drill summary message failed", err);
  }
}
