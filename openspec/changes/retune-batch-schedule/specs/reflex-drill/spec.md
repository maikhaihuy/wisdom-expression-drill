# Spec Delta

## MODIFIED Requirements

### Requirement: Drill summary
Finishing a drill SHALL close the session, set the user's `last_drill_date` to today in local time, and return the cards seen, first-try accuracy, median latency and the missed expressions. The bot SHALL also send this summary to the user's chat.

#### Scenario: Finished drill
- **WHEN** a user finishes a drill with 48 cards, 40 correct on first try
- **THEN** the Mini App and the chat both show 48 cards and 83% accuracy, and that day's drill-reminder batch (17:00 by default) has no drill button

#### Scenario: App closed early
- **WHEN** the user closes the Mini App after 2 minutes without finishing
- **THEN** already submitted answers are kept, and the session stays open without updating `last_drill_date`
