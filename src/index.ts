import { handleUpdate } from "./bot";
import { runSchedule } from "./review";
import { handleSync } from "./sync";
import type { TgUpdate } from "./telegram";
import { safeEqual } from "./util";

export interface Env {
  DB: D1Database;
  SYNC_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_CHAT_ID: string;
  PUBLIC_URL: string;
  DEFAULT_TZ_OFFSET_MIN?: string;
  BATCH_MIN?: string;
  BATCH_MAX?: string;
  NEW_PER_BATCH?: string;
  NEW_PER_DAY?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/admin/sync") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      return handleSync(request, env, ctx);
    }

    if (pathname === "/tg/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (!safeEqual(request.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const update = (await request.json().catch(() => null)) as TgUpdate | null;
      if (!update) return new Response("Bad Request", { status: 400 });
      // Acknowledge at once; Telegram retries slow webhooks.
      const now = Math.floor(Date.now() / 1000);
      ctx.waitUntil(handleUpdate(env, update, now).catch((err) => console.error("update failed", update.update_id, err)));
      return new Response("ok");
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runSchedule(env, Math.floor(controller.scheduledTime / 1000));
  },
} satisfies ExportedHandler<Env>;
