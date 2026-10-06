# Spec Delta

## Purpose

Makes temporary divergence, propagation paths, reconciliation, and concurrent edits inspectable during controlled demonstrations of distributed collaboration.

## ADDED Requirements

### Requirement: Replica state visibility
The system SHALL present a compact board preview for each participating peer and for the persistent server replica, so their states can be compared during a demonstration.

#### Scenario: Server replica is behind peers
- **WHEN** peers have received an edit that the server has not yet persisted
- **THEN** the demonstration view distinguishes the peers' current state from the server's persisted state

#### Scenario: Comparing replicas
- **WHEN** a demonstration includes multiple peers and the VPS
- **THEN** the view shows a separate board preview for each replica

### Requirement: Propagation path visibility
The system SHALL show an event timeline that distinguishes an edit, its first arrival through a peer or server connection, and confirmation of server persistence.

#### Scenario: Peer receives an update directly
- **WHEN** a peer receives a demonstrated edit through a direct peer connection before receiving it from the server
- **THEN** the event view identifies the peer connection as the first arrival path

#### Scenario: Edit is not persisted yet
- **WHEN** an edit has reached another peer but the server has not confirmed persistence
- **THEN** the demonstration view does not label the edit as persisted

#### Scenario: Event sequence
- **WHEN** an edit moves from its originating peer to another peer and then to the server
- **THEN** the timeline shows the edit, its first arrival path, and its persistence confirmation in sequence

### Requirement: Controlled network experiments
The system SHALL provide separate pause and resume controls for server synchronization and direct peer synchronization during demonstrations.

#### Scenario: Delayed server synchronization
- **WHEN** server synchronization is paused while peers remain connected to each other
- **THEN** peers can exchange edits while the server replica remains behind until synchronization resumes

#### Scenario: Late peer joins
- **WHEN** earlier peers disconnect while their edits are absent from the server replica and a new authorized peer joins
- **THEN** the new peer initially sees the server's persisted board state and can observe the missing edits arrive after an earlier peer reconnects

### Requirement: Concurrent edit demonstrations
The system SHALL support repeatable demonstrations of concurrent edits to one object and show the state before and after replicas reconcile.

#### Scenario: Same property edited concurrently
- **WHEN** isolated peers modify the same property of the same object and reconnect
- **THEN** the demonstration view shows the divergent states and the converged result

#### Scenario: Update concurrent with deletion
- **WHEN** one isolated peer deletes an object while another modifies it and they reconnect
- **THEN** the demonstration view shows the divergent states and the resulting board state after reconciliation

### Requirement: Inspectable recent history
The system SHALL retain a bounded history of recent board states and synchronization events for inspection without requiring a permanent record of every update.

#### Scenario: Compare recent states
- **WHEN** a member opens the history of a board used in a synchronization experiment
- **THEN** the member can inspect retained states and compare how the board changed across recent synchronization steps

#### Scenario: Trace convergence
- **WHEN** temporarily divergent replicas reconcile
- **THEN** the retained history shows the relevant changes and arrival paths from each observed replica's perspective

### Requirement: Safe history pruning
The system MUST preserve the latest durable board state and all information needed to synchronize a new peer when it removes old inspection history according to a configured retention limit.

#### Scenario: Retention limit reached
- **WHEN** the retained history exceeds the configured limit
- **THEN** older inspection entries may be removed while a new authorized peer can still reconstruct the current board state from persistent storage

### Requirement: Compare synchronization paths
The system SHALL expose update counts, transferred bytes, and convergence timing for the same demonstrated actions with and without direct peer synchronization.

#### Scenario: Compare hybrid and server-only runs
- **WHEN** an experiment repeats the same board actions in hybrid mode and server-only mode
- **THEN** the results present the measured update paths, traffic, and convergence time for each run
