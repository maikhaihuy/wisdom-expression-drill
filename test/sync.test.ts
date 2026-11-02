import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BankRow } from "../src/db";
import worker from "../src/index";
import { classifyItems, computeArchiveSet, type SyncItem, type SyncReport } from "../src/sync";

// ---------- Helpers ----------

function item(id: string, week = "2026-W43", hash = `h-${id}`): SyncItem {
  return { id, en: id.replaceAll("-", " "), cue: `cue ${id}`, examples: [`ex ${id}`], note: null, tags: [], added_week: week, content_hash: hash };
}

function payload(mode: "all" | "week", items: unknown[], week: string | null = mode === "week" ? "2026-W43" : null) {
  return { version: 3, mode, week, generated_at: "2026-10-24T07:00:00Z", items, warnings: [] };
}

// A DB that records batch sizes and can append an extra statement to every batch.
function spyDb(extra?: (db: D1Database) => D1PreparedStatement) {
  const batches: number[] = [];
  const db = {
    prepare: (q: string) => env.DB.prepare(q),
    batch: (stmts: D1PreparedStatement[]) => {
      batches.push(stmts.length);
      return env.DB.batch(extra ? [...stmts, extra(env.DB)] : stmts);
    },
  } as unknown as D1Database;
  return { db, batches };
}

async function post(body: unknown, opts: { auth?: string | null; db?: D1Database } = {}) {
  const auth = opts.auth === undefined ? `Bearer ${env.SYNC_TOKEN}` : opts.auth;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  const request = new Request("https://worker.test/admin/sync", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { ...env, DB: opts.db ?? env.DB }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function syncOk(body: unknown, db?: D1Database): Promise<SyncReport> {
  const res = await post(body, { db });
  expect(res.status).toBe(200);
  return res.json();
}

async function bank() {
  const { results } = await env.DB.prepare("SELECT * FROM expressions ORDER BY id").all<Record<string, unknown>>();
  return results;
}

async function seedReviewState(exprId: string, userIds: number[]) {
  for (const uid of userIds) {
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, 0)").bind(uid, `u${uid}`).run();
    await env.DB.prepare("INSERT INTO card_state (user_id, expr_id, box, due_at, hits, misses, lapses) VALUES (?, ?, 3, 12345, 4, 1, 1)")
      .bind(uid, exprId)
      .run();
  }
}

async function cardStates(exprId: string) {
  const { results } = await env.DB.prepare("SELECT user_id, box, due_at, hits, misses, lapses FROM card_state WHERE expr_id = ? ORDER BY user_id")
    .bind(exprId)
    .all();
  return results;
}

afterEach(() => vi.restoreAllMocks());

// ---------- 2.1 Authentication ----------

describe("authentication", () => {
  it("accepts the correct bearer token", async () => {
    const res = await post(payload("week", [item("let-it-slide")]));
    expect(res.status).toBe(200);
    expect(await bank()).toHaveLength(1);
  });

  it.each([
    ["missing header", null],
    ["wrong token", "Bearer nope"],
    ["token without Bearer", "test-sync-token"],
  ])("rejects %s with 401 and changes nothing", async (_name, auth) => {
    const res = await post(payload("week", [item("let-it-slide")]), { auth });
    expect(res.status).toBe(401);
    expect(await bank()).toHaveLength(0);
  });

  it("only accepts POST", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://worker.test/admin/sync"), env, ctx);
    expect(res.status).toBe(405);
  });
});

// ---------- 2.2 Validation ----------

