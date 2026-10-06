# Spec Delta

## Purpose

Defines how authorized replicas of one board exchange, preserve, and reconcile edits through direct peer connections and a persistent server replica.

## ADDED Requirements

### Requirement: Direct peer and server synchronization
The system SHALL synchronize an authorized board's edits directly between connected peers and with a persistent VPS replica.

#### Scenario: Peer receives a direct edit
- **WHEN** two authorized members are connected to the same board through a direct peer connection and one edits the board
- **THEN** the other can receive the edit without waiting for server persistence

#### Scenario: Server receives the edit
- **WHEN** a member with a server connection edits a board
- **THEN** the server replica receives and persists the edit for future members

#### Scenario: Direct peer path unavailable
- **WHEN** a direct peer connection cannot be established but both members can reach the VPS
- **THEN** the members continue to synchronize the board through the server connection

### Requirement: Board isolation
The system MUST restrict board state, synchronization messages, presence, and image access to members of that board.

#### Scenario: Member of another board
- **WHEN** a person has access to board A but not board B
- **THEN** that person cannot receive board B's state or collaboration messages

### Requirement: Offline editing and later reconciliation
The system SHALL preserve local board edits during temporary loss of all network connections and reconcile them with authorized replicas when a connection returns.

#### Scenario: Peer closes while the VPS is behind
- **WHEN** a member edits a board without reaching the VPS, closes the browser, and later returns
- **THEN** the member's local edits are restored and synchronized after reconnection

#### Scenario: Concurrent edits to different objects
- **WHEN** disconnected members edit different objects and later reconnect
- **THEN** both edits appear in the converged board

### Requirement: Independent properties converge independently
The system SHALL preserve concurrent changes to an object's geometry and its color when those properties are edited by different members.

#### Scenario: Move and recolor
- **WHEN** isolated members respectively move and recolor the same object and then reconnect
- **THEN** the converged object has the resulting position and the new color

### Requirement: Concurrent geometry remains coherent
The system SHALL resolve concurrent changes to one object's geometry to one coherent geometry rather than mixing coordinates from different moves.

#### Scenario: Two members move the same object
- **WHEN** isolated members move the same object to different positions and then reconnect
- **THEN** all replicas eventually display the same complete position from one of the moves

### Requirement: Deletion survives concurrent modification
The system SHALL keep an object deleted when deletion is concurrent with an edit to that same object, while preserving unrelated objects.

#### Scenario: Delete and recolor
- **WHEN** isolated members respectively delete and recolor the same object and then reconnect
- **THEN** the object remains absent on all converged replicas

### Requirement: Durable board recovery
The system SHALL reconstruct each board's latest server-persisted state after a server restart and synchronize a joining member from that state.

#### Scenario: Restart with no peers online
- **WHEN** the VPS restarts after acknowledging persistence of a board edit and no peers remain online
- **THEN** an authorized member who joins sees that edit

### Requirement: Distinct collaboration and persistence status
The system SHALL distinguish an edit visible only locally, visible on another peer, and confirmed as persisted by the server.

#### Scenario: Peer has update before VPS
- **WHEN** an edit reaches a peer while the VPS is disconnected
- **THEN** the interface does not present it as persisted on the VPS

### Requirement: Ephemeral collaboration signals
The system SHALL preserve connected-member presence, remote cursors, and live stroke previews without making their transient states part of durable board content.

#### Scenario: Live stroke
- **WHEN** a member draws a stroke while connected to another member
- **THEN** the other member can see its progress and the completed stroke remains in the board after the preview ends
