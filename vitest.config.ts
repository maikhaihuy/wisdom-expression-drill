import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SYNC_TOKEN: "test-sync-token",
            TELEGRAM_BOT_TOKEN: "test-bot-token",
            TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
            ADMIN_CHAT_ID: "1000",
            PUBLIC_URL: "https://drill.test",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