describe("payload validation", () => {
  const { content_hash: _h, ...noHash } = item("a");
  const { en: _e, ...noEn } = item("a");
  const { cue: _c, ...noCue } = item("a");
  const { id: _i, ...noId } = item("a");

  it.each([
    ["invalid JSON", "{not json", /invalid JSON/],
    ["version 2", { ...payload("week", [item("a")]), version: 2 }, /version/],
    ["unknown mode", { ...payload("week", [item("a")]), mode: "some" }, /mode/],
    ["malformed week", payload("week", [item("a", "2026-43")], "2026-43"), /week/],
    ["missing week in week mode", payload("week", [item("a")], null), /week/],
    ["week set in all mode", payload("all", [item("a")], "2026-W43"), /week must be omitted/],
    ["item outside declared week", payload("week", [item("a"), item("b", "2026-W42")]), /item 1 \(b\).*outside week/],
    ["empty items", payload("week", []), /non-empty/],
    ["missing en", payload("week", [noEn]), /item 0 \(a\): missing en/],
    ["missing cue", payload("week", [noCue]), /item 0 \(a\): missing cue/],
    ["missing id", payload("week", [item("x"), noId]), /item 1: missing id/],
    ["missing content_hash", payload("week", [noHash]), /item 0 \(a\): missing content_hash/],
    ["duplicate id", payload("week", [item("a"), item("a")]), /duplicate id/],
  ])("%s → 422 with unchanged bank", async (_name, body, reason) => {
    await syncOk(payload("all", [item("keep", "2026-W43")]));
    const before = await bank();

    const res = await post(body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(reason);
    expect(await bank()).toEqual(before);
  });
});

// ---------- 2.3 Classification ----------

describe("classifyItems", () => {
  const row = (id: string, week: string, hash: string, archived = 0): BankRow => ({ id, added_week: week, content_hash: hash, archived });

  it("classifies insert, update, unarchive and unchanged", () => {
    const bankRows = [
      row("same", "2026-W43", "h-same"),
      row("edited", "2026-W43", "old-hash"),
      row("moved", "2026-W42", "h-moved"),
      row("archived", "2026-W43", "h-archived", 1),
    ];
    const items = [item("new"), item("same"), item("edited"), item("moved"), item("archived")];

    const c = classifyItems(items, bankRows);
    expect(c.insert.map((i) => i.id)).toEqual(["new"]);
    expect(c.update.map((i) => i.id)).toEqual(["edited", "moved"]);
    expect(c.unarchive.map((i) => i.id)).toEqual(["archived"]);
    expect(c.unchanged.map((i) => i.id)).toEqual(["same"]);
  });

  it("treats a week move with an unchanged hash as an update", () => {
    const c = classifyItems([item("x", "2026-W43", "same")], [row("x", "2026-W42", "same")]);
    expect(c.update).toHaveLength(1);
    expect(c.unchanged).toHaveLength(0);
  });
});

describe("overwrite and unarchive in D1", () => {
  it("inserts a new expression as active with all fields", async () => {
    const r = await syncOk(payload("week", [{ ...item("let-it-slide"), note: "informal", tags: ["work", "casual"] }]));
    expect(r.added).toBe(1);
    expect(await bank()).toEqual([
      expect.objectContaining({
        id: "let-it-slide",
        en: "let it slide",
        cue: "cue let-it-slide",
        examples: '["ex let-it-slide"]',
        note: "informal",
        tags: '["work","casual"]',
        added_week: "2026-W43",
        content_hash: "h-let-it-slide",
        archived: 0,
      }),
    ]);
  });


  it("edited cue replaces content and keeps review state", async () => {
    await syncOk(payload("week", [item("let-it-slide")]));
    await seedReviewState("let-it-slide", [1, 2]);
    const states = await cardStates("let-it-slide");

    const edited = { ...item("let-it-slide", "2026-W43", "new-hash"), cue: "new cue" };
    const r = await syncOk(payload("week", [edited]));
    expect(r.updated).toBe(1);
    const [row] = await bank();
    expect(row).toMatchObject({ cue: "new cue", content_hash: "new-hash", archived: 0 });
    expect(await cardStates("let-it-slide")).toEqual(states);
  });

  it("week move updates added_week", async () => {
    await syncOk(payload("week", [item("x", "2026-W42", "h")], "2026-W42"));
    const r = await syncOk(payload("week", [item("x", "2026-W43", "h")]));
    expect(r.updated).toBe(1);
    expect((await bank())[0].added_week).toBe("2026-W43");
  });

  it("archived expression reappears and keeps review state", async () => {
    await syncOk(payload("week", [item("a"), item("b")]));
    await seedReviewState("b", [1]);
    await syncOk(payload("week", [item("a")]));
    expect((await bank())[1]).toMatchObject({ id: "b", archived: 1 });

    const r = await syncOk(payload("week", [item("a"), item("b")]));
    expect(r).toMatchObject({ unarchived: 1, updated: 0, unchanged: 1 });
    expect((await bank())[1]).toMatchObject({ id: "b", archived: 0 });
    expect(await cardStates("b")).toEqual([{ user_id: 1, box: 3, due_at: 12345, hits: 4, misses: 1, lapses: 1 }]);
  });

  it("creates no review state during sync", async () => {
    await env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (1, 'u1', 0)").run();
    await syncOk(payload("week", [item("let-it-slide")]));
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM card_state").first<number>("n");
    expect(n).toBe(0);
  });
});

// ---------- 2.4 Archive scope ----------

describe("computeArchiveSet", () => {
  const bankRows: BankRow[] = [
    { id: "w42-a", added_week: "2026-W42", content_hash: "h", archived: 0 },
    { id: "w43-a", added_week: "2026-W43", content_hash: "h", archived: 0 },
    { id: "w43-b", added_week: "2026-W43", content_hash: "h", archived: 0 },
    { id: "w43-old", added_week: "2026-W43", content_hash: "h", archived: 1 },
  ];

  it("week mode archives only missing ids of that week", () => {
    expect(computeArchiveSet("week", "2026-W43", [item("w43-a")], bankRows)).toEqual(["w43-b"]);
  });

  it("all mode archives missing ids of every week", () => {
    expect(computeArchiveSet("all", null, [item("w43-a")], bankRows)).toEqual(["w42-a", "w43-b"]);
  });
});

describe("archiving in D1", () => {
  it("a week sync never archives another week", async () => {
    await syncOk(payload("all", [item("w42-a", "2026-W42"), item("w42-b", "2026-W42"), item("w43-a")]));
    const r = await syncOk(payload("week", [item("w43-new")]));
    expect(r.archived).toBe(1);
    const rows = await bank();
    expect(rows.filter((x) => x.archived).map((x) => x.id)).toEqual(["w43-a"]);
  });

  it("an all sync archives the expressions of a removed week", async () => {
    await syncOk(payload("all", [item("w40-a", "2026-W40"), item("w40-b", "2026-W40"), item("w43-a")]));
    await seedReviewState("w40-a", [1, 2]);
    const states = await cardStates("w40-a");

    const r = await syncOk(payload("all", [item("w43-a")]));
    expect(r.archived).toBe(2);
    const rows = await bank();
    expect(rows.filter((x) => x.archived).map((x) => x.id)).toEqual(["w40-a", "w40-b"]);
    expect(await cardStates("w40-a")).toEqual(states);
  });
});

// ---------- 2.5 Atomicity ----------

describe("atomic reconciliation", () => {
  it("rolls back every change when one statement fails", async () => {
    await syncOk(payload("week", [item("a"), item("b"), item("c")]));
    const before = await bank();

    const { db } = spyDb((d) => d.prepare("INSERT INTO no_such_table (x) VALUES (1)"));
    // insert d, update a, archive c — then the injected statement fails.
    const res = await post(payload("week", [item("a", "2026-W43", "changed"), item("b"), item("d")]), { db });
    expect(res.status).toBe(500);
    expect(await bank()).toEqual(before);
  });
});

// ---------- 2.6 Report ----------

describe("result report", () => {
  it("reports counts and total_active for a 10-expression fixture", async () => {
    const ten = [
      ...["a", "b", "c", "d", "e"].map((id) => item(`w42-${id}`, "2026-W42")),
      ...["a", "b", "c", "d", "e"].map((id) => item(`w43-${id}`, "2026-W43")),
    ];
    const first = await syncOk(payload("all", ten));
    expect(first).toEqual({ mode: "all", week: null, added: 10, updated: 0, unarchived: 0, unchanged: 0, archived: 0, total_active: 10 });

    // 3 new, 1 edited, 2 removed, 7 unchanged.
    const next = [
      ...ten.filter((i) => i.id !== "w42-a" && i.id !== "w43-a" && i.id !== "w42-b"),
      item("w42-b", "2026-W42", "edited"),
      item("w44-a", "2026-W44"),
      item("w44-b", "2026-W44"),
      item("w44-c", "2026-W44"),
    ];
    const r = await syncOk(payload("all", next));
    expect(r).toEqual({ mode: "all", week: null, added: 3, updated: 1, unarchived: 0, unchanged: 7, archived: 2, total_active: 11 });
    const active = (await bank()).filter((x) => !x.archived).length;
    expect(r.total_active).toBe(active);
  });

  it("reports the week in week mode", async () => {
    const r = await syncOk(payload("week", [item("a")]));
    expect(r).toMatchObject({ mode: "week", week: "2026-W43" });
  });
});

// ---------- 2.7 Idempotency ----------

describe("idempotency", () => {
  it("a repeated payload is all unchanged and writes nothing", async () => {
    const body = payload("all", [item("a"), item("b", "2026-W42"), item("c")]);
    await syncOk(body);
    const before = await bank();

    const { db, batches } = spyDb();
    const r = await syncOk(body, db);
    expect(r).toMatchObject({ added: 0, updated: 0, unarchived: 0, archived: 0, unchanged: 3 });
    expect(batches).toEqual([]);
    expect(await bank()).toEqual(before);
  });
});

// ---------- 3.1 Admin notification ----------

describe("admin notification", () => {
  function mockTelegram(response: () => Response | Promise<Response>) {
    // Same spy as the global stub, so drop the calls made before this point.
    return vi.spyOn(globalThis, "fetch").mockClear().mockImplementation(async () => response());
  }

  it("notifies the admin when expressions are added", async () => {
    const fetchSpy = mockTelegram(() => Response.json({ ok: true }));
    const r = await syncOk(payload("week", Array.from({ length: 12 }, (_, i) => item(`e${i}`))));
    expect(r.added).toBe(12);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`);
    const sent = JSON.parse(init.body as string);
    expect(sent.chat_id).toBe(env.ADMIN_CHAT_ID);
    expect(sent.text).toContain("Thêm mới: 12");
  });

  it("notifies the admin when expressions are archived", async () => {
    await syncOk(payload("week", [item("a"), item("b")]));
    const fetchSpy = mockTelegram(() => Response.json({ ok: true }));
    await syncOk(payload("week", [item("a")]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).text).toContain("Lưu trữ: 1");
  });

  it("stays silent when only updates or nothing changed", async () => {
    await syncOk(payload("week", [item("a")]));
    const fetchSpy = mockTelegram(() => Response.json({ ok: true }));
    await syncOk(payload("week", [item("a", "2026-W43", "edited")]));
    await syncOk(payload("week", [item("a", "2026-W43", "edited")]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP error", () => new Response("bad gateway", { status: 502 })],
    ["network error", () => Promise.reject(new Error("network down"))],
  ])("still returns 200 and keeps data on Telegram %s", async (_name, response) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = mockTelegram(response);
    const res = await post(payload("week", [item("a")]));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await bank()).toHaveLength(1);
  });
});
