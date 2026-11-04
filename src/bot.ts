import { handleCommand } from "./commands";
import { config } from "./config";
import { t } from "./i18n";
import type { Env } from "./index";
import { defaultDeps, handleCommit, handleGradeText, handleToggle, type Deps } from "./review";
import { callbackAnswer, sendMessage, UserBlockedError, type CallbackAnswer, type InlineKeyboardMarkup, type TgUpdate } from "./telegram";
import { deactivate, getUser, handleStart } from "./users";

const COMMAND_RE = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i;

// For a callback query, returns the answer to send as the webhook response (null when the
// update is ignored). Messages are answered with their own sendMessage calls.
export async function handleUpdate(
  env: Env,
  update: TgUpdate,
  now: number,
  ctx: ExecutionContext,
  deps: Deps = defaultDeps,
): Promise<CallbackAnswer | null> {
  const fromId = update.message?.from?.id ?? update.callback_query?.from.id;
  try {
    if (update.message) await onMessage(env, update, now, deps);
    else if (update.callback_query) return await onCallback(env, update, now, ctx);
  } catch (err) {
    if (err instanceof UserBlockedError && fromId) await deactivate(env.DB, fromId);
    else throw err;
  }
  return null;
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

async function onCallback(env: Env, update: TgUpdate, now: number, ctx: ExecutionContext): Promise<CallbackAnswer | null> {
  const cq = update.callback_query!;
  // Inline-mode callbacks have no message; group messages are ignored like any group update.
  if (cq.message?.chat.type !== "private") return null;

  // Item toggles skip even the user lookup: zero D1 queries per tap.
  if (cq.data?.startsWith("t:")) return callbackAnswer(cq.id, handleToggle(env, cq, ctx));

  const user = await getUser(env.DB, cq.from.id);
  if (!user || !user.active) return callbackAnswer(cq.id, t.registerFirstPlain);
  return callbackAnswer(cq.id, await handleCommit(env, user, cq, now, ctx));
}
