import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authenticate, verifyInitData } from "../src/initdata";
import { addUser, T0 } from "./helpers";
import { signedInitData } from "./initdata-fixture";

const TOKEN = env.TELEGRAM_BOT_TOKEN;

describe("verifyInitData", () => {
  it("accepts a correctly signed init data string", async () => {
    const initData = await signedInitData({ id: 5, first_name: "Lan" }, T0 - 60, TOKEN);
    expect(initData).toContain("query_id=");
    expect(initData).toContain("%22id%22%3A5");
    expect(await verifyInitData(initData, TOKEN, T0)).toEqual({ user: expect.objectContaining({ id: 5, first_name: "Lan" }), auth_date: T0 - 60 });
  });

  it("rejects a modified user field with the original hash", async () => {
    const initData = await signedInitData({ id: 5, first_name: "Lan" }, T0, TOKEN);
    const params = new URLSearchParams(initData);
    params.set("user", JSON.stringify({ id: 6, first_name: "Lan" }));
    expect(await verifyInitData(params.toString(), TOKEN, T0)).toBeNull();
  });

  it("rejects data signed with another bot token", async () => {
    const initData = await signedInitData({ id: 5 }, T0, "999:other-token");
    expect(await verifyInitData(initData, TOKEN, T0)).toBeNull();
  });

  it("rejects stale init data (25 hours old)", async () => {
    const initData = await signedInitData({ id: 5 }, T0 - 25 * 3600, TOKEN);
    expect(await verifyInitData(initData, TOKEN, T0)).toBeNull();
  });

  it("accepts init data just under 24 hours old", async () => {
    const initData = await signedInitData({ id: 5 }, T0 - 24 * 3600, TOKEN);
    expect(await verifyInitData(initData, TOKEN, T0)).not.toBeNull();
  });

  it("rejects auth_date far in the future", async () => {
    const initData = await signedInitData({ id: 5 }, T0 + 3600, TOKEN);
    expect(await verifyInitData(initData, TOKEN, T0)).toBeNull();
  });

  it.each(["", "garbage", "auth_date=1&user=%7B%7D"])("rejects malformed input %j", async (initData) => {
    expect(await verifyInitData(initData, TOKEN, T0)).toBeNull();
  });
});

describe("authenticate", () => {
  it("returns the registered, active user", async () => {
    await addUser(5);
    const res = await authenticate(env.DB, TOKEN, await signedInitData({ id: 5 }, T0, TOKEN), T0);
    expect(res).toMatchObject({ ok: true, user: { id: 5 } });
  });

  it("rejects an unregistered Telegram user", async () => {
    const res = await authenticate(env.DB, TOKEN, await signedInitData({ id: 5 }, T0, TOKEN), T0);
    expect(res).toEqual({ ok: false, error: "unregistered" });
  });

  it("rejects an inactive user", async () => {
    await addUser(5, { active: 0 });
    const res = await authenticate(env.DB, TOKEN, await signedInitData({ id: 5 }, T0, TOKEN), T0);
    expect(res).toEqual({ ok: false, error: "unregistered" });
  });

  it("rejects a missing header", async () => {
    expect(await authenticate(env.DB, TOKEN, null, T0)).toEqual({ ok: false, error: "invalid_init_data" });
  });
});
