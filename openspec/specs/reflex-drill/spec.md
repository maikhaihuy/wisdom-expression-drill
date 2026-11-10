# reflex-drill Specification

## Purpose

Provides a five-minute, timed, self-graded drill inside Telegram that trains fast recall of expressions the user has already learned, and feeds the results into their review state.

## Requirements

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

### Requirement: Drill scope picker
Opening the Mini App without a unit SHALL show a picker with an "all units" option and one row per course unit that has active expressions, each with the user's learned count (box 1 or higher) and the unit's active total. Units with learned expressions SHALL be listed newest unit first and SHALL open the unit drill; units with no learned expressions SHALL follow, marked as practice only, and SHALL open practice for that unit.

#### Scenario: Picker after finishing unit 4
- **WHEN** a user has learned all of units 1–4 (unit 4 has 20), 6 of 18 in unit 5 and none of unit 6 (22), and opens the Mini App
- **THEN** the picker shows "all units", then unit 5 (6/18), unit 4 (20/20), units 3, 2, 1, and finally unit 6 (0/22, practice only)

#### Scenario: Unlearned unit opens practice
- **WHEN** the user taps unit 6, in which they have learned nothing
- **THEN** the start screen for practice of unit 6 is shown, with all 22 cards and a note that the result will not be saved

#### Scenario: Partly learned unit offers practice
- **WHEN** the start screen of the unit 5 drill is shown to a user who has learned 6 of its 18 expressions
- **THEN** it also offers to practise the whole unit, which starts practice with all 18 expressions

#### Scenario: Counts are per user
- **WHEN** two users with different progress open the picker
- **THEN** each sees learned counts from their own review state only

#### Scenario: Unit given in the link
- **WHEN** the Mini App is opened with unit 4 already chosen
- **THEN** the picker is skipped and the start screen for the unit 4 drill is shown

### Requirement: Deck composition
Starting a drill for all units SHALL create a session and return up to `DRILL_DECK_SIZE` (default 60) active expressions the user has already learned (box 1 or higher). About 50% are the highest miss_rate, 30% are due, and 20% are random from boxes 2–5, with no duplicates. Shortfalls in one group are filled from the others.

#### Scenario: Normal deck
- **WHEN** a user with 200 learned expressions starts a drill
- **THEN** the deck has 60 distinct learned, active expressions, and none are new to the user

#### Scenario: Small history
- **WHEN** a user has only 12 learned expressions
- **THEN** the deck contains those 12 expressions

#### Scenario: Nothing learned yet
- **WHEN** a user has no learned expressions
- **THEN** no session is created and the Mini App says to practise with batches first

### Requirement: Unit deck composition
Starting a drill for unit N SHALL create a session for that unit and return the user's learned, active expressions in unit N in random order, up to `DRILL_DECK_SIZE`. Unlearned expressions SHALL never be included. If the user has no learned expressions in unit N, no session is created.

#### Scenario: Finished unit
- **WHEN** a user who has learned all 20 expressions of unit 4 starts a unit 4 drill
- **THEN** the deck has exactly those 20 expressions, in random order

#### Scenario: Partly learned unit
- **WHEN** a user has learned 6 of the 18 expressions in unit 5 and starts a unit 5 drill
- **THEN** the deck has those 6 expressions and none of the other 12

#### Scenario: Nothing learned in the unit
- **WHEN** a user starts a drill for a unit in which they have learned nothing, for example from a `/drill 6` button
- **THEN** no session is created, and the Mini App says the unit has nothing learned yet and offers practice for that unit or choosing another unit

#### Scenario: Unknown or invalid unit
- **WHEN** the start request names a unit that is not a positive integer
- **THEN** the request is rejected and no session is created

### Requirement: Practice deck
Starting practice for unit N SHALL return every active expression in unit N, learned or not, in random order, up to `DRILL_DECK_SIZE`. A unit with no active expressions, or a unit that is not a positive integer, SHALL be rejected.

