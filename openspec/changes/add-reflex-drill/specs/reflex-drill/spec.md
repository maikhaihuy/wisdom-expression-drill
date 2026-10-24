# Spec Delta

## Purpose

Provides a five-minute, timed, self-graded drill inside Telegram that trains fast recall of expressions the user has already learned, and feeds the results into their review state.

## ADDED Requirements

### Requirement: Mini App authentication
Every drill API request SHALL carry Telegram Mini App init data in the `X-Init-Data` header. The system SHALL accept the request only if the init data hash is valid for the bot token, `auth_date` is at most 24 hours old, and the user exists with `active = 1`. Otherwise the response is HTTP 401.

#### Scenario: Valid init data
- **WHEN** an active member opens the Mini App from Telegram and starts a drill
- **THEN** the start request succeeds

#### Scenario: Tampered init data
- **WHEN** the init data has a modified `user` field and the original hash
- **THEN** the response is 401 and no session is created

#### Scenario: Stale init data
- **WHEN** `auth_date` is 25 hours old
- **THEN** the response is 401

#### Scenario: Unregistered Telegram user
- **WHEN** valid init data belongs to a Telegram user who is not registered
- **THEN** the response is 401 and the Mini App tells them to register with an invite code

### Requirement: Identity from init data only
The user for every drill request SHALL be taken from the verified init data. User identifiers in the request body SHALL be ignored.

#### Scenario: Spoofed user id in body
- **WHEN** a valid request for user A includes `user_id` of user B in its body
- **THEN** the session and answers are recorded for user A only

### Requirement: Deck composition
Starting a drill SHALL create a session and return up to `DRILL_DECK_SIZE` (default 60) active expressions the user has already learned (box 1 or higher). About 50% are the highest miss_rate, 30% are due, and 20% are random from boxes 2–5, with no duplicates. Shortfalls in one group are filled from the others.

#### Scenario: Normal deck
- **WHEN** a user with 200 learned expressions starts a drill
- **THEN** the deck has 60 distinct learned, active expressions, and none are new to the user

#### Scenario: Small history
- **WHEN** a user has only 12 learned expressions
- **THEN** the deck contains those 12 expressions

#### Scenario: Nothing learned yet
- **WHEN** a user has no learned expressions
- **THEN** no session is created and the Mini App says to practise with batches first

### Requirement: Timed cards
A drill SHALL last `DRILL_SECONDS` (default 300). Each card SHALL show only the cue with a `CARD_SECONDS` (default 5) countdown, then reveal the expression and its first example. The user can reveal early by tapping. The time from cue display to reveal SHALL be recorded as latency.

#### Scenario: Early reveal
- **WHEN** the user taps 2.1 seconds after a cue appears
- **THEN** the answer is revealed and the latency is about 2100 ms

#### Scenario: Session time ends
- **WHEN** 300 seconds have elapsed
- **THEN** no new card is shown, and the drill finishes after the current card is graded or 10 seconds pass

### Requirement: Self-grading
After reveal, the user SHALL grade the card as correct (swipe right or tap "Đúng") or wrong (swipe left or tap "Sai"). A card revealed by timeout SHALL be pre-selected as wrong, and the user can change it before moving on.

#### Scenario: Timeout reveal
- **WHEN** a card reaches 0 seconds without a tap
- **THEN** the answer is shown with "Sai" pre-selected

### Requirement: Retry of missed cards
A card graded wrong SHALL be reinserted 3 to 5 positions later and repeated until graded correct or the session ends. Only the first attempt of each expression in a session SHALL be applied to review state. Repeats are recorded with `first_try = 0`.

#### Scenario: Miss then correct
- **WHEN** a card is wrong on its first attempt and correct on the repeat
- **THEN** review state receives one `miss` for it and nothing for the repeat

### Requirement: Answer submission
The Mini App SHALL send answers in groups of up to 10 and at finish. Submitting the same `(session, position)` again SHALL NOT duplicate or change the stored answer. Answers for a session that is finished or owned by another user SHALL be rejected.

#### Scenario: Retry after network error
- **WHEN** the same group of 10 answers is submitted twice
- **THEN** each answer is stored once and review state is updated once per first-try answer

### Requirement: Drill results update review state
First-try answers SHALL be applied with source `drill` under the spaced-repetition rules when they are received.

#### Scenario: Early hit
- **WHEN** a first-try correct answer is received for an expression not yet due
- **THEN** only its `hits` increases

### Requirement: Drill summary
Finishing a drill SHALL close the session, set the user's `last_drill_date` to today in local time, and return the cards seen, first-try accuracy, median latency and the missed expressions. The bot SHALL also send this summary to the user's chat.

#### Scenario: Finished drill
- **WHEN** a user finishes a drill with 48 cards, 40 correct on first try
- **THEN** the Mini App and the chat both show 48 cards and 83% accuracy, and the 20:00 batch that day has no drill button

#### Scenario: App closed early
- **WHEN** the user closes the Mini App after 2 minutes without finishing
- **THEN** already submitted answers are kept, and the session stays open without updating `last_drill_date`
