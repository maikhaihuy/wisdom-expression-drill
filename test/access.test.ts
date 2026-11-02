import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { t } from "../src/i18n";
import worker from "../src/index";
import { INVITE_TTL_SEC } from "../src/users";
import {
  addExpressions,
  addSession,
  addUser,
  allStates,
  callback,
  count,
  DAY,
  getSessionRow,
  itemResults,
  mockTelegram,
  msg,
  send,
  setState,
  T0,
} from "./helpers";

async function postWebhook(body: unknown, secret: string | null) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://worker.test/tg/webhook", { method: "POST", headers, body: JSON.stringify(body) }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ---------- 1.2 Webhook ----------

describe("webhook authenticity", () => {
  it.each([
    ["missing secret", null],
    ["wrong secret", "nope"],
  ])("%s → 401 and no message", async (_name, secret) => {
    const tg = mockTelegram();
    const res = await postWebhook(msg(5, "/start"), secret);
    expect(res.status).toBe(401);
    expect(tg.calls).toHaveLength(0);
  });

  it("genuine update → 200 and handled", async () => {
    const tg = mockTelegram();
    const res = await postWebhook(msg(5, "hello"), env.TELEGRAM_WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    expect(tg.lastText()).toBe(t.registerFirst);
  });

  it("rejects non-POST", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("https://worker.test/tg/webhook"), env, ctx);
    expect(res.status).toBe(405);
  });
});

describe("private chats only", () => {
  it("ignores /next in a group from a registered user", async () => {
    await addUser(5);
    await addExpressions(["a", "b"]);
    const tg = mockTelegram();
    const res = await postWebhook(msg(5, "/next", { chatType: "group" }), env.TELEGRAM_WEBHOOK_SECRET);
    expect(res.status).toBe(200);
    expect(tg.calls).toHaveLength(0);
    expect(await count("sessions")).toBe(0);
  });

  it("ignores callbacks from group messages", async () => {
    await addUser(5);
    await addExpressions(["a"]);
    await addSession("b-5-1", 5, ["a"]);
    const tg = mockTelegram();
    await send(callback(5, "c:b-5-1", { chatType: "group" }));
    expect(tg.calls).toHaveLength(0);
    expect((await getSessionRow("b-5-1"))!.closed_at).toBeNull();
  });
});

// ---------- 1.3 Access ----------

describe("admin bootstrap", () => {
  it("creates the first admin from ADMIN_CHAT_ID", async () => {
    const tg = mockTelegram();
    await send(msg(1000, "/start", { firstName: "Huy" }));
    const admin = await env.DB.prepare("SELECT * FROM users WHERE id = 1000").first();
    expect(admin).toMatchObject({ role: "admin", name: "Huy", active: 1, tz_offset_min: 420 });
    expect(tg.lastText()).toBe(t.welcomeAdmin("Huy"));
  });

  it("requires an invite code once an admin exists", async () => {
    await addUser(1000, { role: "admin" });
    const tg = mockTelegram();
    await send(msg(7, "/start"));
    expect(await count("users")).toBe(1);
    expect(tg.lastText()).toBe(t.inviteRequired);
  });

  it("never makes a second admin from ADMIN_CHAT_ID", async () => {
    await addUser(1, { role: "admin" });
    mockTelegram();
    await send(msg(1000, "/start"));
    expect(await count("users", "role = 'admin'")).toBe(1);
    expect(await count("users", "id = 1000")).toBe(0);
  });
});

