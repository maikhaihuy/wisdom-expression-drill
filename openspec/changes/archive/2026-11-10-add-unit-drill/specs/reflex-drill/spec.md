# Spec Delta

## ADDED Requirements

### Requirement: Drill scope picker
Opening the Mini App without a unit SHALL show a picker with an "all units" option and one row per course unit that has active expressions, each with the user's learned count (box 1 or higher) and the unit's active total. Units with learned expressions SHALL be listed newest unit first; units with no learned expressions SHALL follow, disabled.

#### Scenario: Picker after finishing unit 4
- **WHEN** a user has learned all of units 1–4 (unit 4 has 20), 6 of 18 in unit 5 and none of unit 6 (22), and opens the Mini App
- **THEN** the picker shows "all units", then unit 5 (6/18), unit 4 (20/20), units 3, 2, 1, and finally unit 6 (0/22, disabled)

#### Scenario: Counts are per user
- **WHEN** two users with different progress open the picker
- **THEN** each sees learned counts from their own review state only

#### Scenario: Unit given in the link
- **WHEN** the Mini App is opened with unit 4 already chosen
- **THEN** the picker is skipped and the start screen for the unit 4 drill is shown

### Requirement: Unit deck composition
Starting a drill for unit N SHALL create a session for that unit and return the user's learned, active expressions in unit N in random order, up to `DRILL_DECK_SIZE`. Unlearned expressions SHALL never be included. If the user has no learned expressions in unit N, no session is created.

#### Scenario: Finished unit
- **WHEN** a user who has learned all 20 expressions of unit 4 starts a unit 4 drill
- **THEN** the deck has exactly those 20 expressions, in random order

#### Scenario: Partly learned unit
- **WHEN** a user has learned 6 of the 18 expressions in unit 5 and starts a unit 5 drill
- **THEN** the deck has those 6 expressions and none of the other 12

#### Scenario: Nothing learned in the unit
- **WHEN** a user starts a drill for a unit in which they have learned nothing
- **THEN** no session is created and the Mini App says to practise that unit with batches first

#### Scenario: Unknown or invalid unit
- **WHEN** the start request names a unit that is not a positive integer
- **THEN** the request is rejected and no session is created

## MODIFIED Requirements

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
