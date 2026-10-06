# Proposal

## Why

The T3 project will turn an existing collaborative whiteboard product into a multi-board system with authenticated membership and observable distributed synchronization. The original app defines the feature baseline, while the new architecture explores Yjs, browser-to-browser collaboration, and a persistent VPS replica.

## What Changes

- Add simple username-and-password accounts without email verification, with salted password storage and authenticated sessions.
- Add multiple discoverable boards. A signed-in user can find a board through search or a direct link, but must be accepted by a current member before receiving its content or joining its collaboration session.
- Make board membership persistent and revocable. Every member can accept a request or revoke another member; board creation grants no extra privileges.
- Preserve the existing whiteboard product capabilities, including images, while replacing the collaboration architecture with one Yjs document per board, direct peer synchronization, and a persistent VPS replica. Exact implementation details remain for the design phase.
- Support local edits during temporary disconnection, durable recovery of each board, and convergent handling of concurrent changes to shared objects.
- Make replica divergence, reconciliation, and concurrent edits observable through controlled experiments. The agreed display direction is one board preview per replica (peers and VPS), an event timeline that distinguishes editing, P2P receipt, and server persistence, plus independent pause/resume controls for P2P and VPS synchronization. Layout and visual details remain open; a 60-second server delay is an example, not a production synchronization policy.
- Retain a bounded, inspectable history of recent synchronization events and board states for comparing replicas and observing recovery. History may be pruned after a configurable limit, but pruning must not discard the latest durable board state needed by a new peer.

## Capabilities

### New Capabilities

- `user-accounts`: Account registration, login, session handling, and password protection.
- `board-membership`: Board discovery, access requests, equal member permissions, and revocation.
- `board-content`: Board creation and isolation, drawing and study features, images, export, and local editing behavior inherited from the existing product.
- `board-sync`: Peer and server replicas, offline reconciliation, durable recovery, and observable concurrency semantics for board objects.
- `sync-observability`: Controlled demonstrations, recent history, and inspection of synchronization and concurrency across peers and the VPS.

### Modified Capabilities

None. There are no existing main specs in this repository.

## Impact

The future implementation will affect the whiteboard UI, account and membership APIs, board storage, collaboration transport, image access, and VPS persistence. This capture creates planning artifacts only; no application behavior changes yet.
