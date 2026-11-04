# spaced-repetition Specification

## Purpose

Keeps a per-user Leitner state for every expression the user has practised, and decides which expressions each review batch should contain so forgotten ones return sooner.

## Requirements

### Requirement: Leitner boxes and intervals
Each user's state for an expression SHALL have a box from 1 to 6. An expression with no state for a user is "new" to that user. The review interval after an answer SHALL depend on the resulting box: 1 = 4 hours, 2 = 1 day, 3 = 3 days, 4 = 7 days, 5 = 16 days, 6 = 35 days.

#### Scenario: Interval for box 3
- **WHEN** an answer leaves an expression in box 3 at time T
- **THEN** its due time is T + 3 days (before quiet-hour adjustment)

### Requirement: Hit promotes
A `hit` SHALL increase the box by one (at most 6), increment `hits`, set `last_seen_at`, and set the due time from the new box's interval. A new expression counts as box 0, so its first hit moves it to box 1.

#### Scenario: Hit in box 2
- **WHEN** the user answers `hit` for an expression in box 2
- **THEN** it moves to box 3, `hits` increases by 1, and it is due 3 days later

#### Scenario: Hit in box 6
- **WHEN** the user answers `hit` for an expression in box 6
- **THEN** it stays in box 6 and is due 35 days later

#### Scenario: First answer creates state
- **WHEN** a user answers `hit` for an expression that has no state for them
- **THEN** a state row is created with box 1, `hits = 1`, and a due time 4 hours later

### Requirement: Miss demotes
A `miss` SHALL set the box to 1, increment `misses`, increment `lapses` when the previous box was 3 or higher, set `last_seen_at`, and set the due time 4 hours later.

#### Scenario: Miss from box 4
- **WHEN** the user answers `miss` for an expression in box 4
- **THEN** it moves to box 1, `misses` and `lapses` each increase by 1, and it is due 4 hours later

#### Scenario: Miss from box 2
- **WHEN** the user answers `miss` for an expression in box 2
- **THEN** it moves to box 1 and `lapses` is unchanged

### Requirement: Skip leaves state unchanged
A `skip` SHALL NOT change any field of the user's state for that expression.

#### Scenario: Unanswered item
- **WHEN** a batch is committed with item 3 unanswered
- **THEN** item 3's state is identical to before and it remains due

### Requirement: Drill hits on items not yet due
A `hit` from the reflex drill on an expression that is not yet due SHALL only increment `hits` and set `last_seen_at`. It SHALL NOT change the box or the due time. A drill `miss` SHALL follow the normal miss rule.

#### Scenario: Early drill hit
- **WHEN** a drill answer is `hit` for an expression in box 4 due in 5 days
- **THEN** it stays in box 4 with the same due time and `hits` increases by 1

### Requirement: Quiet hours
If a computed due time falls after 22:00 or before 08:00 in the user's local time, it SHALL be moved to 08:00 local on the next morning.

#### Scenario: Due late at night
- **WHEN** a miss at 20:30 local (UTC+7) makes the item due at 00:30 local
- **THEN** the due time becomes 08:00 local of that same calendar day

### Requirement: Forgetting rate
For ordering, the system SHALL use `miss_rate = (misses + 1) / (hits + misses + 2)` per user and expression.

#### Scenario: Unanswered expression
- **WHEN** an expression has 0 hits and 0 misses
- **THEN** its miss_rate is 0.5

### Requirement: Batch selection
A batch SHALL contain only active expressions. Due items come first, ordered by miss_rate (descending), then box (ascending), then due time (ascending). New items follow in course order: lowest `unit` first, then lowest `position`. Selection stops at 10 items. If fewer than 5 items are found, the batch is topped up to 5 with not-yet-due items by highest miss_rate.

#### Scenario: Many due items
- **WHEN** a user has 14 due items
- **THEN** the batch contains the 10 highest-priority due items

#### Scenario: Few due items
- **WHEN** a user has 2 due items, 1 allowed new item and 30 learned items not yet due
- **THEN** the batch contains 5 items: 2 due, 1 new and the 2 not-due items with the highest miss_rate

#### Scenario: Tiny bank
- **WHEN** the active bank has 3 expressions in total
- **THEN** the batch contains those 3 expressions

#### Scenario: Archived expression
- **WHEN** an expression that is due for the user has been archived
- **THEN** it is not selected

#### Scenario: New items in course order
- **WHEN** a user has not seen unit 1 positions 7–9 and all of unit 2, and 3 new items are allowed
- **THEN** the new items are unit 1 positions 7, 8 and 9

### Requirement: New-expression limits
A batch SHALL include at most `NEW_PER_BATCH` (default 3) new expressions. A user SHALL be shown at most `NEW_PER_DAY` (default 20) new expressions per local calendar day, counted when they are sent.

#### Scenario: Daily limit reached
- **WHEN** a user has already been sent 20 new expressions today
- **THEN** the next batch contains no new expressions

### Requirement: No immediate repeats
Items of the user's previous batch SHALL be excluded from the next batch, unless that exclusion would leave the batch with fewer than the available minimum. Batch order SHALL be shuffled.

#### Scenario: Skipped item stays due
- **WHEN** an item was skipped in the 10:00 batch, is still due at 12:00, and the user has 8 other due items
- **THEN** the 12:00 batch does not contain it, and the 14:00 batch may contain it

#### Scenario: Exclusion relaxed for a small bank
- **WHEN** the active bank has 4 expressions and all were in the previous batch
- **THEN** the next batch still contains those 4 expressions
