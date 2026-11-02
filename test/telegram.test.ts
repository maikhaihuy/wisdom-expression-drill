import { describe, expect, it } from "vitest";
import { answerCallbackQuery, editMessageReplyMarkup, sendMessage, TelegramError, UserBlockedError } from "../src/telegram";
import { forbidden, mockTelegram } from "./helpers";

describe("telegram client", () => {
  it("sendMessage posts to the Bot API and returns the message", async () => {
    const tg = mockTelegram();
    const msg = await sendMessage("tok", 42, "<b>hi</b>", { parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
    expect(msg.message_id).toBe(500);
    expect(tg.calls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: 42, text: "<b>hi</b>", parse_mode: "HTML" } });
  });

  it("raises UserBlockedError on 403", async () => {
    mockTelegram(forbidden);
    const err = await sendMessage("tok", 42, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(UserBlockedError);
    expect(err.status).toBe(403);
  });

  it("raises a plain TelegramError on other failures", async () => {
    mockTelegram(() => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }));
    const err = await sendMessage("tok", 42, "hi").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect(err).not.toBeInstanceOf(UserBlockedError);
    expect(err.description).toContain("chat not found");
  });

  it("raises on a non-JSON error body", async () => {
    mockTelegram(() => new Response("bad gateway", { status: 502 }));
    await expect(sendMessage("tok", 42, "hi")).rejects.toBeInstanceOf(TelegramError);
  });

  it("editMessageReplyMarkup and answerCallbackQuery send the right fields", async () => {
    const tg = mockTelegram();
    await editMessageReplyMarkup("tok", 42, 7, { inline_keyboard: [[{ text: "x", callback_data: "y" }]] });
    await answerCallbackQuery("tok", "cb1", "notice");
    await answerCallbackQuery("tok", "cb2");
    expect(tg.calls.map((c) => c.method)).toEqual(["editMessageReplyMarkup", "answerCallbackQuery", "answerCallbackQuery"]);
    expect(tg.calls[0].body).toMatchObject({ chat_id: 42, message_id: 7 });
    expect(tg.calls[1].body).toEqual({ callback_query_id: "cb1", text: "notice" });
    expect(tg.calls[2].body).toEqual({ callback_query_id: "cb2" });
  });
});
