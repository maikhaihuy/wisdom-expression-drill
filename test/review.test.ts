import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { t } from "../src/i18n";
import worker from "../src/index";
import { batchKeyboard, createBatch, parseGradeText, planBatches, readMarks, renderBatch, runSchedule, toggleKeyboard, type BatchPlan } from "../src/review";
import type { Result } from "../src/srs";
import type { InlineKeyboardMarkup } from "../src/telegram";
import {
  addExpressions,
  addSession,
  addUser,
  allStates,
  callback,
  count,
  DAY,
  deps,
  forbidden,
  getSessionRow,
  getState,
  HOUR,
  ids,
  itemResults,
  latestBatch,
  mockTelegram,
  msg,
  send,
  setState,
  T0,
} from "./helpers";

const cfg = () => config(env);

// ---------- 3.1 Candidates and createBatch ----------

describe("planBatches and createBatch", () => {
  it("selects due, then new, and skips archived expressions", async () => {
    const user = await addUser(5);
    await addExpressions([...ids("d", 3), { id: "gone", archived: 1 }, ...ids("n", 5), ...ids("x", 4)]);
    for (const id of ids("d", 3)) await setState(5, id, { due_at: T0 - HOUR });
    await setState(5, "gone", { due_at: T0 - HOUR, misses: 9 });
    for (const id of ids("x", 4)) await setState(5, id, { due_at: T0 + DAY });

    const plan = (await planBatches(env.DB, [user], T0, cfg(), deps.rng)).get(5)!;
    const chosen = plan.items.map((i) => i.id).sort();
    expect(chosen).toEqual(["d01", "d02", "d03", "n01", "n02", "n03"]);
    expect(plan.newCount).toBe(3);
    expect(plan.sessionId).toBe(`b-5-${T0}`);
  });

  it("prefers the newest week for new items", async () => {
    const user = await addUser(5);
    await addExpressions([
      { id: "old", week: "2026-W40" },
      { id: "new1", week: "2026-W44" },
      { id: "mid", week: "2026-W42" },
      { id: "new2", week: "2026-W44" },
    ]);
    const plan = (await planBatches(env.DB, [user], T0, { ...cfg(), newPerBatch: 2, batchMin: 0 }, deps.rng)).get(5)!;
    expect(plan.items.map((i) => i.id).sort()).toEqual(["new1", "new2"]);
  });

  it("closes the previous open batch as skip, creates the session and counts new items", async () => {
    const user = await addUser(5, { new_today: 4, new_today_date: "2026-10-26" });
    await addExpressions(ids("e", 8));
    await setState(5, "e01", { box: 3 });
    const before = await allStates(5);
    // Open 10:00 batch with an uncommitted mark.
    await addSession("b-5-old", 5, ["e01", "e02"], { createdAt: T0 - 4 * HOUR, results: ["hit", null] });

    const plan: BatchPlan = {
      sessionId: `b-5-${T0}`,
      userId: 5,
      newCount: 2,
      items: (["e03", "e04", "e05"] as const).map((id, i) => ({ id, en: id, cue: id, examples: "[]", box: 0, due_at: 0, hits: 0, misses: 0, isNew: i < 2 })),
    };
    await createBatch(env.DB, plan, 321, user, T0);

    expect((await getSessionRow("b-5-old"))!.closed_at).toBe(T0);
    expect((await itemResults("b-5-old")).map((r) => [r.result, r.answered_at])).toEqual([
      ["skip", null],
      ["skip", null],
    ]);
    expect(await allStates(5)).toEqual(before);
    expect(await getSessionRow(plan.sessionId)).toMatchObject({ user_id: 5, message_id: 321, closed_at: null });
    expect((await itemResults(plan.sessionId)).map((r) => r.expr_id)).toEqual(["e03", "e04", "e05"]);
    expect(await env.DB.prepare("SELECT new_today, new_today_date FROM users WHERE id = 5").first()).toEqual({ new_today: 6, new_today_date: "2026-10-26" });
  });

  it("resets the new counter on a new local day", async () => {
    const user = await addUser(5, { new_today: 20, new_today_date: "2026-10-25" });
    await addExpressions(ids("n", 6));
    const plan = (await planBatches(env.DB, [user], T0, cfg(), deps.rng)).get(5)!;
    expect(plan.newCount).toBe(3);
    await createBatch(env.DB, plan, 1, user, T0);
    expect(await env.DB.prepare("SELECT new_today, new_today_date FROM users WHERE id = 5").first()).toEqual({ new_today: 3, new_today_date: "2026-10-26" });
  });

  it("sends no new items once the daily limit is reached", async () => {
    const user = await addUser(5, { new_today: 20, new_today_date: "2026-10-26" });
    await addExpressions(ids("n", 6));
    expect((await planBatches(env.DB, [user], T0, cfg(), deps.rng)).get(5)).toBeNull();
  });

  it("excludes the previous batch's items", async () => {
    const user = await addUser(5);
    await addExpressions(ids("d", 9));
    for (const id of ids("d", 9)) await setState(5, id, { due_at: T0 - HOUR });
    await addSession("b-5-prev", 5, ["d01"], { createdAt: T0 - 2 * HOUR, closedAt: T0 - HOUR, results: ["skip"] });
    const plan = (await planBatches(env.DB, [user], T0, cfg(), deps.rng)).get(5)!;
    expect(plan.items.map((i) => i.id)).not.toContain("d01");
    expect(plan.items).toHaveLength(8);
  });
});

