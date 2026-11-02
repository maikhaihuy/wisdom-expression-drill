// One-off Telegram setup, run from a developer machine after `wrangler deploy`.
//
//   TELEGRAM_BOT_TOKEN=... ADMIN_CHAT_ID=... npm run tg:commands
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WORKER_URL=https://... npm run tg:webhook
//   TELEGRAM_BOT_TOKEN=... npm run tg:info
import { ADMIN_COMMANDS, COMMANDS } from "../src/i18n.ts";

const token = process.env.TELEGRAM_BOT_TOKEN;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

async function call(method: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!data.ok) throw new Error(`${method} failed: ${data.description}`);
  return data.result;
}

const actions: Record<string, () => Promise<void>> = {
  // Members see the user commands; the admin's chat also gets /invite and /members.
  async commands() {
    const adminChatId = required("ADMIN_CHAT_ID");
    await call("setMyCommands", { commands: COMMANDS, scope: { type: "all_private_chats" } });
    await call("setMyCommands", { commands: [...COMMANDS, ...ADMIN_COMMANDS], scope: { type: "chat", chat_id: Number(adminChatId) } });
    console.log(`Registered ${COMMANDS.length} commands for private chats and ${COMMANDS.length + ADMIN_COMMANDS.length} for the admin.`);
  },

  async webhook() {
    const url = `${required("WORKER_URL").replace(/\/+$/, "")}/tg/webhook`;
    await call("setWebhook", {
      url,
      secret_token: required("TELEGRAM_WEBHOOK_SECRET"),
      allowed_updates: ["message", "callback_query"],
    });
    console.log(`Webhook set to ${url}`);
  },

  async info() {
    console.log("Webhook:", await call("getWebhookInfo"));
    console.log("Commands:", await call("getMyCommands", { scope: { type: "all_private_chats" } }));
  },
};

const action = actions[process.argv[2] ?? ""];
if (!action) {
  console.error(`Usage: telegram-setup.ts <${Object.keys(actions).join("|")}>`);
  process.exit(1);
}
required("TELEGRAM_BOT_TOKEN");
await action();
