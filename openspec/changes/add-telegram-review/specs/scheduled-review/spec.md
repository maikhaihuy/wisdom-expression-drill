# Spec Delta

## Purpose

Delivers review batches to every active user at fixed local hours and records their self-grading, by inline buttons or by short text replies, into their spaced-repetition state.

## ADDED Requirements

### Requirement: Batch schedule
An hourly cron SHALL send one batch to each user who is active, not paused (`paused_until` empty or past), and whose local time is an even hour from 08:00 to 22:00 inclusive. Users SHALL be processed one after another, so one user's failure does not stop the others.

#### Scenario: User in UTC+7
- **WHEN** the cron runs at 07:00 UTC
- **THEN** a user with tz_offset_min 420 receives a batch (14:00 local)

#### Scenario: Night time
- **WHEN** the cron runs at 16:00 UTC (23:00 local for UTC+7)
- **THEN** that user receives nothing

#### Scenario: Paused user
- **WHEN** a user's `paused_until` is later than now
- **THEN** that user receives nothing from the cron

#### Scenario: One user fails
- **WHEN** sending to user A throws an error
- **THEN** users after A in the same run still receive their batches

### Requirement: Batch message format
A batch message SHALL show a header with the local time and the item count (with the number of new items). Each item is numbered and shows its cue, with the English expression inside a Telegram spoiler. Cue and expression text SHALL be HTML-escaped. Examples SHALL NOT appear in the batch message.

#### Scenario: Rendering
- **WHEN** a 7-item batch with 2 new items is sent at 14:00 local
- **THEN** the message header shows 14:00 and "7" with "2" new, and item 1 shows its cue followed by `<tg-spoiler>` containing its expression

#### Scenario: Special characters
- **WHEN** a cue contains `<` or `&`
- **THEN** it is displayed literally and the message is accepted by Telegram

### Requirement: Drill reminder
The 20:00 local batch SHALL include a button that opens the reflex drill Mini App when the user's `last_drill_date` is not today in local time.

#### Scenario: No drill today
- **WHEN** the 20:00 batch is sent and the user has not drilled today
- **THEN** the message includes the drill button

#### Scenario: Already drilled
- **WHEN** the user finished a drill at 07:30 local today
- **THEN** the 20:00 batch has no drill button

### Requirement: One open batch per user
When a new batch is sent, any previous open batch of that user SHALL be closed, with its unanswered items recorded as `skip`.

#### Scenario: Ignored batch
- **WHEN** the user never graded the 10:00 batch and the 12:00 batch is sent
- **THEN** the 10:00 batch is closed and its items are `skip`, with no state change

### Requirement: Grading with buttons
Each batch message SHALL have one button per item. Tapping an item button cycles its mark from unanswered to hit to miss and back to unanswered, and updates the keyboard. Marks SHALL NOT change review state until the batch is committed. A "Chốt" (commit) button commits the batch, recording unmarked items as `skip`. A "Đúng hết" (all correct) button marks unmarked items as hit and commits.

#### Scenario: Toggle then commit
- **WHEN** the user taps item 2 twice and then taps "Chốt"
- **THEN** item 2 is recorded as `miss`, the other items as `skip`, and only item 2's state changes

#### Scenario: All correct
- **WHEN** the user marks item 4 as miss and taps "Đúng hết"
- **THEN** item 4 is recorded as `miss` and every other item as `hit`

#### Scenario: Tap on a closed batch
- **WHEN** the user taps a button of a batch that is already closed
- **THEN** the callback is answered with a notice and nothing changes

### Requirement: Grading with text
A text reply SHALL grade and commit the user's latest open batch when it matches one of four forms. Numbered: `1o 2x`, `1-o, 2-x`. Positional: a string of only `o` and `x`. All correct: `ok` or `all o`. Misses listed: `x 2 5`. Unlisted items are `skip` in numbered form and `hit` in the misses form.

#### Scenario: Numbered form
- **WHEN** the open batch has 5 items and the user sends `1o 2x 4o`
- **THEN** items 1 and 4 are hit, item 2 is miss, items 3 and 5 are skip, and the batch is committed

#### Scenario: Positional form
- **WHEN** the open batch has 5 items and the user sends `oxoox`
- **THEN** items 2 and 5 are miss and the rest are hit

#### Scenario: Misses listed
- **WHEN** the user sends `x 2 5` for a 6-item batch
- **THEN** items 2 and 5 are miss and items 1, 3, 4 and 6 are hit

#### Scenario: Unparseable text
- **WHEN** the user sends `hmm` or a positional string whose length differs from the batch size
- **THEN** nothing is recorded and the reply shows the accepted formats

#### Scenario: No open batch
- **WHEN** the user sends `1o 2x` and has no open batch
- **THEN** nothing is recorded and the reply says there is no batch to grade

### Requirement: Commit summary
After a batch is committed, the system SHALL reply with the score (hits out of graded items) and, for each missed item, its expression, its cue and its first example if any.

#### Scenario: Two misses
- **WHEN** a 7-item batch is committed with 5 hits and 2 misses
- **THEN** the reply shows 5/7 and lists the 2 missed expressions with their cues and first examples

### Requirement: Idempotent commit
A batch SHALL be committed at most once. Later commit attempts (button or text) SHALL NOT apply results again.

#### Scenario: Double tap on commit
- **WHEN** Telegram delivers two "Chốt" callbacks for the same batch
- **THEN** review state is updated once and the second callback gets a notice