// ---------- 3.2 Rendering ----------

describe("renderBatch", () => {
  const plan: BatchPlan = {
    sessionId: "b-5-1",
    userId: 5,
    newCount: 2,
    items: [
      { id: "a", en: "let it slide", cue: "bỏ qua lỗi nhỏ — someone cuts in line", examples: '["Just let it slide."]' },
      { id: "b", en: "R&D <team>", cue: "a < b & c > d", examples: "[]" },
      { id: "c", en: "call it a day", cue: "nghỉ thôi", examples: "[]" },
      { id: "d", en: "on the fence", cue: "phân vân", examples: "[]" },
      { id: "e", en: "cut corners", cue: "làm ẩu", examples: "[]" },
      { id: "f", en: "hit the sack", cue: "đi ngủ", examples: "[]" },
      { id: "g", en: "no-brainer", cue: "dễ ợt", examples: "[]" },
    ].map((x, i) => ({ ...x, box: 0, due_at: 0, hits: 0, misses: 0, isNew: i < 2 })),
  };

  it("renders header, numbered cues and spoilers", () => {
    const { text, reply_markup } = renderBatch(plan, T0, 420, null);
    expect(text).toMatchSnapshot();
    expect(reply_markup).toMatchSnapshot();
  });

  it("shows the local time and counts", () => {
    const { text } = renderBatch(plan, T0, 420, null);
    expect(text.split("\n")[0]).toBe("<b>Ôn 14:00</b> · 7 cụm (2 mới)");
    expect(text).toContain("1. bỏ qua lỗi nhỏ — someone cuts in line\n   <tg-spoiler>let it slide</tg-spoiler>");
  });

  it("escapes HTML in cues and expressions", () => {
    const { text } = renderBatch(plan, T0, 420, null);
    expect(text).toContain("2. a &lt; b &amp; c &gt; d\n   <tg-spoiler>R&amp;D &lt;team&gt;</tg-spoiler>");
    expect(text).not.toContain("<team>");
  });

  it("does not show examples", () => {
    expect(renderBatch(plan, T0, 420, null).text).not.toContain("Just let it slide.");
  });

  it("lays out item buttons in rows of 5, then the commit row", () => {
    const rows = renderBatch(plan, T0, 420, null).reply_markup.inline_keyboard;
    expect(rows.map((r) => r.map((b) => b.text))).toEqual([["1 ·", "2 ·", "3 ·", "4 ·", "5 ·"], ["6 ·", "7 ·"], [t.allCorrect, t.commit]]);
    expect(rows[0][2].callback_data).toBe("t:b-5-1:3");
    expect(rows[2].map((b) => b.callback_data)).toEqual(["a:b-5-1", "c:b-5-1"]);
  });

  it("adds the drill button when asked", () => {
    const rows = renderBatch(plan, T0, 420, "https://drill.test/drill/").reply_markup.inline_keyboard;
    expect(rows.at(-1)).toEqual([{ text: t.drillButton, web_app: { url: "https://drill.test/drill/" } }]);
  });

  it("omits the new count when there are no new items", () => {
    expect(renderBatch({ ...plan, newCount: 0 }, T0, 420, null).text.split("\n")[0]).toBe("<b>Ôn 14:00</b> · 7 cụm");
  });
});

