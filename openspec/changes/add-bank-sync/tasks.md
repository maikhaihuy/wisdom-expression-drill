# Tasks

## 1. Scaffolding

- [ ] 1.1 Create the Worker project (TypeScript, `wrangler.toml` as in design.md, `src/index.ts` router returning 404 for unknown routes) and verify `wrangler dev` starts and `GET /` returns 404
- [ ] 1.2 Add vitest with `@cloudflare/vitest-pool-workers` and a D1 test binding, and verify `npm test` runs an empty suite
- [ ] 1.3 Add `migrations/0001_init.sql` from design.md and verify `wrangler d1 migrations apply expression-drill --local` succeeds and creates all 6 tables

## 2. Sync endpoint

- [ ] 2.1 Implement bearer-token authentication on `POST /admin/sync` and verify tests for valid, missing and wrong tokens (401, no data change)
- [ ] 2.2 Implement payload validation (version, mode, week format, `added_week` consistency, required fields, non-empty items) and verify one test per invalid case returns 422 with an unchanged bank
- [ ] 2.3 Implement item classification (insert / update / unarchive / unchanged) as a pure function and verify unit tests cover each class, including a week move with an unchanged hash
- [ ] 2.4 Implement archive-scope computation for `all` and `week` modes and verify a `week` sync never archives another week, while an `all` sync archives the expressions of a removed week
- [ ] 2.5 Apply all statements in one `DB.batch` and verify, with a forced failing statement, that the bank is unchanged and the response is 500
- [ ] 2.6 Return the result report and verify the counts and `total_active` against a fixture of 10 expressions
- [ ] 2.7 Verify idempotency: sending the same payload twice yields `unchanged = items.length` and zero writes on the second call

## 3. Admin notification

- [ ] 3.1 Implement `telegram.sendMessage` and the post-commit notification in `ctx.waitUntil`, and verify with a mocked fetch that a message is sent only when `added > 0` or `archived > 0`, and that a failed send still returns 200

## 4. Deploy

- [ ] 4.1 Document setup (D1 create, migrations, secrets, deploy) in README.md and verify a remote deploy answers 401 to an unauthenticated `curl -X POST https://<worker>/admin/sync`
- [ ] 4.2 Run the vault workflow in `all` mode and verify the response counts match the number of expressions in the vault

## Workflow follow-up

- Archive the change with `openspec archive add-bank-sync` after the first real sync succeeds.
