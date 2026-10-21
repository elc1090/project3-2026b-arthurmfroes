# Spec Delta

## MODIFIED Requirements

### Requirement: Membership approval
The system SHALL require acceptance by one current member before a requester can enter a board. Any current member SHALL be allowed to accept the request. While the board page stays open, the member SHALL see new pending requests and an approved requester SHALL gain access without a manual reload.

#### Scenario: Pending request
- **WHEN** a signed-in nonmember requests access
- **THEN** the request remains pending and the person cannot receive board content, images, or collaboration updates

#### Scenario: Accepted request
- **WHEN** any current member accepts a pending request
- **THEN** the requester becomes a member and can enter the board

#### Scenario: New request appears on an open board
- **WHEN** a person requests access while a member is viewing the board
- **THEN** the member sees an accept action without reloading or losing the current board state

#### Scenario: Approval appears to the requester
- **WHEN** a member approves a request while the requester is waiting on the board page
- **THEN** the requester can enter the board without manually reloading the page