// ---------- Keyboard marks (pure) ----------

describe("readMarks and toggleKeyboard", () => {
  const drill = { text: t.drillButton, web_app: { url: "https://drill.test/drill/" } };
  const kb = (marks: (Result | null)[]) => batchKeyboard("b-5-1", marks, [[drill]]);

  it.each([
    [null, "hit"],
    ["hit", "miss"],
    ["miss", null],
  ] as const)("cycles %s → %s", (from, to) => {
    const next = toggleKeyboard(kb([null, from, null]), 2)!;
    expect([...readMarks(next)]).toEqual([
      [1, null],
      [2, to],
      [3, null],
    ]);
  });

  it("matches what batchKeyboard renders for any marks", () => {
    const marks: (Result | null)[] = ["hit", null, "miss", null, "hit", "miss", null, null, "hit", null];
    expect([...readMarks(kb(marks)).values()]).toEqual(marks);
    expect(toggleKeyboard(kb(marks), 2)).toEqual(kb(["hit", "hit", "miss", null, "hit", "miss", null, null, "hit", null]));
  });

  it("handles a 10-item keyboard and leaves every other button intact", () => {
    const before = kb(Array(10).fill(null));
    const after = toggleKeyboard(before, 10)!;
    expect(after.inline_keyboard.map((r) => r.map((b) => b.text))).toEqual([
      ["1 ·", "2 ·", "3 ·", "4 ·", "5 ·"],
      ["6 ·", "7 ·", "8 ·", "9 ·", "10 ✓"],
      [t.allCorrect, t.commit],
      [t.drillButton],
    ]);
    // callback_data never changes, and the commit and drill rows are untouched.
    expect(after.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(before.inline_keyboard.flat().map((b) => b.callback_data));
    expect(after.inline_keyboard.slice(2)).toEqual(before.inline_keyboard.slice(2));
    expect(readMarks(after).get(10)).toBe("hit");
    expect(readMarks(after).get(1)).toBeNull();
  });

  it("returns null for an unknown position or a missing keyboard", () => {
    expect(toggleKeyboard(kb([null, null]), 7)).toBeNull();
    expect(toggleKeyboard(undefined, 1)).toBeNull();
    expect(readMarks(undefined).size).toBe(0);
  });

  it("ignores buttons that are not items", () => {
    expect([...readMarks({ inline_keyboard: [[{ text: "1 ✓", callback_data: "c:b-5-1" }, drill]] }).keys()]).toEqual([]);
  });
});

// ---------- 3.3 Schedule ----------

describe("scheduled batches", () => {
  const at = (hourUtc: number) => Date.UTC(2026, 9, 26, hourUtc) / 1000;

  it("07:00 UTC → a UTC+7 user receives the 14:00 batch", async () => {
    await addUser(5);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await runSchedule(env, at(7), deps);
    expect(tg.sent()).toHaveLength(1);
    expect(tg.sent()[0].body.chat_id).toBe(5);
    expect(tg.sent()[0].body.text).toContain("Ôn 14:00");
    expect(await latestBatch(5)).toMatchObject({ message_id: 500, closed_at: null });
  });

  it("16:00 UTC → nothing (23:00 local)", async () => {
    await addUser(5);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await runSchedule(env, at(16), deps);
    expect(tg.calls).toHaveLength(0);
  });

  it("odd local hours send nothing", async () => {
    await addUser(5);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await runSchedule(env, at(8), deps); // 15:00 local
    expect(tg.calls).toHaveLength(0);
  });

  it("each user follows their own timezone", async () => {
    await addUser(5);
    await addUser(6, { tz_offset_min: 540 }); // UTC+9
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await runSchedule(env, at(6), deps); // 13:00 UTC+7, 15:00 UTC+9 → nobody
    expect(tg.sent()).toHaveLength(0);
    await runSchedule(env, at(5), deps); // 12:00 UTC+7, 14:00 UTC+9 → both
    expect(tg.sent().map((c) => c.body.chat_id).sort()).toEqual([5, 6]);
  });

  it("skips paused and inactive users", async () => {
    await addUser(5, { paused_until: at(7) + HOUR });
    await addUser(6, { active: 0 });
    await addUser(7, { paused_until: at(7) - HOUR }); // pause already over
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await runSchedule(env, at(7), deps);
    expect(tg.sent().map((c) => c.body.chat_id)).toEqual([7]);
  });

  it("one failing user does not stop the others", async () => {
    for (const id of [5, 6, 7]) await addUser(id);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram((c) => (c.body.chat_id === 5 ? new Response("boom", { status: 500 }) : undefined));
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    try {
      await runSchedule(env, at(7), deps);
    } finally {
      console.error = orig;
    }
    expect(tg.sent().map((c) => c.body.chat_id)).toEqual([5, 6, 7]);
    expect(await latestBatch(5)).toBeNull();
    expect(await latestBatch(6)).not.toBeNull();
    expect(await latestBatch(7)).not.toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("a 403 deactivates the user and later runs skip them", async () => {
    await addUser(5);
    await addUser(6);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram((c) => (c.body.chat_id === 5 ? forbidden() : undefined));
    await runSchedule(env, at(7), deps);
    expect(await count("users", "id = 5 AND active = 0")).toBe(1);
    expect(await count("users", "id = 6 AND active = 1")).toBe(1);

    tg.calls.length = 0;
    await runSchedule(env, at(9), deps);
    expect(tg.sent().map((c) => c.body.chat_id)).toEqual([6]);
  });

  it("20:00 batch has the drill button unless the user drilled today", async () => {
    await addUser(5);
    await addUser(6, { last_drill_date: "2026-10-26" });
    await addUser(7, { last_drill_date: "2026-10-25" });
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await runSchedule(env, at(13), deps); // 20:00 local
    const hasDrill = (chatId: number) =>
      (tg.sent().find((c) => c.body.chat_id === chatId)!.body.reply_markup as InlineKeyboardMarkup).inline_keyboard.some((r) => r.some((b) => b.web_app));
    expect(hasDrill(5)).toBe(true);
    expect(hasDrill(6)).toBe(false);
    expect(hasDrill(7)).toBe(true);
  });

  it("other hours have no drill button", async () => {
    await addUser(5);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await runSchedule(env, at(7), deps);
    expect(JSON.stringify(tg.sent()[0].body.reply_markup)).not.toContain("web_app");
  });

  it("sends nothing when the bank is empty", async () => {
    await addUser(5);
    const tg = mockTelegram();
    await runSchedule(env, at(7), deps);
    expect(tg.calls).toHaveLength(0);
  });

  it("is wired to the Worker's scheduled handler", async () => {
    await addUser(5);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(at(7) * 1000), cron: "0 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(tg.sent()).toHaveLength(1);
  });
});

// ---------- 3.4 Buttons ----------

async function openBatch(n: number, opts: { userId?: number; results?: (string | null)[] } = {}) {
  const userId = opts.userId ?? 5;
  await addUser(userId);
  const exprs = ids("e", n).map((id) => ({ id, en: `en ${id}`, cue: `cue ${id}`, examples: [`example ${id}`] }));
  await addExpressions(exprs);
  await addSession("b-5-1", userId, exprs.map((e) => e.id), { createdAt: T0 - HOUR, results: opts.results });
  return exprs.map((e) => e.id);
}

const labels = (call: { body: { reply_markup: InlineKeyboardMarkup } }) => call.body.reply_markup.inline_keyboard.flat().map((b) => b.text);

// Acts like the Telegram client: every tap carries the keyboard on screen, and each
// editMessageReplyMarkup replaces it.
function phone(tg: ReturnType<typeof mockTelegram>, n: number, extraRows: InlineKeyboardMarkup["inline_keyboard"] = []) {
  let keyboard = batchKeyboard("b-5-1", Array(n).fill(null), extraRows);
  return {
    async tap(data: string, now = T0) {
      const answer = await send(callback(5, data, { markup: keyboard }), now);
      const edit = tg.edits().at(-1);
      if (edit) keyboard = edit.body.reply_markup;
      return answer;
    },
    keyboard: () => keyboard,
  };
}

describe("grading with buttons", () => {
  it("toggle cycles · → ✓ → ✗ → · from the keyboard alone", async () => {
    await openBatch(3);
    const tg = mockTelegram();
    const p = phone(tg, 3);
    for (let i = 0; i < 3; i++) expect(await p.tap("t:b-5-1:2")).toEqual({ method: "answerCallbackQuery", callback_query_id: expect.any(String) });
    expect(tg.edits().map((c) => labels(c).slice(0, 3))).toEqual([
      ["1 ·", "2 ✓", "3 ·"],
      ["1 ·", "2 ✗", "3 ·"],
      ["1 ·", "2 ·", "3 ·"],
    ]);
    // Answered in the webhook response, not by a separate Bot API call; nothing in D1.
    expect(tg.answers()).toHaveLength(0);
    expect((await itemResults("b-5-1")).map((r) => r.result)).toEqual([null, null, null]);
    expect(await count("card_state")).toBe(0);
  });

  it("a toggle runs zero D1 queries", async () => {
    await openBatch(3);
    const tg = mockTelegram();
    let queries = 0;
    const spy = new Proxy(env.DB, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          queries++;
          return value.apply(target, args);
        };
      },
    });
    await send(callback(5, "t:b-5-1:1", { markup: batchKeyboard("b-5-1", [null, null, null]) }), T0, { ...env, DB: spy });
    expect(queries).toBe(0);
    expect(tg.edits()).toHaveLength(1);
  });

  it("ignores \"message is not modified\" on the keyboard edit", async () => {
    await openBatch(2);
    const warnings: unknown[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a);
    mockTelegram((c) =>
      c.method === "editMessageReplyMarkup" ? Response.json({ ok: false, description: "Bad Request: message is not modified" }, { status: 400 }) : undefined,
    );
    try {
      expect(await send(callback(5, "t:b-5-1:1", { markup: batchKeyboard("b-5-1", [null, null]) }))).not.toBeNull();
    } finally {
      console.warn = orig;
    }
    expect(warnings).toHaveLength(0);
  });

  it("toggle then commit: item 2 miss, the rest skip, only item 2 changes", async () => {
    await openBatch(5);
    await setState(5, "e04", { box: 3, hits: 2 });
    const tg = mockTelegram();
    const p = phone(tg, 5);
    await p.tap("t:b-5-1:2");
    await p.tap("t:b-5-1:2");
    expect(await p.tap("c:b-5-1")).toEqual({ method: "answerCallbackQuery", callback_query_id: expect.any(String) });

    expect((await itemResults("b-5-1")).map((r) => r.result)).toEqual(["skip", "miss", "skip", "skip", "skip"]);
    expect((await getSessionRow("b-5-1"))!.closed_at).toBe(T0);
    expect(await allStates(5)).toEqual([
      expect.objectContaining({ expr_id: "e02", box: 1, misses: 1, hits: 0, due_at: T0 + 4 * HOUR }),
      expect.objectContaining({ expr_id: "e04", box: 3, hits: 2 }),
    ]);
    // Keyboard reduced to nothing, summary sent.
    expect(p.keyboard()).toEqual({ inline_keyboard: [] });
    expect(tg.lastText()).toContain("0/1");
  });

  it("all correct keeps explicit misses and marks the rest hit", async () => {
    await openBatch(5);
    const p = phone(mockTelegram(), 5);
    await p.tap("t:b-5-1:4");
    await p.tap("t:b-5-1:4");
    await p.tap("a:b-5-1");
    expect((await itemResults("b-5-1")).map((r) => r.result)).toEqual(["hit", "hit", "hit", "miss", "hit"]);
    expect(await count("card_state", "user_id = 5 AND box = 1 AND hits = 1")).toBe(4);
    expect(await count("card_state", "user_id = 5 AND misses = 1")).toBe(1);
  });

  it("commit saves the keyboard's marks, not stale marks stored in D1", async () => {
    // A batch opened before this change may still hold toggles in session_items.
    await openBatch(3, { results: ["miss", "hit", null] });
    const p = phone(mockTelegram(), 3);
    await p.tap("t:b-5-1:3");
    await p.tap("c:b-5-1");
    expect((await itemResults("b-5-1")).map((r) => r.result)).toEqual(["skip", "skip", "hit"]);
  });

  it("commit on a closed batch gets a notice and changes nothing", async () => {
    await addUser(5);
    await addExpressions(["a"]);
    await addSession("b-5-1", 5, ["a"], { closedAt: T0 - 60, results: ["hit"] });
    const tg = mockTelegram();
    const p = phone(tg, 1);
    expect((await p.tap("c:b-5-1"))!.text).toBe(t.batchClosed);
    expect((await p.tap("a:b-5-1"))!.text).toBe(t.batchClosed);
    expect(tg.calls).toHaveLength(0);
    expect((await itemResults("b-5-1"))[0].result).toBe("hit");
    expect(await count("card_state")).toBe(0);
  });

  it("double commit applies results once", async () => {
    await openBatch(3);
    const tg = mockTelegram();
    const markup = batchKeyboard("b-5-1", [null, null, null]);
    const answers = await Promise.all([send(callback(5, "a:b-5-1", { markup })), send(callback(5, "a:b-5-1", { markup }))]);
    expect(await count("card_state", "user_id = 5 AND hits = 1 AND box = 1")).toBe(3);
    expect(answers.map((a) => a!.text).filter((x) => x === t.batchClosed)).toHaveLength(1);
    expect(tg.sent()).toHaveLength(1); // one summary
  });

  it("keeps the drill button when the keyboard changes", async () => {
    await openBatch(2);
    const drill = [{ text: t.drillButton, web_app: { url: "https://drill.test/drill/" } }];
    const tg = mockTelegram();
    const p = phone(tg, 2, [drill]);
    await p.tap("t:b-5-1:1");
    expect(labels(tg.edits()[0])).toContain(t.drillButton);
    await p.tap("c:b-5-1");
    expect(p.keyboard().inline_keyboard).toEqual([drill]);
  });

  it("rejects malformed callback data", async () => {
    await openBatch(2);
    mockTelegram();
    expect((await send(callback(5, "zzz")))!.text).toBe(t.notYourBatch);
  });

  it("a newer batch closes the old one as skip and removes its buttons", async () => {
    await openBatch(3);
    await setState(5, "e01", { box: 3, hits: 4 });
    const before = await allStates(5);
    const tg = mockTelegram();
    const p = phone(tg, 3);
    await p.tap("t:b-5-1:1");
    await p.tap("t:b-5-1:2");
    await p.tap("t:b-5-1:2");

    await send(msg(5, "/next"), T0 + 60);
    expect((await getSessionRow("b-5-1"))!.closed_at).toBe(T0 + 60);
    expect((await itemResults("b-5-1")).map((r) => r.result)).toEqual(["skip", "skip", "skip"]);
    expect(await allStates(5)).toEqual(before);
    // The old message (id 77) loses its keyboard, so its stale buttons cannot be tapped.
    expect(tg.edits().at(-1)!.body).toMatchObject({ message_id: 77, reply_markup: { inline_keyboard: [] } });
  });

  it("the cron also removes the buttons of the batch it closes", async () => {
    await openBatch(6);
    const tg = mockTelegram();
    await runSchedule(env, T0 + HOUR, deps); // 15:00 local: odd hour, nothing
    await runSchedule(env, T0 + 2 * HOUR, deps); // 16:00 local
    expect(tg.edits().map((c) => c.body)).toEqual([expect.objectContaining({ chat_id: 5, message_id: 77, reply_markup: { inline_keyboard: [] } })]);
  });
});

