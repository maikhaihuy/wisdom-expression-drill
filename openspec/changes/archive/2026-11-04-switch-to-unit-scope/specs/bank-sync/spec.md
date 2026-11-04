# Spec Delta

## REMOVED Requirements

### Requirement: Payload validation
**Reason**: Payload version 4 replaces `week` with `unit`.
**Migration**: See "Payload version 4 validation".

### Requirement: Overwrite changed expressions
**Reason**: `added_week` is replaced by `unit` and `position`.
**Migration**: See "Overwrite changed or moved expressions".

### Requirement: Archive expressions missing from the synced scope
**Reason**: The scope of a partial sync is now a unit, not a week.
**Migration**: See "Archive expressions missing from the synced unit scope".

## ADDED Requirements

### Requirement: Payload version 4 validation
The system SHALL validate the payload before writing anything. `version` MUST be 4. `mode` MUST be `all` or `unit`. In `unit` mode, `unit` MUST be a positive integer and every item's `unit` MUST equal it. Every item MUST have `id`, `en`, `cue`, `content_hash`, a positive integer `unit` and a positive integer `position`. `items` MUST be non-empty. Invalid payloads SHALL get HTTP 422 with a reason.

#### Scenario: Old payload version
- **WHEN** the payload has `version: 3`
- **THEN** the system responds with HTTP 422 and the bank is unchanged

#### Scenario: Item outside the declared unit
- **WHEN** mode is `unit`, unit is 3, and one item has `unit: 2`
- **THEN** the system responds with HTTP 422 and the bank is unchanged

#### Scenario: Empty item list
- **WHEN** the payload has an empty `items` array
- **THEN** the system responds with HTTP 422 and no expression is archived

#### Scenario: Missing or invalid item field
- **WHEN** an item has no `cue`, or has `position: 0`
- **THEN** the system responds with HTTP 422 naming the item id or index

### Requirement: Overwrite changed or moved expressions
For each payload item whose `id` exists, the system SHALL overwrite the content fields, `content_hash`, `unit` and `position`, and set it active, when any of `content_hash`, `unit` or `position` differs or the expression is archived. Per-user review state SHALL be preserved.

#### Scenario: Edited content
- **WHEN** an existing expression arrives with a different `content_hash`
- **THEN** its content is replaced, it counts in `updated`, and every user's box, due time, hits and misses are unchanged

#### Scenario: Expression moved to another unit
- **WHEN** an existing expression arrives with the same `content_hash` but `unit` changed from 2 to 3
- **THEN** its `unit` becomes 3 and it counts in `updated`

#### Scenario: Expression reordered inside a unit
- **WHEN** an existing expression arrives with the same `content_hash` and `unit` but `position` changed from 5 to 2
- **THEN** its `position` becomes 2 and it counts in `updated`

#### Scenario: Archived expression returns
- **WHEN** an archived expression is present in the payload
- **THEN** it becomes active again, it counts in `unarchived`, and users resume from their previous box

### Requirement: Archive expressions missing from the synced unit scope
After applying the items, the system SHALL archive every active expression in scope whose id is not in the payload. In `all` mode the scope is the whole bank. In `unit` mode the scope is expressions whose stored `unit` equals the payload `unit`. Archiving SHALL NOT delete rows or review state.

#### Scenario: Unit sync leaves other units untouched
- **WHEN** mode is `unit` for unit 3
- **THEN** no expression of another unit is archived

#### Scenario: Bullet deleted from a unit file
- **WHEN** `let-it-slide` (unit 3) is active and a unit-3 sync does not contain it
- **THEN** `let-it-slide` is archived and counts in `archived`

#### Scenario: Unit file deleted
- **WHEN** an `all` sync contains no item of unit 7
- **THEN** every active expression of unit 7 is archived

#### Scenario: Archiving keeps statistics
- **WHEN** an expression with review state for two users is archived
- **THEN** both users' review state rows still exist unchanged

## MODIFIED Requirements

### Requirement: Skip unchanged expressions
The system SHALL NOT write expressions whose `content_hash`, `unit` and `position` are unchanged and that are active.

#### Scenario: Identical item
- **WHEN** an active expression arrives with the same `content_hash`, `unit` and `position`
- **THEN** its `updated_at` is unchanged and it counts in `unchanged`

### Requirement: Sync result report
On success the system SHALL respond with JSON containing `mode`, `unit` (or null), `added`, `updated`, `unarchived`, `unchanged`, `archived` and `total_active`.

#### Scenario: Report counts
- **WHEN** a sync inserts 3, updates 1 and archives 2 expressions
- **THEN** the response body has `added: 3`, `updated: 1`, `archived: 2` and `total_active` equals the active bank size after the sync

#### Scenario: Unit echoed in report
- **WHEN** a sync runs in mode `unit` for unit 3
- **THEN** the response body has `mode: "unit"` and `unit: 3`
