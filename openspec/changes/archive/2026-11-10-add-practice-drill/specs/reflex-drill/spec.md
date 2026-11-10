# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
