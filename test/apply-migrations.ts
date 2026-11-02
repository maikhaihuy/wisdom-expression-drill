import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(async () => {
  // Storage is shared across tests, so every test starts from an empty, migrated database.
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // No test may reach the real Telegram API. Tests that inspect calls install their own mock.
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, result: { message_id: 1 } }));
});

afterEach(() => vi.restoreAllMocks());