describe("webhook answers callbacks in the response body", () => {
  async function post(update: unknown) {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://worker.test/tg/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET },
        body: JSON.stringify(update),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("a toggle is answered by the response; no separate answerCallbackQuery call", async () => {
    await openBatch(2);
    const tg = mockTelegram();
    const update = callback(5, "t:b-5-1:1", { markup: batchKeyboard("b-5-1", [null, null]) });
    const res = await post(update);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ method: "answerCallbackQuery", callback_query_id: update.callback_query!.id });
    expect(tg.answers()).toHaveLength(0);
    expect(tg.edits()).toHaveLength(1);
  });

  it("carries the notice for a closed batch", async () => {
    await addUser(5);
    await addExpressions(["a"]);
    await addSession("b-5-1", 5, ["a"], { closedAt: T0 - 60 });
    mockTelegram();
    const res = await post(callback(5, "c:b-5-1"));
    expect(await res.json()).toMatchObject({ method: "answerCallbackQuery", text: t.batchClosed });
  });

  it("still answers when handling fails", async () => {
    await openBatch(2);
    mockTelegram();
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a);
    await env.DB.exec("DROP TABLE session_items"); // make the commit fail
    try {
      const update = callback(5, "c:b-5-1", { markup: batchKeyboard("b-5-1", [null, null]) });
      const res = await post(update);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ method: "answerCallbackQuery", callback_query_id: update.callback_query!.id });
    } finally {
      console.error = orig;
    }
    expect(errors).toHaveLength(1);
  });
});