#### Scenario: Unit with nothing learned
- **WHEN** a user who has learned none of the 22 expressions in unit 6 starts practice for unit 6
- **THEN** the deck has all 22 expressions, in random order

#### Scenario: Partly learned unit
- **WHEN** a user has learned 6 of the 18 expressions in unit 5 and starts practice for unit 5
- **THEN** the deck has all 18 expressions

#### Scenario: Archived expressions
- **WHEN** unit 5 has 18 active and 2 archived expressions
- **THEN** the practice deck has only the 18 active ones

#### Scenario: Empty or invalid unit
- **WHEN** practice is requested for a unit with no active expressions, or for a unit that is not a positive integer
- **THEN** the request is rejected and the Mini App offers to choose another unit

### Requirement: Practice writes nothing
Practice SHALL NOT create a session, store answers, change any review state, introduce new expressions, count towards `/stats`, `/hard` or the streak, or change `last_drill_date`. Its timing, self-grading and retries of missed cards SHALL work as in the reflex drill.

#### Scenario: Practice leaves state unchanged
- **WHEN** a user practises unit 6, answers 22 cards (5 wrong) and finishes
- **THEN** the user's review state, sessions, statistics and `last_drill_date` are exactly as before

#### Scenario: Practice does not introduce expressions
- **WHEN** a user practises a unit with nothing learned
- **THEN** the next batch introduces new expressions exactly as it would have without the practice

### Requirement: Practice summary
Finishing practice SHALL show the cards seen, first-try accuracy, median latency and missed expressions in the Mini App, marked as practice that was not saved. No chat message SHALL be sent.

#### Scenario: Finished practice
- **WHEN** a user finishes practice for unit 6 with 22 cards, 17 correct on first try
- **THEN** the Mini App shows unit 6, 22 cards, 77% accuracy and a note that the result was not saved, and the bot sends nothing

#### Scenario: App closed during practice
- **WHEN** the user closes the Mini App in the middle of practice
- **THEN** nothing is stored and nothing is sent

### Requirement: Timed cards
A drill SHALL last at most `DRILL_SECONDS` (default 300) and SHALL end earlier when no cards are left to show, including repeats of missed cards. Each card SHALL show only the cue with a `CARD_SECONDS` (default 10) countdown, then reveal the expression and its first example. The user can reveal early by tapping. The time from cue display to reveal SHALL be recorded as latency.

#### Scenario: Early reveal
- **WHEN** the user taps 2.1 seconds after a cue appears
- **THEN** the answer is revealed and the latency is about 2100 ms

#### Scenario: Session time ends
- **WHEN** 300 seconds have elapsed
- **THEN** no new card is shown, and the drill finishes after the current card is graded or 10 seconds pass

#### Scenario: Deck runs out first
- **WHEN** a unit drill of 20 cards has every card graded correct, with no repeats pending, after 140 seconds
- **THEN** the drill finishes at once without waiting for the remaining time

#### Scenario: Time shown as a limit
- **WHEN** the start screen of a drill is shown
- **THEN** it presents the duration as a maximum, together with the number of cards

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
Finishing a drill SHALL close the session and return the cards seen, first-try accuracy, median latency and the missed expressions. The bot SHALL also send this summary to the user's chat. For a unit drill, both summaries SHALL name the unit. Only finishing an all-units drill SHALL set the user's `last_drill_date` to today in local time.

#### Scenario: Finished drill
- **WHEN** a user finishes an all-units drill with 48 cards, 40 correct on first try
- **THEN** the Mini App and the chat both show 48 cards and 83% accuracy, and the 20:00 batch that day has no drill button

#### Scenario: Finished unit drill
- **WHEN** a user finishes a unit 4 drill with 20 cards, 18 correct on first try
- **THEN** the Mini App and the chat both show unit 4, 20 cards and 90% accuracy, `last_drill_date` is unchanged, and the 20:00 batch that day still has the drill button if no all-units drill was finished that day

#### Scenario: App closed early
- **WHEN** the user closes the Mini App after 2 minutes without finishing
- **THEN** already submitted answers are kept, and the session stays open without updating `last_drill_date`

