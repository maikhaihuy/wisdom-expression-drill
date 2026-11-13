import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleDrillApi, summarizeDrill, type DrillSummary } from "../src/drill-api";
import { t } from "../src/i18n";
import worker from "../src/index";
import { runSchedule } from "../src/review";
import type { InlineKeyboardMarkup } from "../src/telegram";
import { addExpressions, addUser, count, DAY, deps, getState, HOUR, ids, mockTelegram, setState, T0 } from "./helpers";
import { signedInitData } from "./initdata-fixture";

async function api(action: string, body: unknown, opts: { userId?: number; initData?: string | null; now?: number } = {}) {
  const now = opts.now ?? T0;
  const initData = opts.initData === undefined ? await signedInitData({ id: opts.userId ?? 5 }, now - 60, env.TELEGRAM_BOT_TOKEN) : opts.initData;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (initData !== null) headers["x-init-data"] = initData;
  const req = new Request(`https://worker.test/api/drill/${action}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ctx = createExecutionContext();
  const res = await handleDrillApi(req, env, ctx, now);
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as any };
}

// User 5 with n learned expressions, all in box 2 and not due.
async function learnedUser(n: number, userId = 5) {
  await addUser(userId);
  const exprs = ids("e", n);
  await addExpressions(exprs.map((id) => ({ id, examples: [`example ${id}`] })));
  for (const id of exprs) await setState(userId, id, { box: 2, due_at: T0 + 2 * DAY, hits: 1 });
  return exprs;
}

const sessionRow = (id: string) => env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<{ user_id: number; kind: string; unit: number | null; closed_at: number | null }>();
const items = async (sid: string) =>
  (await env.DB.prepare("SELECT pos, expr_id, result, latency_ms, first_try FROM session_items WHERE session_id = ? ORDER BY pos").bind(sid).all()).results;

// ---------- 1.3 start ----------

describe("POST /api/drill/start", () => {
  it("creates a drill session for the init-data user and returns the deck", async () => {
    await learnedUser(12);
    const res = await api("start", undefined);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cardSeconds: 10, totalSeconds: 300 });
    expect(res.body.cards).toHaveLength(12);
    expect(res.body.cards[0]).toEqual({ exprId: expect.any(String), cue: expect.any(String), en: expect.any(String), example: expect.stringMatching(/^example /) });
    expect(await sessionRow(res.body.sessionId)).toMatchObject({ user_id: 5, kind: "drill", closed_at: null });
  });

  it("ignores a spoofed user_id in the body", async () => {
    await learnedUser(5, 5);
    await learnedUser(0, 6);
    const res = await api("start", { user_id: 6, userId: 6 }, { userId: 5 });
    expect((await sessionRow(res.body.sessionId))!.user_id).toBe(5);
  });

  it("never includes new or archived expressions", async () => {
    await learnedUser(3);
    await addExpressions(["fresh", { id: "gone", archived: 1 }]);
    await setState(5, "gone", { box: 3 });
    const res = await api("start", undefined);
    expect(res.body.cards.map((c: { exprId: string }) => c.exprId).sort()).toEqual(["e01", "e02", "e03"]);
  });

  it("caps the deck at DRILL_DECK_SIZE", async () => {
    await learnedUser(80);
    expect((await api("start", undefined)).body.cards).toHaveLength(60);
  });

  it("nothing learned yet → 409 and no session", async () => {
    await addUser(5);
    await addExpressions(ids("e", 5));
    const res = await api("start", undefined);
    expect(res).toEqual({ status: 409, body: { error: "no_learned" } });
    expect(await count("sessions")).toBe(0);
  });

  it.each([
    ["missing init data", null],
    ["garbage init data", "user=%7B%22id%22%3A5%7D&hash=abc"],
  ])("%s → 401", async (_name, initData) => {
    await learnedUser(3);
    expect(await api("start", undefined, { initData })).toEqual({ status: 401, body: { error: "invalid_init_data" } });
    expect(await count("sessions")).toBe(0);
  });

  it("tampered user → 401 and no session", async () => {
    await learnedUser(3, 5);
    await learnedUser(0, 6);
    const params = new URLSearchParams(await signedInitData({ id: 6 }, T0, env.TELEGRAM_BOT_TOKEN));
    params.set("user", JSON.stringify({ id: 5, first_name: "Test" }));
    expect((await api("start", undefined, { initData: params.toString() })).status).toBe(401);
    expect(await count("sessions")).toBe(0);
  });

  it("stale init data → 401", async () => {
    await learnedUser(3);
    const initData = await signedInitData({ id: 5 }, T0 - 25 * HOUR, env.TELEGRAM_BOT_TOKEN);
    expect((await api("start", undefined, { initData })).status).toBe(401);
  });

  it("unregistered user → 401 unregistered", async () => {
    expect(await api("start", undefined, { userId: 42 })).toEqual({ status: 401, body: { error: "unregistered" } });
  });

  it("is routed by the Worker", async () => {
    await learnedUser(3);
    const now = Math.floor(Date.now() / 1000);
    const initData = await signedInitData({ id: 5 }, now - 10, env.TELEGRAM_BOT_TOKEN);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://worker.test/api/drill/start", { method: "POST", headers: { "x-init-data": initData } }), env, ctx);
    expect(res.status).toBe(200);
    const bad = await worker.fetch(new Request("https://worker.test/api/drill/nope", { method: "POST" }), env, createExecutionContext());
    expect(bad.status).toBe(404);
  });
});

// ---------- 1.4 answers ----------

describe("POST /api/drill/answers", () => {
  async function started(n = 12) {
    const exprs = await learnedUser(n);
    const { body } = await api("start", undefined);
    return { sid: body.sessionId as string, exprs };
  }
  const ans = (pos: number, exprId: string, result: "hit" | "miss", latencyMs = 1500, firstTry = true) => ({ pos, exprId, result, latencyMs, firstTry });

  it("an early first-try hit only increments hits", async () => {
    const { sid } = await started();
    const before = await getState(5, "e01");
    const res = await api("answers", { sessionId: sid, answers: [ans(1, "e01", "hit")] });
    expect(res).toEqual({ status: 200, body: { ok: true, stored: 1 } });
    expect(await getState(5, "e01")).toEqual({ ...before, hits: (before!.hits as number) + 1, last_seen_at: T0 });
  });

  it("a first-try miss demotes; the repeat is stored with first_try = 0 and changes nothing", async () => {
    const { sid } = await started();
    await api("answers", { sessionId: sid, answers: [ans(1, "e01", "miss", 5000), ans(2, "e02", "hit")] });
    const afterMiss = await getState(5, "e01");
    expect(afterMiss).toMatchObject({ box: 1, misses: 1, due_at: T0 + 4 * HOUR });

    // The client even claims firstTry for the repeat; the server decides.
    await api("answers", { sessionId: sid, answers: [ans(5, "e01", "hit", 900, true)] });
    expect(await getState(5, "e01")).toEqual(afterMiss);
    expect(await items(sid)).toEqual([
      { pos: 1, expr_id: "e01", result: "miss", latency_ms: 5000, first_try: 1 },
      { pos: 2, expr_id: "e02", result: "hit", latency_ms: 1500, first_try: 1 },
      { pos: 5, expr_id: "e01", result: "hit", latency_ms: 900, first_try: 0 },
    ]);
  });

  it("a repeat within the same group is not applied", async () => {
    const { sid } = await started();
    await api("answers", { sessionId: sid, answers: [ans(1, "e01", "miss"), ans(4, "e01", "hit")] });
    expect(await getState(5, "e01")).toMatchObject({ box: 1, misses: 1, hits: 1 });
  });

  it("a resubmitted group of 10 changes nothing", async () => {
    const { sid, exprs } = await started();
    const group = exprs.slice(0, 10).map((id, i) => ans(i + 1, id, i % 3 ? "hit" : "miss"));
    expect((await api("answers", { sessionId: sid, answers: group })).body.stored).toBe(10);
    const states = await Promise.all(exprs.map((id) => getState(5, id)));
    const rows = await items(sid);

    expect((await api("answers", { sessionId: sid, answers: group })).body).toEqual({ ok: true, stored: 0 });
    expect(await Promise.all(exprs.map((id) => getState(5, id)))).toEqual(states);
    expect(await items(sid)).toEqual(rows);
  });

  it("concurrent duplicate submissions apply once", async () => {
    const { sid } = await started();
    const group = [ans(1, "e01", "hit"), ans(2, "e02", "miss")];
    const results = await Promise.all([api("answers", { sessionId: sid, answers: group }), api("answers", { sessionId: sid, answers: group })]);
    expect(results.map((r) => r.body.stored).sort()).toEqual([0, 2]);
    expect(await getState(5, "e01")).toMatchObject({ hits: 2 });
    expect(await getState(5, "e02")).toMatchObject({ misses: 1 });
  });

  it("racing answers for the same expression apply only the stored first try", async () => {
    const { sid } = await started();
    // Hold every read batch until both requests have read, so both see "not stored yet".
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const db = {
      prepare: (q: string) => env.DB.prepare(q),
      batch: async (stmts: D1PreparedStatement[]) => {
        // Each request's first batch is its read; the barrier keeps both writes after both reads.
        if (reads < 2) {
          if (++reads === 2) release();
          await bothRead;
        }
        return env.DB.batch(stmts);
      },
    } as unknown as D1Database;
    const raced = async (answer: ReturnType<typeof ans>) => {
      const req = new Request("https://worker.test/api/drill/answers", {
        method: "POST",
        headers: { "x-init-data": await signedInitData({ id: 5 }, T0 - 60, env.TELEGRAM_BOT_TOKEN) },
        body: JSON.stringify({ sessionId: sid, answers: [answer] }),
      });
      return (await (await handleDrillApi(req, { ...env, DB: db }, createExecutionContext(), T0)).json()) as { stored: number };
    };
    // Both requests read "e01 not answered yet", so both believe theirs is the first try.
    await Promise.all([raced(ans(1, "e01", "miss")), raced(ans(2, "e01", "hit"))]);
    expect(reads).toBe(2);

    const rows = await items(sid);
    expect(rows.map((r) => r.first_try).sort()).toEqual([0, 1]);
    const first = rows.find((r) => r.first_try === 1)!;
    // State must reflect exactly the stored first try (initial: box 2, hits 1, misses 0).
    expect(await getState(5, "e01")).toMatchObject(first.result === "miss" ? { box: 1, hits: 1, misses: 1 } : { box: 2, hits: 2, misses: 0 });
  });

  it("records answers for the init-data user even with a spoofed user_id", async () => {
    const { sid } = await started();
    await learnedUser(0, 6);
    await api("answers", { sessionId: sid, user_id: 6, answers: [ans(1, "e01", "hit")] });
    expect(await getState(5, "e01")).toMatchObject({ hits: 2 });
  });

  it("another user's session → 404, nothing stored", async () => {
    const { sid } = await started();
    await addUser(6);
    await setState(6, "e01", { box: 2 });
    expect((await api("answers", { sessionId: sid, answers: [ans(1, "e01", "hit")] }, { userId: 6 })).status).toBe(404);
    expect(await items(sid)).toEqual([]);
  });

  it("finished session → 409", async () => {
    const { sid } = await started();
    await api("finish", { sessionId: sid });
    expect((await api("answers", { sessionId: sid, answers: [ans(1, "e01", "hit")] })).status).toBe(409);
    expect(await items(sid)).toEqual([]);
  });

  it("an expression the user has not learned → 422, nothing stored", async () => {
    const { sid } = await started();
    await addExpressions(["fresh"]);
    const res = await api("answers", { sessionId: sid, answers: [ans(1, "e01", "hit"), ans(2, "fresh", "hit")] });
    expect(res.status).toBe(422);
    expect(await items(sid)).toEqual([]);
  });

  it.each([
    ["empty list", []],
    ["bad result", [{ pos: 1, exprId: "e01", result: "skip" }]],
    ["bad pos", [{ pos: 0, exprId: "e01", result: "hit" }]],
    ["negative latency", [{ pos: 1, exprId: "e01", result: "hit", latencyMs: -5 }]],
    ["not a list", "x"],
  ])("%s → 422", async (_name, answers) => {
    const { sid } = await started();
    expect((await api("answers", { sessionId: sid, answers })).status).toBe(422);
  });
});

// ---------- 1.5 finish ----------

describe("POST /api/drill/finish", () => {
  it("48 cards, 40 first-try hits → 83%, chat summary, and no drill button at the 17:00 drill-reminder batch", async () => {
    const exprs = await learnedUser(60);
    const tg = mockTelegram();
    const { body } = await api("start", undefined);
    const sid = body.sessionId as string;

    // 48 first tries (the last 8 wrong), each wrong card repeated once and then right.
    const answers = exprs.slice(0, 48).map((id, i) => ({ pos: i + 1, exprId: id, result: i < 40 ? "hit" : "miss", latencyMs: 1000 + i * 10 }));
    answers.push(...exprs.slice(40, 48).map((id, i) => ({ pos: 49 + i, exprId: id, result: "hit", latencyMs: 500 })));
    for (let i = 0; i < answers.length; i += 10) await api("answers", { sessionId: sid, answers: answers.slice(i, i + 10) });

    const res = await api("finish", { sessionId: sid });
    expect(res.status).toBe(200);
    const summary = res.body as DrillSummary;
    expect(summary.cards).toBe(48);
    expect(Math.round(summary.firstTryAccuracy! * 100)).toBe(83);
    expect(summary.medianLatencyMs).toBe(1235); // first tries: 1000..1470, middle pair 1230/1240
    expect(summary.missed.map((m) => m.en)).toEqual(exprs.slice(40, 48).map((id) => `en ${id}`));

    expect(await sessionRow(sid)).toMatchObject({ closed_at: T0 });
    expect(await env.DB.prepare("SELECT last_drill_date FROM users WHERE id = 5").first("last_drill_date")).toBe("2026-10-26");
    const chat = tg.sent();
    expect(chat).toHaveLength(1);
    expect(chat[0].body.chat_id).toBe(5);
    expect(chat[0].body.text).toContain("48 thẻ");
    expect(chat[0].body.text).toContain("83%");
    expect(chat[0].body.text).toContain(`✗ <b>en e41</b>`);

    tg.calls.length = 0;
    await runSchedule(env, T0 + 3 * HOUR, deps); // 17:00 local
    const markup = tg.sent()[0].body.reply_markup as InlineKeyboardMarkup;
    expect(markup.inline_keyboard.some((row) => row.some((b) => b.web_app))).toBe(false);
  });

  it("a second finish returns the same summary without a second message", async () => {
    await learnedUser(3);
    const tg = mockTelegram();
    const sid = (await api("start", undefined)).body.sessionId;
    await api("answers", { sessionId: sid, answers: [{ pos: 1, exprId: "e01", result: "hit", latencyMs: 800 }] });
    const first = await api("finish", { sessionId: sid });
    const second = await api("finish", { sessionId: sid }, { now: T0 + 60 });
    expect(second).toEqual(first);
    expect(tg.sent()).toHaveLength(1);
    expect((await sessionRow(sid))!.closed_at).toBe(T0);
  });

  it("a failed chat message does not fail the finish", async () => {
    await learnedUser(3);
    mockTelegram(() => new Response("boom", { status: 500 }));
    const sid = (await api("start", undefined)).body.sessionId;
    await api("answers", { sessionId: sid, answers: [{ pos: 1, exprId: "e01", result: "hit", latencyMs: 800 }] });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      expect((await api("finish", { sessionId: sid })).status).toBe(200);
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(1);
  });

  it("app closed early: answers kept, session open, last_drill_date unchanged", async () => {
    await learnedUser(5);
    const sid = (await api("start", undefined)).body.sessionId;
    await api("answers", { sessionId: sid, answers: [{ pos: 1, exprId: "e01", result: "hit", latencyMs: 800 }] });
    expect(await items(sid)).toHaveLength(1);
    expect((await sessionRow(sid))!.closed_at).toBeNull();
    expect(await env.DB.prepare("SELECT last_drill_date FROM users WHERE id = 5").first("last_drill_date")).toBeNull();
  });

  it("another user's session → 404 and stays open", async () => {
    await learnedUser(3);
    await addUser(6);
    const sid = (await api("start", undefined)).body.sessionId;
    expect((await api("finish", { sessionId: sid }, { userId: 6 })).status).toBe(404);
    expect((await sessionRow(sid))!.closed_at).toBeNull();
  });

  it("drill answers count in /stats", async () => {
    await learnedUser(3);
    const sid = (await api("start", undefined)).body.sessionId;
    await api("answers", { sessionId: sid, answers: [{ pos: 1, exprId: "e01", result: "hit" }, { pos: 2, exprId: "e02", result: "miss" }] });
    const { getStats } = await import("../src/commands");
    const user = (await env.DB.prepare("SELECT * FROM users WHERE id = 5").first()) as any;
    expect(await getStats(env.DB, user, T0)).toMatchObject({ accuracy: 0.5, streak: 1 });
  });
});

describe("summarizeDrill", () => {
  const row = (result: "hit" | "miss", latency_ms: number | null, first_try = 1) => ({ result, latency_ms, first_try, en: "en", cue: "cue" });

  it("uses first tries only", () => {
    expect(summarizeDrill([row("miss", 3000), row("hit", 1000), row("hit", 200, 0)])).toEqual({
      cards: 2,
      firstTryAccuracy: 0.5,
      medianLatencyMs: 2000,
      missed: [{ en: "en", cue: "cue" }],
    });
  });

  it("odd count median and missing latencies", () => {
    expect(summarizeDrill([row("hit", 300), row("hit", null), row("hit", 100), row("hit", 200)]).medianLatencyMs).toBe(200);
  });

  // Mirrors a manual practice run of unit 6 in the Mini App, whose client-side summary
  // (summarizeLocal in public/drill/app.js) showed 22 cards, 77% and 0,2s.
  it("matches the Mini App's practice summary for the same answers", () => {
    const first = Array.from({ length: 22 }, (_, i) => row(i < 5 ? "miss" : "hit", 180 + i * 2));
    const repeats = Array.from({ length: 5 }, () => row("hit", 150, 0));
    const s = summarizeDrill([...first, ...repeats]);
    expect(s.cards).toBe(22);
    expect(Math.round(s.firstTryAccuracy! * 100)).toBe(77);
    expect((s.medianLatencyMs! / 1000).toFixed(1)).toBe("0.2");
    expect(s.missed).toHaveLength(5);
  });

  it("empty drill", () => {
    expect(summarizeDrill([])).toEqual({ cards: 0, firstTryAccuracy: null, medianLatencyMs: null, missed: [] });
  });

  it("renders the chat message", async () => {
    const { renderDrillSummary } = await import("../src/drill-api");
    expect(renderDrillSummary({ cards: 48, firstTryAccuracy: 40 / 48, medianLatencyMs: 2100, missed: [{ en: "R&D", cue: "a < b" }] })).toBe(
      `${t.drillSummary(48, 40 / 48, 2100)}\n\n${t.reviewAgain}\n✗ <b>R&amp;D</b> — a &lt; b`,
    );
    expect(t.drillSummary(48, 40 / 48, 2100)).toBe("⚡ <b>Luyện phản xạ xong</b>: 48 thẻ · đúng ngay 83% · trung vị 2,1 giây");
  });
});

// ---------- Unit drill ----------

// Unit u with `total` expressions, the first `learned` of them in box 2 for the user.
async function unitBank(unit: number, total: number, learned: number, userIds: number[] = [5]) {
  const exprs = Array.from({ length: total }, (_, i) => `u${unit}-${String(i + 1).padStart(2, "0")}`);
  await addExpressions(exprs.map((id, i) => ({ id, unit, position: i + 1 })));
  for (const uid of userIds) for (const id of exprs.slice(0, learned)) await setState(uid, id, { box: 2, due_at: T0 + 2 * DAY, hits: 1 });
  return exprs;
}
const deckIds = (body: { cards: { exprId: string }[] }) => body.cards.map((c) => c.exprId).sort();

describe("POST /api/drill/units", () => {
  it("picker after finishing unit 4: counts and order", async () => {
    await addUser(5);
    for (const [u, n] of [[1, 15], [2, 17], [3, 19], [4, 20]]) await unitBank(u, n, n);
    await unitBank(5, 18, 6);
    await unitBank(6, 22, 0);
    const res = await api("units", undefined);
    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([
      { unit: 5, learned: 6, total: 18 },
      { unit: 4, learned: 20, total: 20 },
      { unit: 3, learned: 19, total: 19 },
      { unit: 2, learned: 17, total: 17 },
      { unit: 1, learned: 15, total: 15 },
      { unit: 6, learned: 0, total: 22 },
    ]);
  });

  it("counts are per user", async () => {
    await addUser(5);
    await addUser(6);
    const exprs = await unitBank(1, 10, 3, [5]);
    for (const id of exprs.slice(0, 7)) await setState(6, id, { box: 1 });
    expect((await api("units", undefined, { userId: 5 })).body.units).toEqual([{ unit: 1, learned: 3, total: 10 }]);
    expect((await api("units", undefined, { userId: 6 })).body.units).toEqual([{ unit: 1, learned: 7, total: 10 }]);
  });

  it("excludes archived and unit-0 expressions; box-0 state is not learned", async () => {
    await addUser(5);
    await unitBank(2, 4, 2);
    await addExpressions([{ id: "old", unit: 2, archived: 1 }, { id: "nounit", unit: 0 }, { id: "seen", unit: 2 }]);
    await setState(5, "old", { box: 3 });
    await setState(5, "nounit", { box: 3 });
    await setState(5, "seen", { box: 0 });
    expect((await api("units", undefined)).body.units).toEqual([{ unit: 2, learned: 2, total: 5 }]);
  });

  it("bad init data → 401", async () => {
    await addUser(5);
    expect(await api("units", undefined, { initData: "user=%7B%22id%22%3A5%7D&hash=abc" })).toEqual({ status: 401, body: { error: "invalid_init_data" } });
  });
});

describe("POST /api/drill/start with a unit", () => {
  it("finished unit: exactly its learned cards, unit stored on the session", async () => {
    await addUser(5);
    await unitBank(3, 15, 15);
    const unit4 = await unitBank(4, 20, 20);
    const res = await api("start", { unit: 4 });
    expect(res.status).toBe(200);
    expect(res.body.unit).toBe(4);
    expect(deckIds(res.body)).toEqual([...unit4].sort());
    expect(await sessionRow(res.body.sessionId)).toMatchObject({ kind: "drill", unit: 4, closed_at: null });
  });

  it("partly learned unit: only the learned cards", async () => {
    await addUser(5);
    const unit5 = await unitBank(5, 18, 6);
    expect(deckIds((await api("start", { unit: 5 })).body)).toEqual(unit5.slice(0, 6).sort());
  });

  it("nothing learned in the unit → 409 and no session", async () => {
    await addUser(5);
    await unitBank(1, 5, 5);
    await unitBank(6, 22, 0);
    expect(await api("start", { unit: 6 })).toEqual({ status: 409, body: { error: "no_learned_in_unit" } });
    expect(await api("start", { unit: 99 })).toEqual({ status: 409, body: { error: "no_learned_in_unit" } });
    expect(await count("sessions")).toBe(0);
  });

  it.each([["zero", { unit: 0 }], ["negative", { unit: -1 }], ["fraction", { unit: 1.5 }], ["string", { unit: "4" }], ["not an object", [4]]])(
    "invalid unit (%s) → 422 and no session",
    async (_name, body) => {
      await addUser(5);
      await unitBank(4, 5, 5);
      expect(await api("start", body)).toEqual({ status: 422, body: { error: "invalid_unit" } });
      expect(await count("sessions")).toBe(0);
    },
  );

  it("no body, or unit null: the all-units drill", async () => {
    await addUser(5);
    await unitBank(1, 3, 3);
    await unitBank(2, 3, 3);
    for (const body of [undefined, {}, { unit: null }]) {
      const res = await api("start", body);
      expect(res.body.unit).toBeNull();
      expect(res.body.cards).toHaveLength(6);
      expect(await sessionRow(res.body.sessionId)).toMatchObject({ unit: null });
    }
  });
});

describe("POST /api/drill/finish for a unit", () => {
  it("unit 4, 20 cards, 18 first-try → 90%, unit named, last_drill_date unchanged, the 17:00 batch still has the drill button", async () => {
    await addUser(5);
    const exprs = await unitBank(4, 20, 20);
    const tg = mockTelegram();
    const sid = (await api("start", { unit: 4 })).body.sessionId as string;
    const answers = exprs.map((id, i) => ({ pos: i + 1, exprId: id, result: i < 18 ? "hit" : "miss", latencyMs: 1000 }));
    answers.push(...exprs.slice(18).map((id, i) => ({ pos: 21 + i, exprId: id, result: "hit", latencyMs: 500 })));
    for (let i = 0; i < answers.length; i += 10) await api("answers", { sessionId: sid, answers: answers.slice(i, i + 10) });

    const res = await api("finish", { sessionId: sid });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unit: 4, cards: 20, firstTryAccuracy: 0.9 });
    expect(await env.DB.prepare("SELECT last_drill_date FROM users WHERE id = 5").first("last_drill_date")).toBeNull();
    const text = tg.sent()[0].body.text as string;
    expect(text.startsWith(t.drillUnitHeader(4))).toBe(true);
    expect(text).toContain("20 thẻ");
    expect(text).toContain("90%");

    tg.calls.length = 0;
    await runSchedule(env, T0 + 3 * HOUR, deps); // 17:00 local
    const markup = tg.sent()[0].body.reply_markup as InlineKeyboardMarkup;
    expect(markup.inline_keyboard.some((row) => row.some((b) => b.web_app))).toBe(true);
  });

  it("an all-units finish returns unit null", async () => {
    await learnedUser(3);
    const sid = (await api("start", undefined)).body.sessionId;
    expect((await api("finish", { sessionId: sid })).body.unit).toBeNull();
  });
});

// ---------- Practice ----------

describe("POST /api/drill/practice", () => {
  const snapshot = async () => {
    const q = async (sql: string) => (await env.DB.prepare(sql).all()).results;
    return {
      sessions: await q("SELECT * FROM sessions ORDER BY id"),
      items: await q("SELECT * FROM session_items ORDER BY session_id, pos"),
      states: await q("SELECT * FROM card_state ORDER BY user_id, expr_id"),
      users: await q("SELECT id, last_drill_date, new_today, new_today_date FROM users ORDER BY id"),
    };
  };

  it("unit with nothing learned: all 22 cards, no session, nothing written", async () => {
    await addUser(5);
    await unitBank(5, 18, 6);
    const unit6 = await unitBank(6, 22, 0);
    const before = await snapshot();
    const res = await api("practice", { unit: 6 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unit: 6, cardSeconds: 10, totalSeconds: 300 });
    expect(res.body.sessionId).toBeUndefined();
    expect(deckIds(res.body)).toEqual([...unit6].sort());
    expect(res.body.cards[0]).toEqual({ exprId: expect.any(String), cue: expect.any(String), en: expect.any(String), example: expect.stringMatching(/^example /) });
    expect(await snapshot()).toEqual(before);
  });

  it("partly learned unit: all 18 cards", async () => {
    await addUser(5);
    const unit5 = await unitBank(5, 18, 6);
    expect(deckIds((await api("practice", { unit: 5 })).body)).toEqual([...unit5].sort());
  });

  it("excludes archived expressions", async () => {
    await addUser(5);
    const unit5 = await unitBank(5, 18, 0);
    await addExpressions([{ id: "old1", unit: 5, archived: 1 }, { id: "old2", unit: 5, archived: 1 }]);
    expect(deckIds((await api("practice", { unit: 5 })).body)).toEqual([...unit5].sort());
  });

  it("empty unit → 409", async () => {
    await addUser(5);
    await unitBank(1, 3, 0);
    expect(await api("practice", { unit: 7 })).toEqual({ status: 409, body: { error: "empty_unit" } });
  });

  it.each([["missing body", undefined], ["no unit", {}], ["null unit", { unit: null }], ["zero", { unit: 0 }], ["string", { unit: "6" }]])(
    "invalid unit (%s) → 422",
    async (_name, body) => {
      await addUser(5);
      await unitBank(6, 3, 0);
      expect(await api("practice", body)).toEqual({ status: 422, body: { error: "invalid_unit" } });
    },
  );

  it("bad init data → 401", async () => {
    await addUser(5);
    await unitBank(6, 3, 0);
    expect(await api("practice", { unit: 6 }, { initData: "user=%7B%22id%22%3A5%7D&hash=abc" })).toEqual({ status: 401, body: { error: "invalid_init_data" } });
  });
});

describe("unitTotal on start", () => {
  it("unit 5 drill with 6 of 18 learned: 6 cards, unitTotal 18", async () => {
    await addUser(5);
    await unitBank(5, 18, 6);
    const res = await api("start", { unit: 5 });
    expect(res.body.cards).toHaveLength(6);
    expect(res.body.unitTotal).toBe(18);
  });

  it("absent for the all-units drill", async () => {
    await learnedUser(3);
    expect((await api("start", undefined)).body).not.toHaveProperty("unitTotal");
  });
});
