# Spec Delta

## MODIFIED Requirements

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