describe("text grading removes the batch's buttons", () => {
  it("removes the item buttons after a text commit", async () => {
    await openBatch(2);
    const tg = mockTelegram();
    await send(msg(5, "ok"));
    expect(tg.edits().map((c) => c.body)).toEqual([expect.objectContaining({ message_id: 77, reply_markup: { inline_keyboard: [] } })]);
  });

  it("keeps the drill button on the 20:00 batch when the user has not drilled", async () => {
    await addUser(5);
    await addExpressions(["a"]);
    await addSession("b-5-1", 5, ["a"], { createdAt: T0 + 6 * HOUR }); // 20:00 local
    const tg = mockTelegram();
    await send(msg(5, "o"), T0 + 6 * HOUR + 60);
    expect(tg.edits()[0].body.reply_markup).toEqual({ inline_keyboard: [[{ text: t.drillButton, web_app: { url: "https://drill.test/drill/" } }]] });
  });
});

// ---------- 3.5 Text grading ----------

describe("parseGradeText", () => {
  const H = "hit";
  const M = "miss";
  const S = "skip";
  it.each([
    ["1o 2x 4o", 5, [H, M, S, H, S]],
    ["1-o, 2-x", 3, [H, M, S]],
    ["1O 2X", 2, [H, M]],
    ["  3x  ", 3, [S, S, M]],
    ["oxoox", 5, [H, M, H, H, M]],
    ["OXO", 3, [H, M, H]],
    ["ok", 4, [H, H, H, H]],
    ["All O", 2, [H, H]],
    ["x 2 5", 6, [H, M, H, H, M, H]],
    ["x 1, 3", 3, [M, H, M]],
  ])("%j for %i items", (text, n, expected) => {
    expect(parseGradeText(text, n)).toEqual(expected);
  });

  it.each([
    ["hmm", 5],
    ["oxo", 5], // positional length differs
    ["oxoooo", 5],
    ["1o 6x", 5], // out of range
    ["0o", 5],
    ["x 7", 6],
    ["x", 5],
    ["1o 2", 5],
    ["", 5],
    ["okay", 5],
  ])("%j for %i items is rejected", (text, n) => {
    expect(parseGradeText(text, n)).toBeNull();
  });
});

