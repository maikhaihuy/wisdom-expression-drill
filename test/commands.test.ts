import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { computeStreak, formatOffset, parsePause, parseTz, parseUnitArg } from "../src/commands";
import { t } from "../src/i18n";
import { runSchedule } from "../src/review";
import {
  addExpressions,
  addSession,
  addUser,
  count,
  DAY,
  deps,
  getSessionRow,
  HOUR,
  ids,
  latestBatch,
  mockTelegram,
  msg,
  send,
  setState,
  T0,
} from "./helpers";

const userRow = (id: number) => env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<{ paused_until: number | null; tz_offset_min: number }>();

// ---------- 4.1 /next /drill /pause /resume /tz ----------

describe("/next", () => {
  it("sends a batch at 23:15 local, even while paused, and closes the open batch", async () => {
    await addUser(5, { paused_until: T0 + DAY });
    await addExpressions(ids("e", 6));
    await addSession("b-5-old", 5, ["e01"], { createdAt: T0 - HOUR });
    const now = T0 + 9 * HOUR + 15 * 60; // 23:15 local
    const tg = mockTelegram();
    await send(msg(5, "/next"), now);

    expect(tg.sent()).toHaveLength(1);
    expect(tg.lastText()).toContain("Ôn 23:15");
    expect((await getSessionRow("b-5-old"))!.closed_at).toBe(now);
    expect(await latestBatch(5)).toMatchObject({ id: `b-5-${now}`, closed_at: null });
  });

  it("accepts the @botname suffix", async () => {
    await addUser(5);
    await addExpressions(ids("e", 2));
    const tg = mockTelegram();
    await send(msg(5, "/next@ExpressionDrillBot"));
    expect(tg.lastText()).toContain("Ôn 14:00");
  });

  it("says so when there is nothing to review", async () => {
    await addUser(5);
    const tg = mockTelegram();
    await send(msg(5, "/next"));
    expect(tg.lastText()).toBe(t.emptyBank);
    expect(await count("sessions")).toBe(0);
  });
});

describe("/drill", () => {
  it("replies with a web_app button to /drill/", async () => {
    await addUser(5);
    const tg = mockTelegram();
    await send(msg(5, "/drill"));
    expect(tg.sent()[0].body.reply_markup.inline_keyboard).toEqual([[{ text: t.drillButton, web_app: { url: "https://drill.test/drill/" } }]]);
    expect(tg.lastText()).toBe("Luyện phản xạ: 5 phút, mỗi cụm 10 giây.");
  });

  it("/drill 4 opens the unit 4 drill directly", async () => {
    await addUser(5);
    const tg = mockTelegram();
    await send(msg(5, "/drill 4"));
    const [[button]] = tg.sent()[0].body.reply_markup.inline_keyboard;
    expect(button.web_app.url).toBe("https://drill.test/drill/?unit=4");
    expect(button.web_app.url.endsWith("?unit=4")).toBe(true);
    expect(tg.lastText()).toBe("Luyện phản xạ unit 4: tối đa 5 phút, mỗi cụm 10 giây.");
  });

  it.each(["/drill abc", "/drill 0", "/drill -2", "/drill 4 5"])("%s → usage, no button", async (text) => {
    await addUser(5);
    const tg = mockTelegram();
    await send(msg(5, text));
    expect(tg.sent()[0].body.reply_markup).toBeUndefined();
    expect(tg.lastText()).toBe(t.drillUsage);
  });
});

describe("parseUnitArg", () => {
  it.each([
    ["", null],
    ["  ", null],
    ["4", 4],
    [" 12 ", 12],
    ["0", undefined],
    ["abc", undefined],
    ["4.5", undefined],
    ["+4", undefined],
  ])("%j → %j", (arg, expected) => {
    expect(parseUnitArg(arg)).toBe(expected);
  });
});

describe("/pause and /resume", () => {
  it("/pause 2d stops scheduled batches for 48 hours", async () => {
    await addUser(5);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await send(msg(5, "/pause 2d"));
    expect((await userRow(5))!.paused_until).toBe(T0 + 2 * DAY);
    expect(tg.lastText()).toBe(t.paused("14:00 28/10"));

    tg.calls.length = 0;
    await runSchedule(env, T0 + 2 * HOUR, deps);
    await runSchedule(env, T0 + 2 * DAY - 2 * HOUR, deps);
    expect(tg.sent()).toHaveLength(0);
    await runSchedule(env, T0 + 2 * DAY, deps);
    expect(tg.sent()).toHaveLength(1);
  });

  it.each(["forever", "", "0h", "31d", "2w", "-3h"])("/pause %j shows usage and changes nothing", async (arg) => {
    await addUser(5, { paused_until: T0 + HOUR });
    const tg = mockTelegram();
    await send(msg(5, `/pause ${arg}`.trim()));
    expect((await userRow(5))!.paused_until).toBe(T0 + HOUR);
    expect(tg.lastText()).toBe(t.pauseUsage);
  });

  it("/resume clears the pause", async () => {
    await addUser(5, { paused_until: T0 + DAY });
    const tg = mockTelegram();
    await send(msg(5, "/resume"));
    expect((await userRow(5))!.paused_until).toBeNull();
    expect(tg.lastText()).toBe(t.resumed);
  });

  it.each([
    ["1h", HOUR],
    ["3H", 3 * HOUR],
    ["30d", 30 * DAY],
    ["2 d", 2 * DAY],
  ])("parsePause(%j)", (arg, seconds) => {
    expect(parsePause(arg)).toBe(seconds);
  });
});

