# Spec Delta

## MODIFIED Requirements

### Requirement: Batch schedule
An hourly cron SHALL send one batch to each user who is active, not paused (`paused_until` empty or past), and whose local time is one of the batch hours in `BATCH_HOURS` (default `7,12,17,22`, i.e. every 5 hours from 07:00 to 22:00). Users SHALL be processed one after another, so one user's failure does not stop the others.

#### Scenario: User in UTC+7
- **WHEN** the cron runs at 05:00 UTC
- **THEN** a user with tz_offset_min 420 receives a batch (12:00 local)

#### Scenario: Night time
- **WHEN** the cron runs at 16:00 UTC (23:00 local for UTC+7)
- **THEN** that user receives nothing

#### Scenario: Between batch hours
- **WHEN** the cron runs at 03:00 UTC (10:00 local for UTC+7)
- **THEN** that user receives nothing

#### Scenario: First and last batch of the day
- **WHEN** the cron runs at 00:00 UTC and at 15:00 UTC
- **THEN** a UTC+7 user receives the 07:00 and the 22:00 local batches

#### Scenario: Paused user
- **WHEN** a user's `paused_until` is later than now
- **THEN** that user receives nothing from the cron

#### Scenario: One user fails
- **WHEN** sending to user A throws an error
- **THEN** users after A in the same run still receive their batches

### Requirement: Batch message format
A batch message SHALL show a header with the local time and the item count (with the number of new items). Each item is numbered and shows its cue, with the English expression inside a Telegram spoiler. Cue and expression text SHALL be HTML-escaped. Examples SHALL NOT appear in the batch message.

#### Scenario: Rendering
- **WHEN** a 15-item batch with 3 new items is sent at 12:00 local
- **THEN** the message header shows 12:00 and "15" with "3" new, and item 1 shows its cue followed by `<tg-spoiler>` containing its expression

#### Scenario: Special characters
- **WHEN** a cue contains `<` or `&`
- **THEN** it is displayed literally and the message is accepted by Telegram

### Requirement: Drill reminder
The batch at local hour `DRILL_REMINDER_HOUR` (default 17) SHALL include a button that opens the reflex drill Mini App when the user's `last_drill_date` is not today in local time.

#### Scenario: No drill today
- **WHEN** the 17:00 batch is sent and the user has not drilled today
- **THEN** the message includes the drill button

#### Scenario: Already drilled
- **WHEN** the user finished a drill at 07:30 local today
- **THEN** the 17:00 batch has no drill button

### Requirement: One open batch per user
When a new batch is sent, any previous open batch of that user SHALL be closed, with its unanswered items recorded as `skip`.

#### Scenario: Ignored batch
- **WHEN** the user never graded the 07:00 batch and the 12:00 batch is sent
- **THEN** the 07:00 batch is closed and its items are `skip`, with no state change