describe("grading with text", () => {
  it("numbered form commits the latest open batch", async () => {
    await openBatch(5);
    const tg = mockTelegram();
    await send(msg(5, "1o 2x 4o"));
    expect((await itemResults("b-5-1")).map((r) => r.result)).toEqual(["hit", "miss", "skip", "hit", "skip"]);
    expect((await getSessionRow("b-5-1"))!.closed_at).toBe(T0);
    expect(tg.lastText()).toContain("2/3");
  });

  it("positional form", async () => {
    await openBatch(5);
    mockTelegram();
    await send(msg(5, "oxoox"));
    expect((await itemResults("b-5-1")).map((r) => r.result)).toEqual(["hit", "miss", "hit", "hit", "miss"]);
  });

  it("text overrides uncommitted button marks", async () => {
    await openBatch(3, { results: ["miss", null, null] });
    mockTelegram();
    await send(msg(5, "ok"));
    expect((await itemResults("b-5-1")).map((r) => r.result)).toEqual(["hit", "hit", "hit"]);
  });

  it.each(["hmm", "oxo"])("unparseable %j records nothing and shows the formats", async (text) => {
    await openBatch(5);
    const tg = mockTelegram();
    await send(msg(5, text));
    expect(tg.lastText()).toBe(t.gradeHelp);
    expect((await getSessionRow("b-5-1"))!.closed_at).toBeNull();
    expect(await count("card_state")).toBe(0);
  });

  it("no open batch → nothing recorded", async () => {
    await addUser(5);
    await addExpressions(["a"]);
    await addSession("b-5-1", 5, ["a"], { closedAt: T0 - 60, results: ["skip"] });
    const tg = mockTelegram();
    await send(msg(5, "1o 2x"));
    expect(tg.lastText()).toBe(t.noOpenBatch);
    expect(await count("card_state")).toBe(0);
  });

  it("grades the latest open batch only", async () => {
    await addUser(5);
    await addExpressions(["a", "b"]);
    await addSession("b-5-old", 5, ["a"], { createdAt: T0 - 3 * HOUR });
    await addSession("b-5-new", 5, ["b"], { createdAt: T0 - HOUR });
    mockTelegram();
    await send(msg(5, "x"));
    expect((await itemResults("b-5-new"))[0].result).toBe("miss");
    expect((await getSessionRow("b-5-old"))!.closed_at).toBeNull();
  });
});