describe("/tz", () => {
  it("/tz +9 sets 540 and batches follow UTC+9", async () => {
    await addUser(5);
    await addExpressions(ids("e", 6));
    const tg = mockTelegram();
    await send(msg(5, "/tz +9"));
    expect((await userRow(5))!.tz_offset_min).toBe(540);
    expect(tg.lastText()).toBe(t.tzSet("+9", "16:00 26/10"));

    tg.calls.length = 0;
    await runSchedule(env, Date.UTC(2026, 9, 26, 7) / 1000, deps); // 16:00 UTC+9 → sends
    await runSchedule(env, Date.UTC(2026, 9, 26, 6) / 1000, deps); // 15:00 UTC+9 → odd hour, nothing
    expect(tg.sent()).toHaveLength(1);
    expect(tg.lastText()).toContain("Ôn 16:00");
  });

  it("invalid value shows usage", async () => {
    await addUser(5);
    const tg = mockTelegram();
    await send(msg(5, "/tz Asia/Tokyo"));
    expect((await userRow(5))!.tz_offset_min).toBe(420);
    expect(tg.lastText()).toBe(t.tzUsage);
  });

  it.each([
    ["+7", 420],
    ["-5", -300],
    ["+5:30", 330],
    ["7", 420],
    ["+14", 840],
    ["-12", -720],
    ["+0", 0],
    ["-3:30", -210],
  ])("parseTz(%j) = %i", (arg, minutes) => {
    expect(parseTz(arg)).toBe(minutes);
  });

  it.each(["+15", "-13", "+14:30", "+5:60", "abc", "", "+5:3"])("parseTz(%j) is invalid", (arg) => {
    expect(parseTz(arg)).toBeNull();
  });

  it.each([
    [420, "+7"],
    [-300, "-5"],
    [330, "+5:30"],
    [-210, "-3:30"],
    [0, "+0"],
  ])("formatOffset(%i) = %j", (minutes, label) => {
    expect(formatOffset(minutes)).toBe(label);
  });
});

// ---------- 4.2 /stats and /hard ----------

describe("/stats", () => {
  async function fixture() {
    await addUser(5);
    await addUser(6);
    await addExpressions([...ids("e", 6), { id: "z", archived: 1 }]);
    for (const [id, box] of [["e01", 1], ["e02", 1], ["e03", 2], ["e04", 4], ["e05", 6], ["z", 3]] as const) await setState(5, id, { box, due_at: T0 + DAY });
    const graded = (id: string, at: number, exprs: string[], results: string[]) =>
      addSession(id, 5, exprs, { createdAt: at, closedAt: at + 60, results, answeredAt: at + 30 });
    await graded("s-today", T0 - HOUR, ["e01", "e02", "e06"], ["hit", "miss", "skip"]);
    await graded("s-1d", T0 - DAY, ["e03", "e04"], ["hit", "hit"]);
    await graded("s-2d", T0 - 2 * DAY, ["e05"], ["hit"]);
    await graded("s-4d", T0 - 4 * DAY, ["e01"], ["miss"]); // gap on day 3 ends the streak
    await graded("s-10d", T0 - 10 * DAY, ["e02", "e03"], ["hit", "hit"]); // outside 7 days
    // Another user's history must not leak in.
    await setState(6, "e06", { box: 5 });
    await addSession("other", 6, ["e01", "e02", "e03"], { createdAt: T0 - 3 * DAY, closedAt: T0, results: ["miss", "miss", "miss"] });
  }

  it("shows box counts, 7-day accuracy and streak from the user's own data", async () => {
    await fixture();
    const tg = mockTelegram();
    await send(msg(5, "/stats"));
    // 7 days: hits 1 + 2 + 1 + 0 = 4 of 6 graded; streak today, yesterday, 2 days ago.
    expect(tg.lastText()).toBe(t.stats({ bank: 6, seen: 5, boxes: [2, 1, 0, 1, 0, 1], accuracy: 4 / 6, streak: 3 }));
    expect(tg.lastText()).toContain("Hộp: 1:2  2:1  3:0  4:1  5:0  6:1");
    expect(tg.lastText()).toContain("67%");
    expect(tg.lastText()).toContain("3 ngày");
  });

  it("works for a brand-new user", async () => {
    await addUser(5);
    await addExpressions(ids("e", 3));
    const tg = mockTelegram();
    await send(msg(5, "/stats"));
    expect(tg.lastText()).toBe(t.stats({ bank: 3, seen: 0, boxes: [0, 0, 0, 0, 0, 0], accuracy: null, streak: 0 }));
  });

  it.each([
    [["2026-10-26", "2026-10-25", "2026-10-24", "2026-10-22"], 3],
    [["2026-10-25", "2026-10-24"], 2], // nothing yet today: streak continues from yesterday
    [["2026-10-24"], 0],
    [[], 0],
    [["2026-10-26"], 1],
  ])("computeStreak(%j) = %i", (dates, n) => {
    expect(computeStreak(dates, "2026-10-26")).toBe(n);
  });
});

