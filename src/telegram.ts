// Minimal Telegram Bot API client.

export interface TgUser {
  id: number;
  first_name: string;
  is_bot?: boolean;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_markup?: InlineKeyboardMarkup;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    readonly description: string,
  ) {
    super(`Telegram API error ${status}: ${description}`);
  }
}

// Telegram answers 403 when the user blocked the bot or deleted their account.
export class UserBlockedError extends TelegramError {}

async function call<T>(token: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  const description = data?.description ?? res.statusText;
  if (res.status === 403) throw new UserBlockedError(res.status, description);
  if (!res.ok || !data?.ok) throw new TelegramError(res.status, description);
  return data.result as T;
}

export interface SendOptions {
  parse_mode?: "HTML";
  reply_markup?: InlineKeyboardMarkup;
}

export function sendMessage(token: string, chatId: string | number, text: string, opts: SendOptions = {}): Promise<TgMessage> {
  return call(token, "sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...opts });
}

export function editMessageReplyMarkup(
  token: string,
  chatId: string | number,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup,
): Promise<unknown> {
  return call(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
}

export function answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<unknown> {
  return call(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}
