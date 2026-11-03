# user-access Specification

## Purpose

Controls who may use the bot: an admin bootstrapped from configuration, members registered with single-use invite codes, and isolation of each user's data.

## Requirements

### Requirement: Webhook authenticity
The system SHALL process Telegram updates only when the header `X-Telegram-Bot-Api-Secret-Token` equals `TELEGRAM_WEBHOOK_SECRET`. Other requests SHALL get HTTP 401 and SHALL NOT be processed.

#### Scenario: Forged update
- **WHEN** a POST to `/tg/webhook` carries no secret header or a wrong one
- **THEN** the system responds with 401 and sends no Telegram message

#### Scenario: Genuine update
- **WHEN** a POST carries the correct secret header
- **THEN** the system responds with 200 and handles the update

### Requirement: Private chats only
The system SHALL ignore updates from group, supergroup and channel chats.

#### Scenario: Message in a group
- **WHEN** a registered user sends `/next` in a group chat that contains the bot
- **THEN** the system sends nothing and changes nothing

### Requirement: Admin bootstrap
When no user with role `admin` exists, a `/start` from the Telegram user whose id equals `ADMIN_CHAT_ID` SHALL create that user with role `admin`. An admin SHALL NOT be created any other way.

#### Scenario: First admin
- **WHEN** the users table has no admin and user `ADMIN_CHAT_ID` sends `/start`
- **THEN** that user is created with role `admin` and receives a welcome message

#### Scenario: Admin already exists
- **WHEN** an admin exists and another unregistered user sends `/start` without a code
- **THEN** no user is created and the reply explains that an invite code is required

### Requirement: Invite codes
An admin SHALL be able to create a single-use invite code with `/invite`. The code SHALL be 8 random characters from an unambiguous alphabet and SHALL expire 7 days after creation. Non-admins SHALL be refused.

#### Scenario: Admin creates invite
- **WHEN** the admin sends `/invite`
- **THEN** the reply contains a new code and the command `/start <code>` to forward, and the code expires 7 days later

#### Scenario: Member tries to invite
- **WHEN** a member sends `/invite`
- **THEN** no code is created and the reply says the command is admin-only

### Requirement: Registration with invite code
An unregistered user SHALL become a member by sending `/start <code>` with a valid, unused, unexpired code. The user is created with role `member`, the default timezone and their Telegram first name, and the code is marked used by them.

#### Scenario: Valid code
- **WHEN** an unregistered user sends `/start K7PX2MQA` with a valid code
- **THEN** the user exists as an active member and the code records `used_by` and `used_at`

#### Scenario: Used or expired code
- **WHEN** an unregistered user sends `/start` with a code that is used, expired or unknown
- **THEN** no user is created and the reply says the code is invalid

### Requirement: Unregistered and inactive users
For a user who is not registered or has `active = 0`, the system SHALL answer any message except `/start` only with instructions to register, and SHALL NOT send them scheduled batches.

#### Scenario: Stranger writes to the bot
- **WHEN** an unknown user sends `hello`
- **THEN** the reply explains `/start <invite code>` and nothing is stored

### Requirement: Deactivation when the bot is blocked
When Telegram answers HTTP 403 to a message sent to a user, the system SHALL set that user's `active = 0`. A later `/start` (with or without a code) from that user SHALL set `active = 1` again, keeping all review state.

#### Scenario: User blocks the bot
- **WHEN** sending a scheduled batch to a user returns 403
- **THEN** the user becomes inactive and the next scheduled runs skip them

#### Scenario: User comes back
- **WHEN** an inactive registered user sends `/start`
- **THEN** the user becomes active and their boxes and statistics are unchanged

### Requirement: Per-user data isolation
Every read or write of review state, sessions and statistics SHALL be scoped to the user identified by the Telegram update (or by verified Mini App init data). A user SHALL NOT be able to read or grade another user's data.

#### Scenario: Grading another user's batch
- **WHEN** user A sends a callback query whose data references a session owned by user B
- **THEN** the system rejects it and user B's session is unchanged