describe("invite codes", () => {
  it("admin creates an 8-character code that expires in 7 days", async () => {
    await addUser(1000, { role: "admin" });
    const tg = mockTelegram();
    await send(msg(1000, "/invite"));
    const invite = await env.DB.prepare("SELECT * FROM invites").first<{ code: string; created_by: number; expires_at: number; used_by: number | null }>();
    expect(invite!.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
    expect(invite).toMatchObject({ created_by: 1000, expires_at: T0 + INVITE_TTL_SEC, used_by: null });
    expect(tg.lastText()).toContain(`/start ${invite!.code}`);
  });

  it("member is refused", async () => {
    await addUser(5);
    const tg = mockTelegram();
    await send(msg(5, "/invite"));
    expect(await count("invites")).toBe(0);
    expect(tg.lastText()).toBe(t.adminOnly);
  });
});

describe("registration with invite code", () => {
  async function seedInvite(code: string, fields: { used_by?: number; expires_at?: number } = {}) {
    await addUser(1000, { role: "admin" });
    if (fields.used_by) await addUser(fields.used_by);
    await env.DB.prepare("INSERT INTO invites (code, created_by, used_by, expires_at) VALUES (?, 1000, ?, ?)")
      .bind(code, fields.used_by ?? null, fields.expires_at ?? T0 + DAY)
      .run();
  }

  it("valid code registers an active member and marks the code used", async () => {
    await seedInvite("K7PX2MQA");
    const tg = mockTelegram();
    await send(msg(7, "/start k7px2mqa", { firstName: "Lan" }));
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = 7").first();
    expect(user).toMatchObject({ role: "member", active: 1, name: "Lan", tz_offset_min: 420 });
    const invite = await env.DB.prepare("SELECT used_by, used_at FROM invites WHERE code = 'K7PX2MQA'").first();
    expect(invite).toEqual({ used_by: 7, used_at: T0 });
    expect(tg.lastText()).toBe(t.welcomeMember("Lan"));
  });

  it.each([
    ["used", { used_by: 8 }],
    ["expired", { expires_at: T0 - 1 }],
  ])("%s code is rejected", async (_name, fields) => {
    await seedInvite("K7PX2MQA", fields);
    const tg = mockTelegram();
    await send(msg(7, "/start K7PX2MQA"));
    expect(await count("users", "id = 7")).toBe(0);
    expect(tg.lastText()).toBe(t.invalidCode);
  });

  it("unknown code is rejected", async () => {
    await seedInvite("K7PX2MQA");
    const tg = mockTelegram();
    await send(msg(7, "/start ZZZZZZZZ"));
    expect(await count("users", "id = 7")).toBe(0);
    expect(await count("invites", "used_by IS NULL")).toBe(1);
    expect(tg.lastText()).toBe(t.invalidCode);
  });

  it("a code works only once", async () => {
    await seedInvite("K7PX2MQA");
    mockTelegram();
    await send(msg(7, "/start K7PX2MQA"));
    await send(msg(8, "/start K7PX2MQA"));
    expect(await count("users", "id = 8")).toBe(0);
  });
});

describe("unregistered and inactive users", () => {
  it("stranger gets registration instructions and nothing is stored", async () => {
    const tg = mockTelegram();
    await send(msg(9, "hello"));
    expect(tg.lastText()).toBe(t.registerFirst);
    expect(await count("users")).toBe(0);
  });

  it("inactive user is treated as unregistered", async () => {
    await addUser(5, { active: 0 });
    await addExpressions(["a"]);
    const tg = mockTelegram();
    await send(msg(5, "/next"));
    expect(tg.lastText()).toBe(t.registerFirst);
    expect(await count("sessions")).toBe(0);
  });

  it("returning user is reactivated with review state intact", async () => {
    await addUser(5, { active: 0, name: "Lan" });
    await addExpressions(["a", "b"]);
    await setState(5, "a", { box: 4, hits: 9, misses: 2 });
    await setState(5, "b", { box: 2, hits: 1 });
    const before = await allStates(5);

    const tg = mockTelegram();
    await send(msg(5, "/start"));
    expect(await count("users", "id = 5 AND active = 1")).toBe(1);
    expect(await allStates(5)).toEqual(before);
    expect(tg.lastText()).toBe(t.welcomeBack("Lan"));
  });

  it("callback from an unregistered user gets a notice", async () => {
    const tg = mockTelegram();
    await send(callback(9, "c:b-5-1"));
    expect(tg.answers()[0].body.text).toBe(t.registerFirstPlain);
  });
});

// ---------- 1.4 Isolation ----------

describe("per-user isolation", () => {
  it.each([
    ["toggle", "t:b-6-1:1"],
    ["commit", "c:b-6-1"],
    ["all correct", "a:b-6-1"],
  ])("user A cannot %s user B's batch", async (_name, data) => {
    await addUser(5);
    await addUser(6);
    await addExpressions(["a", "b"]);
    await addSession("b-6-1", 6, ["a", "b"], { results: ["hit", null] });

    const tg = mockTelegram();
    await send(callback(5, data));
    expect(tg.answers()[0].body.text).toBe(t.notYourBatch);
    expect(tg.edits()).toHaveLength(0);
    expect((await getSessionRow("b-6-1"))!.closed_at).toBeNull();
    expect((await itemResults("b-6-1")).map((r) => r.result)).toEqual(["hit", null]);
    expect(await count("card_state")).toBe(0);
  });

  it("text grading only touches the sender's own batch", async () => {
    await addUser(5);
    await addUser(6);
    await addExpressions(["a", "b"]);
    await addSession("b-6-1", 6, ["a", "b"]);

    const tg = mockTelegram();
    await send(msg(5, "ok"));
    expect(tg.lastText()).toBe(t.noOpenBatch);
    expect((await getSessionRow("b-6-1"))!.closed_at).toBeNull();
  });
});
