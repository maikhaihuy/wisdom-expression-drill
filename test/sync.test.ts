import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BankRow } from "../src/db";
import worker from "../src/index";
import { classifyItems, computeArchiveSet, type SyncItem, type SyncReport } from "../src/sync";

// ---------- Helpers ----------

function item(id: string, unit = 3, hash = `h-${id}`, position = 1): SyncItem {
  return { id, en: id.replaceAll("-", " "), cue: `cue ${id}`, examples: [`ex ${id}`], note: null, tags: [], unit, position, content_hash: hash };
}

function payload(mode: "all" | "unit", items: unknown[], unit: number | null = mode === "unit" ? 3 : null) {
  return { version: 4, mode, unit, generated_at: "2026-11-04T07:00:00Z", items, warnings: [] };
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

// ---------- Authentication ----------

describe("authentication", () => {
  it("accepts the correct bearer token", async () => {
    const res = await post(payload("unit", [item("let-it-slide")]));
    expect(res.status).toBe(200);
    expect(await bank()).toHaveLength(1);
  });

  it.each([
    ["missing header", null],
    ["wrong token", "Bearer nope"],
    ["token without Bearer", "test-sync-token"],
  ])("rejects %s with 401 and changes nothing", async (_name, auth) => {
    const res = await post(payload("unit", [item("let-it-slide")]), { auth });
    expect(res.status).toBe(401);
    expect(await bank()).toHaveLength(0);
  });

  it("only accepts POST", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://worker.test/admin/sync"), env, ctx);
    expect(res.status).toBe(405);
  });
});

// ---------- Payload version 4 validation ----------

