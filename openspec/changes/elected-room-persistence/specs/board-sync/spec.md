# Spec Delta

## MODIFIED Requirements

### Requirement: Direct peer and server synchronization
The system SHALL synchronize an authorized board's edits directly between connected peers and with a persistent VPS replica.

#### Scenario: Peer receives a direct edit
- **WHEN** two authorized members are connected to the same board through a direct peer connection and one edits the board
- **THEN** the other can receive the edit without waiting for server persistence

#### Scenario: Server receives the edit
- **WHEN** a member with a server connection edits a board
- **THEN** the server replica eventually receives and persists the edit through a room representative or direct recovery for future members

#### Scenario: Direct peer path unavailable
- **WHEN** a direct peer connection cannot be established but both members can reach the VPS
- **THEN** the members continue to synchronize the board through the server connection

## ADDED Requirements

### Requirement: Elected periodic persistence
The system SHALL elect a temporary representative using shared random priorities among available peers, batch incremental changes at a configurable interval, and rotate the representative after a configurable mandate. In a stable connected room, other peers SHALL NOT send ordinary content copies to the VPS.

#### Scenario: Stable room
- **WHEN** peers agree on one available representative and edit a board
- **THEN** they exchange edits directly and one representative sends incremental batches to the VPS

#### Scenario: Rotation
- **WHEN** the representative's mandate expires
- **THEN** its candidacy is renewed with a fresh random priority and peers elect from the available candidates

### Requirement: Verifiable persistence coverage
The system MUST mark an edit as persisted only after receiving a server-authenticated receipt whose coverage includes that edit, including its deletions. Receipt distribution through peers SHALL NOT grant peers authority to fabricate persistence.

#### Scenario: Edits during an in-flight batch
- **WHEN** an edit is created after a representative has captured a batch
- **THEN** the batch receipt does not confirm that later edit unless its exact coverage was also persisted

#### Scenario: Forged receipt
- **WHEN** a peer supplies a forged, altered or wrong-board receipt
- **THEN** the receiver keeps uncovered edits pending

### Requirement: Failover and direct recovery
The system SHALL replace a representative after timeout and retry pending persistence. A peer without confirmation within the configured recovery deadline SHALL be able to persist directly. Network partitions SHALL NOT require exclusive global leadership for persistence to progress.

#### Scenario: Representative disappears
- **WHEN** a representative disconnects before acknowledgment
- **THEN** another available candidate takes over and pending edits remain available for retry

#### Scenario: P2P unavailable
- **WHEN** peers can reach the VPS but not one another
- **THEN** direct recovery persists their edits and periodically retrieves changes from the VPS

#### Scenario: Acknowledgment timeout
- **WHEN** the server request exceeds the configured acknowledgment deadline
- **THEN** the candidate relinquishes its current mandate and retry proceeds with pending edits retained

### Requirement: Idempotent batch receipts
The server SHALL acknowledge batches only after committing their bytes and SHALL deduplicate retries of the same batch identity and bytes, including after checkpoint and when another authorized member retries. Conflicting reuse of an identity MUST be rejected.

#### Scenario: Lost ACK and checkpoint
- **WHEN** a committed batch is retried after its ACK was lost and its operational row was checkpointed
- **THEN** the server confirms persistence without another operational insert for that batch

### Requirement: Local recovery and coordination lifecycle
The system SHALL retain pending board content in local persistence across closing and reopening, clean up coordination on session destruction or revoked membership, and expose representative, pending and recovery status to the interface.

#### Scenario: Reopen before confirmation
- **WHEN** a peer closes before receiving a durable receipt and later reopens
- **THEN** its locally preserved edits can be reconciled and confirmed without depending on the former representative

#### Scenario: Access revoked
- **WHEN** the server reports that a participant no longer has board access
- **THEN** that participant stops sending batches and participating as representative
