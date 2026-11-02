# bank-sync Specification

## Purpose

Receives the expression bank produced by the vault pipeline and reconciles it with the shared bank in D1, preserving every user's review statistics.

## Requirements

### Requirement: Sync endpoint authentication
The system SHALL accept bank sync requests only on `POST /admin/sync` with the header `Authorization: Bearer <SYNC_TOKEN>`. Requests with a missing or wrong token SHALL be rejected with HTTP 401 and SHALL NOT change any data.

#### Scenario: Valid token
- **WHEN** a request arrives with the correct bearer token and a valid payload
- **THEN** the system processes the sync and responds with HTTP 200

#### Scenario: Missing or wrong token
- **WHEN** a request arrives without an Authorization header or with a different token
- **THEN** the system responds with HTTP 401 and the bank is unchanged

### Requirement: Payload validation
The system SHALL validate the payload before writing anything. `version` MUST be 3. `mode` MUST be `all` or `week`. In `week` mode, `week` MUST match `YYYY-Www` and every item's `added_week` MUST equal it. `items` MUST be non-empty. Invalid payloads SHALL get HTTP 422 with a reason.

#### Scenario: Unknown payload version
- **WHEN** the payload has `version: 2`
- **THEN** the system responds with HTTP 422 and the bank is unchanged

#### Scenario: Item outside the declared week
- **WHEN** mode is `week`, week is `2026-W43`, and one item has `added_week: 2026-W42`
- **THEN** the system responds with HTTP 422 and the bank is unchanged

#### Scenario: Empty items
- **WHEN** the payload has an empty `items` array
- **THEN** the system responds with HTTP 422 and no expression is archived

#### Scenario: Missing required item field
- **WHEN** an item has no `en`, no `cue`, no `id` or no `content_hash`
- **THEN** the system responds with HTTP 422 naming the item id or index

### Requirement: Insert new expressions
For each payload item whose `id` does not exist in the bank, the system SHALL insert it as an active expression. The system SHALL NOT create any per-user review state during sync.

#### Scenario: New expression
- **WHEN** the payload contains id `let-it-slide` and the bank has no such id
- **THEN** the bank contains `let-it-slide` with `archived = 0` and the response counts it in `added`
- **AND** no review state row exists for it for any user

### Requirement: Overwrite changed expressions
For each payload item whose `id` exists, the system SHALL overwrite the content fields, `content_hash` and `added_week`, and set it active, when the stored `content_hash` or `added_week` differs or the expression is archived. Per-user review state SHALL be preserved.

#### Scenario: Edited cue
- **WHEN** an existing expression arrives with a different `content_hash`
- **THEN** its content is replaced, it counts in `updated`, and every user's box, due time, hits and misses are unchanged

#### Scenario: Expression moved to another week
- **WHEN** an existing expression arrives with the same `content_hash` but `added_week` changed from `2026-W42` to `2026-W43`
- **THEN** its `added_week` becomes `2026-W43` and it counts in `updated`

#### Scenario: Archived expression reappears
- **WHEN** an archived expression is present in the payload
- **THEN** it becomes active again, it counts in `unarchived`, and users resume from their previous box

### Requirement: Skip unchanged expressions
The system SHALL NOT write expressions whose `content_hash` and `added_week` are unchanged and that are active.

#### Scenario: Identical item
- **WHEN** an active expression arrives with the same `content_hash` and `added_week`
- **THEN** its `updated_at` is unchanged and it counts in `unchanged`

### Requirement: Archive expressions missing from the synced scope
After applying the items, the system SHALL archive every active expression in scope whose id is not in the payload. In `all` mode the scope is the whole bank. In `week` mode the scope is expressions whose stored `added_week` equals `week`. Archiving SHALL NOT delete rows or review state.

#### Scenario: Week sync leaves other weeks untouched
- **WHEN** mode is `week` for `2026-W43`
- **THEN** no expression with another `added_week` is archived

#### Scenario: Bullet deleted from a week file
- **WHEN** `let-it-slide` (week `2026-W43`) is active and a `2026-W43` week sync does not contain it
- **THEN** `let-it-slide` is archived and counts in `archived`

#### Scenario: Week file deleted
- **WHEN** an `all` sync contains no item from week `2026-W40`
- **THEN** every active expression of week `2026-W40` is archived

#### Scenario: Archived expression keeps statistics
- **WHEN** an expression with review state for two users is archived
- **THEN** both users' review state rows still exist unchanged

### Requirement: Atomic reconciliation
The system SHALL apply all inserts, updates and archives of one sync as a single transaction. If any statement fails, no change from that sync SHALL be persisted and the response SHALL be HTTP 500.

#### Scenario: Failure midway
- **WHEN** a database error occurs while applying a sync
- **THEN** the bank is identical to its state before the request and the response is HTTP 500

### Requirement: Sync result report
On success the system SHALL respond with JSON containing `mode`, `week` (or null), `added`, `updated`, `unarchived`, `unchanged`, `archived` and `total_active`.

#### Scenario: Report counts
- **WHEN** a sync inserts 3, updates 1 and archives 2 expressions
- **THEN** the response body has `added: 3`, `updated: 1`, `archived: 2` and `total_active` equals the active bank size after the sync

### Requirement: Admin notification
When a successful sync has `added > 0` or `archived > 0`, the system SHALL send the admin a Telegram message with those counts. A failure to send SHALL NOT fail the sync.

#### Scenario: New expressions announced
- **WHEN** a sync adds 12 expressions
- **THEN** the admin receives a message stating that 12 expressions were added

#### Scenario: Telegram unavailable
- **WHEN** the notification request to Telegram fails
- **THEN** the sync response is still HTTP 200 and the data changes are kept