describe("payload validation", () => {
  const { content_hash: _h, ...noHash } = item("a");
  const { en: _e, ...noEn } = item("a");
  const { cue: _c, ...noCue } = item("a");
  const { id: _i, ...noId } = item("a");
  const { position: _p, ...noPosition } = item("a");
  const { unit: _u, ...noUnit } = item("a");

  it.each([
    ["invalid JSON", "{not json", /invalid JSON/],
    ["old payload version 3", { ...payload("unit", [item("a")]), version: 3 }, /^unsupported payload version 3, expected 4$/],
    ["unknown mode", { ...payload("unit", [item("a")]), mode: "week" }, /mode/],
    ["unit 0", payload("unit", [item("a", 0)], 0), /invalid unit: 0/],
    ["non-integer unit", payload("unit", [item("a")], 2.5 as unknown as number), /invalid unit/],
    ["missing unit in unit mode", payload("unit", [item("a")], null), /invalid unit/],
    ["unit set in all mode", payload("all", [item("a")], 3), /unit must be omitted/],
    ["item outside the declared unit", payload("unit", [item("a", 3), item("b", 2)]), /item 1 \(b\): unit 2 is outside unit 3/],
    ["empty item list", payload("unit", []), /non-empty/],
    ["missing en", payload("unit", [noEn]), /item 0 \(a\): missing en/],
    ["missing cue", payload("unit", [noCue]), /item 0 \(a\): missing cue/],
    ["missing id", payload("unit", [item("x"), noId]), /item 1: missing id/],
    ["missing content_hash", payload("unit", [noHash]), /item 0 \(a\): missing content_hash/],
    ["position 0", payload("unit", [item("a", 3, "h", 0)]), /item 0 \(a\): invalid position 0/],
    ["missing position", payload("unit", [noPosition]), /item 0 \(a\): invalid position/],
    ["missing item unit", payload("all", [noUnit]), /item 0 \(a\): invalid unit/],
    ["string position", payload("unit", [{ ...item("a"), position: "2" }]), /invalid position "2"/],
    ["duplicate id", payload("unit", [item("a"), item("a")]), /duplicate id/],
  ])("%s → 422 with unchanged bank", async (_name, body, reason) => {
    await syncOk(payload("all", [item("keep", 3)]));
    const before = await bank();

    const res = await post(body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(reason);
    expect(await bank()).toEqual(before);
  });

  it("an empty unit sync archives nothing", async () => {
    await syncOk(payload("unit", [item("a"), item("b")]));
    expect((await post(payload("unit", []))).status).toBe(422);
    expect((await bank()).every((r) => r.archived === 0)).toBe(true);
  });
});

// ---------- Classification ----------

describe("classifyItems", () => {
  const row = (id: string, unit: number, position: number, hash: string, archived = 0): BankRow => ({ id, unit, position, content_hash: hash, archived });

  it("classifies insert, update, unarchive and unchanged", () => {
    const bankRows = [
      row("same", 3, 1, "h-same"),
      row("edited", 3, 1, "old-hash"),
      row("moved", 2, 1, "h-moved"),
      row("reordered", 3, 5, "h-reordered"),
      row("archived", 3, 1, "h-archived", 1),
    ];
    const items = [item("new"), item("same"), item("edited"), item("moved"), item("reordered"), item("archived")];

    const c = classifyItems(items, bankRows);
    expect(c.insert.map((i) => i.id)).toEqual(["new"]);
    expect(c.update.map((i) => i.id)).toEqual(["edited", "moved", "reordered"]);
    expect(c.unarchive.map((i) => i.id)).toEqual(["archived"]);
    expect(c.unchanged.map((i) => i.id)).toEqual(["same"]);
  });

  it("a move to another unit with an unchanged hash is an update", () => {
    const c = classifyItems([item("x", 3, "same", 4)], [row("x", 2, 4, "same")]);
    expect(c.update).toHaveLength(1);
  });

  it("a reorder inside a unit with an unchanged hash is an update", () => {
    const c = classifyItems([item("x", 3, "same", 2)], [row("x", 3, 5, "same")]);
    expect(c.update).toHaveLength(1);
  });

  it("an identical item is unchanged", () => {
    const c = classifyItems([item("x", 3, "same", 2)], [row("x", 3, 2, "same")]);
    expect(c.unchanged).toHaveLength(1);
  });
});

describe("overwrite and unarchive in D1", () => {
  it("inserts a new expression as active with all fields", async () => {
    const r = await syncOk(payload("unit", [{ ...item("let-it-slide", 3, "h-let-it-slide", 7), note: "informal", tags: ["work", "casual"] }]));
    expect(r.added).toBe(1);
    expect(await bank()).toEqual([
      expect.objectContaining({
        id: "let-it-slide",
        en: "let it slide",
        cue: "cue let-it-slide",
        examples: '["ex let-it-slide"]',
        note: "informal",
        tags: '["work","casual"]',
        unit: 3,
        position: 7,
        content_hash: "h-let-it-slide",
        archived: 0,
      }),
    ]);
  });

  it("edited content replaces the row and keeps review state", async () => {
    await syncOk(payload("unit", [item("let-it-slide")]));
    await seedReviewState("let-it-slide", [1, 2]);
    const states = await cardStates("let-it-slide");

    const edited = { ...item("let-it-slide", 3, "new-hash"), cue: "new cue" };
    const r = await syncOk(payload("unit", [edited]));
    expect(r.updated).toBe(1);
    const [row] = await bank();
    expect(row).toMatchObject({ cue: "new cue", content_hash: "new-hash", archived: 0 });
    expect(await cardStates("let-it-slide")).toEqual(states);
  });

  it("a move from unit 2 to unit 3 updates unit and keeps review state", async () => {
    await syncOk(payload("unit", [item("x", 2, "h")], 2));
    await seedReviewState("x", [1]);
    const states = await cardStates("x");
    const r = await syncOk(payload("all", [item("x", 3, "h")]));
    expect(r).toMatchObject({ updated: 1, added: 0, archived: 0 });
    expect((await bank())[0]).toMatchObject({ unit: 3 });
    expect(await cardStates("x")).toEqual(states);
  });

  it("a reorder inside a unit updates position", async () => {
    await syncOk(payload("unit", [item("x", 3, "h", 5)]));
    const r = await syncOk(payload("unit", [item("x", 3, "h", 2)]));
    expect(r.updated).toBe(1);
    expect((await bank())[0]).toMatchObject({ unit: 3, position: 2 });
  });

  it("archived expression returns and keeps review state", async () => {
    await syncOk(payload("unit", [item("a"), item("b")]));
    await seedReviewState("b", [1]);
    await syncOk(payload("unit", [item("a")]));
    expect((await bank())[1]).toMatchObject({ id: "b", archived: 1 });

    const r = await syncOk(payload("unit", [item("a"), item("b")]));
    expect(r).toMatchObject({ unarchived: 1, updated: 0, unchanged: 1 });
    expect((await bank())[1]).toMatchObject({ id: "b", archived: 0 });
    expect(await cardStates("b")).toEqual([{ user_id: 1, box: 3, due_at: 12345, hits: 4, misses: 1, lapses: 1 }]);
  });

  it("an identical item keeps updated_at", async () => {
    await syncOk(payload("unit", [item("a", 3, "h", 2)]));
    await env.DB.prepare("UPDATE expressions SET updated_at = 1").run();
    const r = await syncOk(payload("unit", [item("a", 3, "h", 2)]));
    expect(r.unchanged).toBe(1);
    expect((await bank())[0].updated_at).toBe(1);
  });

  it("creates no review state during sync", async () => {
    await env.DB.prepare("INSERT INTO users (id, name, created_at) VALUES (1, 'u1', 0)").run();
    await syncOk(payload("unit", [item("let-it-slide")]));
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM card_state").first<number>("n");
    expect(n).toBe(0);
  });

  it("rows migrated with unit 0 are filled in by the first all sync", async () => {
    // What 0002_unit.sql leaves behind: unit = 0, position = 0.
    await env.DB.prepare(
      "INSERT INTO expressions (id, en, cue, examples, tags, content_hash, archived, created_at, updated_at) VALUES ('a', 'a', 'a', '[]', '[]', 'h-a', 0, 0, 0)",
    ).run();
    expect((await bank())[0]).toMatchObject({ unit: 0, position: 0 });
    const r = await syncOk(payload("all", [item("a", 1, "h-a", 4)]));
    expect(r).toMatchObject({ updated: 1, added: 0, archived: 0 });
    expect((await bank())[0]).toMatchObject({ unit: 1, position: 4 });
  });
});

// ---------- Archive scope ----------

describe("computeArchiveSet", () => {
  const bankRows: BankRow[] = [
    { id: "u2-a", unit: 2, position: 1, content_hash: "h", archived: 0 },
    { id: "u3-a", unit: 3, position: 1, content_hash: "h", archived: 0 },
    { id: "u3-b", unit: 3, position: 2, content_hash: "h", archived: 0 },
    { id: "u3-old", unit: 3, position: 3, content_hash: "h", archived: 1 },
  ];

  it("unit mode archives only missing ids of that unit", () => {
    expect(computeArchiveSet("unit", 3, [item("u3-a")], bankRows)).toEqual(["u3-b"]);
  });

  it("all mode archives missing ids of every unit", () => {
    expect(computeArchiveSet("all", null, [item("u3-a")], bankRows)).toEqual(["u2-a", "u3-b"]);
  });
});

describe("archiving in D1", () => {
  it("a unit sync leaves other units untouched", async () => {
    await syncOk(payload("all", [item("u2-a", 2), item("u2-b", 2), item("u3-a", 3)]));
    const r = await syncOk(payload("unit", [item("u3-new", 3)]));
    expect(r.archived).toBe(1);
    const rows = await bank();
    expect(rows.filter((x) => x.archived).map((x) => x.id)).toEqual(["u3-a"]);
  });

  it("a bullet deleted from a unit file is archived", async () => {
    await syncOk(payload("unit", [item("let-it-slide", 3), item("call-it-a-day", 3, "h", 2)]));
    const r = await syncOk(payload("unit", [item("call-it-a-day", 3, "h", 2)]));
    expect(r.archived).toBe(1);
    expect((await bank()).find((x) => x.id === "let-it-slide")).toMatchObject({ archived: 1 });
  });

  it("an all sync archives every expression of a deleted unit and keeps statistics", async () => {
    await syncOk(payload("all", [item("u7-a", 7), item("u7-b", 7), item("u3-a", 3)]));
    await seedReviewState("u7-a", [1, 2]);
    const states = await cardStates("u7-a");

    const r = await syncOk(payload("all", [item("u3-a", 3)]));
    expect(r.archived).toBe(2);
    const rows = await bank();
    expect(rows.filter((x) => x.archived).map((x) => x.id)).toEqual(["u7-a", "u7-b"]);
    expect(await cardStates("u7-a")).toEqual(states);
  });
});

// ---------- Atomicity ----------

describe("atomic reconciliation", () => {
  it("rolls back every change when one statement fails", async () => {
    await syncOk(payload("unit", [item("a"), item("b"), item("c")]));
    const before = await bank();

    const { db } = spyDb((d) => d.prepare("INSERT INTO no_such_table (x) VALUES (1)"));
    // insert d, update a, archive c — then the injected statement fails.
    const res = await post(payload("unit", [item("a", 3, "changed"), item("b"), item("d")]), { db });
    expect(res.status).toBe(500);
    expect(await bank()).toEqual(before);
  });
});

// ---------- Report ----------

describe("result report", () => {
  it("reports counts and total_active for a 10-expression fixture", async () => {
    const ten = [
      ...["a", "b", "c", "d", "e"].map((id, i) => item(`u2-${id}`, 2, `h-u2-${id}`, i + 1)),
      ...["a", "b", "c", "d", "e"].map((id, i) => item(`u3-${id}`, 3, `h-u3-${id}`, i + 1)),
    ];
    const first = await syncOk(payload("all", ten));
    expect(first).toEqual({ mode: "all", unit: null, added: 10, updated: 0, unarchived: 0, unchanged: 0, archived: 0, total_active: 10 });

    // 3 new, 1 edited, 2 removed, 7 unchanged.
    const next = [
      ...ten.filter((i) => i.id !== "u2-a" && i.id !== "u3-a" && i.id !== "u2-b"),
      item("u2-b", 2, "edited", 2),
      item("u4-a", 4, "h", 1),
      item("u4-b", 4, "h", 2),
      item("u4-c", 4, "h", 3),
    ];
    const r = await syncOk(payload("all", next));
    expect(r).toEqual({ mode: "all", unit: null, added: 3, updated: 1, unarchived: 0, unchanged: 7, archived: 2, total_active: 11 });
    const active = (await bank()).filter((x) => !x.archived).length;
    expect(r.total_active).toBe(active);
  });

  it("echoes the unit in unit mode", async () => {
    const r = await syncOk(payload("unit", [item("a")]));
    expect(r).toMatchObject({ mode: "unit", unit: 3 });
    expect(r).not.toHaveProperty("week");
  });
});

// ---------- Idempotency ----------

describe("idempotency", () => {
  it("a repeated payload is all unchanged and writes nothing", async () => {
    const body = payload("all", [item("a"), item("b", 2), item("c", 3, "h-c", 2)]);
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
    const r = await syncOk(payload("unit", Array.from({ length: 12 }, (_, i) => item(`e${i}`))));
    expect(r.added).toBe(12);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`);
    const sent = JSON.parse(init.body as string);
    expect(sent.chat_id).toBe(env.ADMIN_CHAT_ID);
    expect(sent.text).toContain("Thêm mới: 12");
  });

  it("notifies the admin when expressions are archived", async () => {
    await syncOk(payload("unit", [item("a"), item("b")]));
    const fetchSpy = mockTelegram(() => Response.json({ ok: true }));
    await syncOk(payload("unit", [item("a")]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).text).toContain("Lưu trữ: 1");
  });

  it("stays silent when only updates or nothing changed", async () => {
    await syncOk(payload("unit", [item("a")]));
    const fetchSpy = mockTelegram(() => Response.json({ ok: true }));
    await syncOk(payload("unit", [item("a", 3, "edited")]));
    await syncOk(payload("unit", [item("a", 3, "edited")]));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["HTTP error", () => new Response("bad gateway", { status: 502 })],
    ["network error", () => Promise.reject(new Error("network down"))],
  ])("still returns 200 and keeps data on Telegram %s", async (_name, response) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = mockTelegram(response);
    const res = await post(payload("unit", [item("a")]));
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await bank()).toHaveLength(1);
  });
});
