# Spec Delta

## MODIFIED Requirements

### Requirement: Open drill
`/drill` SHALL reply with a button that opens the reflex drill Mini App. `/drill N`, where N is a positive integer, SHALL reply with a button that opens the drill for unit N directly. Any other argument SHALL get a usage reply without a button.

#### Scenario: Drill button
- **WHEN** a user sends `/drill`
- **THEN** the reply contains a `web_app` button pointing to `/drill/`

#### Scenario: Unit drill button
- **WHEN** a user sends `/drill 4`
- **THEN** the reply names unit 4 and contains a `web_app` button pointing to `/drill/` with unit 4 selected

#### Scenario: Invalid unit argument
- **WHEN** a user sends `/drill abc` or `/drill 0`
- **THEN** the reply explains the usage and contains no button
