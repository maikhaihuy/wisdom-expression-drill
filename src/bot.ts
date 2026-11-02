import { handleCommand } from "./commands";
import { config } from "./config";
import { t } from "./i18n";
import type { Env } from "./index";
import { defaultDeps, handleCallback, handleGradeText, type Deps } from "./review";
import { answerCallbackQuery, sendMessage, UserBlockedError, type InlineKeyboardMarkup, type TgUpdate } from "./telegram";
import { deactivate, getUser, handleStart } from "./users";

const COMMAND_RE = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i;

export async function handleUpdate(env: Env, update: TgUpdate, now: number, deps: Deps = defaultDeps): Promise<void> {
  const fromId = update.message?.from?.id ?? update.callback_query?.from.id;
  try {
    if (update.message) await onMessage(env, update, now, deps);
    else if (update.callback_query) await onCallback(env, update, now);
  } catch (err) {
    if (err instanceof UserBlockedError && fromId) await deactivate(env.DB, fromId);
    else throw err;
  }
}

async function onMessage(env: Env, update: TgUpdate, now: number, deps: Deps): Promise<void> {
  const msg = update.message!;
  if (msg.chat.type !== "private" || !msg.from || msg.from.is_bot) return;

  const text = (msg.text ?? "").trim();
  const reply = (body: string, markup?: InlineKeyboardMarkup) =>
    sendMessage(env.TELEGRAM_BOT_TOKEN, msg.chat.id, body, { parse_mode: "HTML", reply_markup: markup });

  const command = COMMAND_RE.exec(text);
  const cmd = command?.[1].toLowerCase();
  const arg = command?.[2]?.trim() ?? "";

  if (cmd === "start") {
    const cfg = config(env);
    await reply(await handleStart(env.DB, msg.from, arg, now, { adminChatId: env.ADMIN_CHAT_ID, defaultTz: cfg.defaultTz }));
    return;
  }

  const user = await getUser(env.DB, msg.from.id);
  if (!user || !user.active) {
    await reply(t.registerFirst);
    return;
  }

  if (cmd) {
    const out = await handleCommand(env, user, cmd, arg, now, deps);
    if (out) await reply(out.text, out.reply_markup);
    return;
  }
  if (text) await reply(await handleGradeText(env, user, text, now));
}

async function onCallback(env: Env, update: TgUpdate, now: number): Promise<void> {
  const cq = update.callback_query!;
  // Inline-mode callbacks have no message; group messages are ignored like any group update.
  if (cq.message?.chat.type !== "private") return;

  const user = await getUser(env.DB, cq.from.id);
  if (!user || !user.active) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id, t.registerFirstPlain);
    return;
  }
  await handleCallback(env, user, cq, now);
}
