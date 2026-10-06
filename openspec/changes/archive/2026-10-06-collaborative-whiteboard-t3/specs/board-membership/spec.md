# Spec Delta

## Purpose

Defines how signed-in people discover boards, request membership, and manage access without a privileged board creator.

## ADDED Requirements

### Requirement: Discoverable boards
The system SHALL let signed-in people search all boards and open a board through a direct link without granting access to its contents.

#### Scenario: Search without membership
- **WHEN** a signed-in person searches for a board of which they are not a member
- **THEN** the board can be found and its content remains inaccessible

#### Scenario: Direct link without membership
- **WHEN** a signed-in nonmember opens a direct board link
- **THEN** the system presents the option to request access without exposing board content

### Requirement: Membership approval
The system SHALL require acceptance by one current member before a requester can enter a board. Any current member SHALL be allowed to accept the request.

#### Scenario: Pending request
- **WHEN** a signed-in nonmember requests access
- **THEN** the request remains pending and the person cannot receive board content, images, or collaboration updates

#### Scenario: Accepted request
- **WHEN** any current member accepts a pending request
- **THEN** the requester becomes a member and can enter the board

### Requirement: Equal member permissions
The system SHALL give the board creator the same board membership permissions as every other member.

#### Scenario: Member other than creator approves access
- **WHEN** a current member who did not create the board accepts a pending request
- **THEN** the request is accepted without additional creator approval

### Requirement: Persistent and revocable membership
The system SHALL keep membership active until another current member revokes it. Any current member SHALL be allowed to revoke another member, including the creator.

#### Scenario: Return after approval
- **WHEN** an approved member returns to the board in a later session and has not been revoked
- **THEN** the member can enter without requesting access again

#### Scenario: Revocation by another member
- **WHEN** a current member revokes another member's access
- **THEN** the revoked member loses access to board content, images, and collaboration channels, including on reconnection

#### Scenario: Creator is revoked
- **WHEN** a current member revokes the creator's access
- **THEN** the creator loses access under the same rules as any other revoked member