describe("/hard", () => {
  it("lists active expressions with 3+ answers by miss rate", async () => {
    await addUser(5);
    await addExpressions([...ids("e", 4), { id: "z", archived: 1 }]);
    await setState(5, "e01", { hits: 1, misses: 4 }); // 5/7
    await setState(5, "e02", { hits: 5, misses: 1 }); // 2/8
    await setState(5, "e03", { hits: 0, misses: 2 }); // only 2 answers
    await setState(5, "e04", { hits: 2, misses: 2 }); // 3/6
    await setState(5, "z", { hits: 0, misses: 9 }); // archived
    const tg = mockTelegram();
    await send(msg(5, "/hard"));
    const lines = tg.lastText()!.split("\n");
    expect(lines[0]).toBe(t.hardTitle);
    expect(lines.slice(1)).toEqual([
      "• <b>en e01</b> — cue e01 (✓1 ✗4)",
      "• <b>en e04</b> — cue e04 (✓2 ✗2)",
      "• <b>en e02</b> — cue e02 (✓5 ✗1)",
    ]);
  });

  it("says there is not enough data", async () => {
    await addUser(5);
    await addExpressions(["a"]);
    await setState(5, "a", { hits: 1, misses: 1 });
    const tg = mockTelegram();
    await send(msg(5, "/hard"));
    expect(tg.lastText()).toBe(t.hardEmpty);
  });

  it("caps the list at 10", async () => {
    await addUser(5);
    await addExpressions(ids("e", 12));
    for (const id of ids("e", 12)) await setState(5, id, { hits: 1, misses: 3 });
    const tg = mockTelegram();
    await send(msg(5, "/hard"));
    expect(tg.lastText()!.split("\n")).toHaveLength(11);
  });
});

// ---------- 4.3 /members and unknown commands ----------

describe("/members", () => {
  it("admin sees every user, including inactive ones", async () => {
    await addUser(1000, { role: "admin", name: "Huy", created_at: 1 });
    await addUser(5, { name: "Lan", created_at: 2 });
    await addUser(6, { name: "Minh <3", active: 0, created_at: 3 });
    await addExpressions(["a", "b"]);
    await addSession("s", 5, ["a", "b"], { createdAt: T0 - DAY, closedAt: T0 - DAY, results: ["hit", "miss"] });
    const tg = mockTelegram();
    await send(msg(1000, "/members"));
    expect(tg.lastText()!.split("\n")).toEqual([
      t.membersTitle,
      `🟢 Huy (admin) · ${t.never} · 7 ngày: –`,
      "🟢 Lan · 2026-10-25 · 7 ngày: 50%",
      `⚪️ Minh &lt;3 · ${t.never} · 7 ngày: –`,
    ]);
  });

  it("member is refused", async () => {
    await addUser(5);
    const tg = mockTelegram();
    await send(msg(5, "/members"));
    expect(tg.lastText()).toBe(t.adminOnly);
  });
});

describe("unknown commands", () => {
  it("a typo gets the command list", async () => {
    await addUser(5);
    const tg = mockTelegram();
    await send(msg(5, "/stat"));
    expect(tg.lastText()).toBe(t.help);
    for (const c of ["/next", "/drill", "/stats", "/hard", "/pause", "/resume", "/tz"]) expect(tg.lastText()).toContain(c);
  });

  it("admin help also lists admin commands", async () => {
    await addUser(1000, { role: "admin" });
    const tg = mockTelegram();
    await send(msg(1000, "/help"));
    expect(tg.lastText()).toContain("/invite");
    expect(tg.lastText()).toContain("/members");
  });
});
