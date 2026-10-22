# Spec Delta

## ADDED Requirements

### Requirement: Inspectable election observations
The system SHALL record each candidacy draw and each material change in a peer's election view, including candidate identity, generation, random number, eligibility, selected representative, tie-break and decision reason. Records SHALL identify the observing peer and its local order. Heartbeats that do not change the election view SHALL NOT create election history entries.

#### Scenario: Candidate draws a new number
- **WHEN** a candidacy is created or renewed, even if the representative remains unchanged
- **THEN** the history records its number, generation, observing participant and renewal reason

#### Scenario: Explain an election
- **WHEN** a member inspects a recorded election view
- **THEN** the member sees the candidate numbers, eligibility and rule that selected the representative, including any ID tie-break

#### Scenario: Divergent views during partition
- **WHEN** disconnected groups observe different candidates or representatives
- **THEN** the history preserves those observations separately and does not claim a single global election

### Requirement: Correlated persistence attempts
The system SHALL correlate each content batch with separately identified send attempts, the sender's election view, batch size and digest, send reason, VPS reception, durable commit and ACK response. Retry of one batch SHALL remain distinguishable from a new batch and from a change of sender. Bootstrap and read-only recovery SHALL NOT be presented as content uploads.

#### Scenario: Normal representative upload
- **WHEN** the representative sends a content batch
- **THEN** the history links the attempt to its sender, observed election and server lifecycle events

#### Scenario: Retry after lost ACK
- **WHEN** a batch is retried after timeout, possibly by another member
- **THEN** the history preserves the batch identity, separates the attempts and distinguishes prior persistence from the missing client acknowledgment

#### Scenario: Direct recovery
- **WHEN** a peer uploads through direct recovery without being the selected room representative
- **THEN** the record explains the recovery reason instead of reporting an election victory

### Requirement: Per-participant acknowledgment observations
The system SHALL record receipt and verification of a batch ACK at each observing participant, distinguish direct server delivery from peer forwarding, and relate confirmed updates to receipt coverage. A response written by the VPS SHALL NOT imply receipt by all peers. Missing observations SHALL be shown as unavailable rather than inferred success or failure.

#### Scenario: Forwarded ACK
- **WHEN** one participant receives the VPS ACK and another verifies the forwarded receipt
- **THEN** their observations remain distinct and refer to the same receipt and batch

#### Scenario: Invalid receipt or uncovered edit
- **WHEN** a receipt fails validation or does not cover a pending edit
- **THEN** the history explains the rejection or remaining pending state without reporting that edit as durably confirmed

#### Scenario: No report from one peer
- **WHEN** a server commit exists but one participant has not reported receiving its ACK
- **THEN** the panel shows persistence as confirmed and that participant's ACK observation as unavailable

### Requirement: Honest timing and evidence attribution
The system MUST distinguish server-observed facts from authenticated participants' reports. It SHALL retain event time, observer-local sequence, VPS ingestion time and measured local durations when available. It MUST NOT calculate network latency by subtracting unsynchronized clocks, treat client timestamps as a total order, or present a claimed random draw as independently verified.

#### Scenario: Skewed clocks
- **WHEN** peers report timestamps that disagree with the VPS clock
- **THEN** the panel preserves causal links and local order, labels the clock sources and displays only durations measured within one clock domain

#### Scenario: Client reports persistence
- **WHEN** a client submits a diagnostic claim that a batch was saved
- **THEN** the system labels it as a client report and does not create server persistence evidence or alter synchronization status from that claim

### Requirement: Durable bounded diagnostic history
The system SHALL collect persistence trace metadata independently of whether the experiment panel is open, retain recent records across app restarts, and buffer disconnected client reports locally within explicit count and byte limits. Repeated delivery SHALL be idempotent. Missing, uncollected and expired portions SHALL be visible. Diagnostic failure SHALL NOT block board synchronization or change election behavior.

#### Scenario: Reopen after offline collection
- **WHEN** a participant produces trace events offline and later reopens and reconnects with board access
- **THEN** retained local events are delivered without duplicates and are inspectable after reloading the panel

#### Scenario: Diagnostic retention reached
- **WHEN** trace history or its local queue reaches a retention limit
- **THEN** pruning is limited to diagnostic records, the panel identifies incomplete history and board recovery still works

#### Scenario: Existing batch predates collection
- **WHEN** a member inspects a batch created before detailed tracing was available
- **THEN** the panel shows known persistence metadata and explains that the election and ACK observations were not collected

### Requirement: Member-scoped trace access
The system MUST authenticate trace submission and queries, restrict them to current board members, bind the reporting account to its authenticated session, validate metadata limits and prevent client reports from impersonating VPS events. Trace payloads SHALL exclude board content, image bytes, credentials and private signing keys.

#### Scenario: Forged reporting identity
- **WHEN** a member submits another account's name or a server-event origin in a report
- **THEN** the server rejects or overrides the claimed identity and cannot store the report as authoritative VPS evidence

#### Scenario: Revoked member
- **WHEN** a participant loses board access
- **THEN** trace delivery and history queries are denied and the client stops retrying unauthorized submissions

### Requirement: Understandable persistence experiment panel
The experiment panel SHALL show the current representative and retained batch history using participant names and concise explanations. Each batch SHALL expose a visual sequence of election, send attempts, server persistence and per-participant ACK observations. Technical identifiers and candidate details SHALL be expandable, with filters and pagination for longer histories, without remounting the board Canvas.

#### Scenario: Understand a completed batch
- **WHEN** a member opens a completed batch in the experiment panel
- **THEN** they can identify who sent it, why that sender acted, what the VPS confirmed and which participants reported verifying the ACK without reading raw JSON

#### Scenario: Timeout and replacement
- **WHEN** one attempt times out and another representative sends a subsequent attempt
- **THEN** the panel distinguishes the two attempts, explains the replacement and preserves any later ACK from the first attempt

#### Scenario: Navigate the history
- **WHEN** a member filters by batch or participant, loads more records or switches boards
- **THEN** the panel preserves board isolation, accessible keyboard operation and the existing Canvas instance, and stops obsolete queries

### Requirement: Bounded trace traffic
The system SHALL batch diagnostic submissions and avoid transmitting periodic heartbeats, board snapshots or document updates as trace metadata. Trace requests and bytes SHALL be reported separately from content persistence measurements. Trace collection and history refresh SHALL use bounded queues and request sizes.

#### Scenario: Stable idle room
- **WHEN** a connected room exchanges heartbeats without election changes or persistence attempts
- **THEN** tracing does not create a new stored event or server submission for each heartbeat

#### Scenario: Measure synchronization cost
- **WHEN** members inspect experiment traffic counters
- **THEN** they can distinguish diagnostic traffic from the batches that persist board content
