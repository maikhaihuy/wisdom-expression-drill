# Spec Delta

## MODIFIED Requirements

### Requirement: Quiet hours
If a computed due time falls after 22:00 or before 07:00 in the user's local time, it SHALL be moved to 07:00 local on the next morning, so it is ready for the first batch of the day.

#### Scenario: Due late at night
- **WHEN** a miss at 22:00 local (UTC+7) makes the item due at 02:00 local
- **THEN** the due time becomes 07:00 local of that same calendar day

### Requirement: Batch selection
A batch SHALL contain only active expressions. Due items come first, ordered by miss_rate (descending), then box (ascending), then due time (ascending). New items follow in course order: lowest `unit` first, then lowest `position`. Selection stops at `BATCH_MAX` (default 15) items. If fewer than 5 items are found, the batch is topped up to 5 with not-yet-due items by highest miss_rate.

#### Scenario: Many due items
- **WHEN** a user has 20 due items
- **THEN** the batch contains the 15 highest-priority due items

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

### Requirement: No immediate repeats
Items of the user's previous batch SHALL be excluded from the next batch, unless that exclusion would leave the batch with fewer than the available minimum. Batch order SHALL be shuffled.

#### Scenario: Skipped item stays due
- **WHEN** an item was skipped in the 07:00 batch, is still due at 12:00, and the user has 14 other due items
- **THEN** the 12:00 batch does not contain it, and the 17:00 batch may contain it

#### Scenario: Exclusion relaxed for a small bank
- **WHEN** the active bank has 4 expressions and all were in the previous batch
- **THEN** the next batch still contains those 4 expressions
