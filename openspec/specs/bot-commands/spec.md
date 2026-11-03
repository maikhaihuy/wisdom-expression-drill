# bot-commands Specification

## Purpose

Defines the slash commands registered users and the admin use to control their practice, inspect progress and manage the group, besides registration and invites.

## Requirements

### Requirement: Immediate batch
`/next` SHALL send the user a batch immediately, using the normal selection rules, even outside scheduled hours or while paused.

#### Scenario: Extra practice
- **WHEN** a user sends `/next` at 23:15 local
- **THEN** the user receives a batch and any previous open batch is closed

### Requirement: Open drill
`/drill` SHALL reply with a button that opens the reflex drill Mini App.

#### Scenario: Drill button
- **WHEN** a user sends `/drill`
- **THEN** the reply contains a `web_app` button pointing to `/drill/`

### Requirement: Personal statistics
`/stats` SHALL show the user's own figures: active bank size, expressions seen, count per box, accuracy over the last 7 days, and the current streak of consecutive local days with at least one graded answer.

#### Scenario: Stats after a week
- **WHEN** a user sends `/stats`
- **THEN** the reply shows counts for boxes 1 to 6, the 7-day accuracy as a percentage, and the streak in days, computed only from that user's data

### Requirement: Hardest expressions
`/hard` SHALL list up to 10 of the user's active expressions with the highest miss_rate, among those answered at least 3 times. Each line shows the expression, its cue and its hit/miss counts.

#### Scenario: Not enough data
- **WHEN** no expression has 3 or more answers for the user
- **THEN** the reply says there is not enough data yet

### Requirement: Pause and resume
`/pause <n>h` or `/pause <n>d` SHALL set `paused_until` to now plus that duration (1 hour to 30 days). `/resume` SHALL clear it. Invalid arguments SHALL get a usage message and change nothing.

#### Scenario: Pause for two days
- **WHEN** a user sends `/pause 2d`
- **THEN** no scheduled batch is sent to them for 48 hours, and the reply states the local end time

#### Scenario: Invalid pause
- **WHEN** a user sends `/pause forever`
- **THEN** `paused_until` is unchanged and the reply shows the usage

### Requirement: Timezone setting
`/tz <offset>` SHALL set the user's timezone offset, accepting `+7`, `-5`, `+5:30` style values between -12:00 and +14:00. Invalid values SHALL get a usage message.

#### Scenario: Change timezone
- **WHEN** a user sends `/tz +9`
- **THEN** their `tz_offset_min` becomes 540 and the next batches follow UTC+9 hours

### Requirement: Member overview for admin
`/members` SHALL, for the admin only, list every user with name, active flag, last graded-answer date and 7-day accuracy. Members SHALL be refused.

#### Scenario: Admin lists members
- **WHEN** the admin sends `/members`
- **THEN** the reply lists all users including inactive ones

#### Scenario: Member tries
- **WHEN** a member sends `/members`
- **THEN** the reply says the command is admin-only

### Requirement: Unknown commands
Any other command from a registered user SHALL get a short help message listing the available commands.

#### Scenario: Typo
- **WHEN** a user sends `/stat`
- **THEN** the reply lists the available commands