// ---------- 3.6 Summary ----------

describe("commit summary", () => {
  it("lists both misses with cue and first example", async () => {
    await openBatch(7);
    const tg = mockTelegram();
    await send(msg(5, "x 2 5"));
    const text = tg.lastText()!;
    expect(text).toContain("<b>5/7</b>");
    for (const id of ["e02", "e05"]) {
      expect(text).toContain(`✗ <b>en ${id}</b> — cue ${id}\n   <i>example ${id}</i>`);
    }
    expect(text).not.toContain("en e01");
    expect(text).toMatchSnapshot();
  });

  it("escapes bank text and handles items without examples", async () => {
    await addUser(5);
    await addExpressions([{ id: "a", en: "R&D", cue: "x < y", examples: [] }]);
    await addSession("b-5-1", 5, ["a"]);
    const tg = mockTelegram();
    await send(msg(5, "x"));
    expect(tg.lastText()).toContain("✗ <b>R&amp;D</b> — x &lt; y");
    expect(tg.lastText()).not.toContain("<i>");
  });

  it("states when nothing was graded", async () => {
    await openBatch(2);
    const tg = mockTelegram();
    await send(callback(5, "c:b-5-1"));
    expect(tg.lastText()).toBe(t.score(0, 0));
  });
});

describe("previous state is preserved across days", () => {
  it("commit uses the stored state", async () => {
    await openBatch(1);
    await setState(5, "e01", { box: 2, hits: 4, misses: 1, due_at: T0 - DAY });
    mockTelegram();
    await send(msg(5, "o"));
    expect(await getState(5, "e01")).toMatchObject({ box: 3, hits: 5, misses: 1, due_at: T0 + 3 * DAY, last_seen_at: T0 });
  });
});
