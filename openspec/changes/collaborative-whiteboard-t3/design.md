# Design

## Context

See `proposal.md` for motivation and the five capability specs for required behavior. The copied product uses a Canvas UI, a single `elements` array, a FastAPI WebSocket server with one in-memory board, full JSON saves, and data-URL images. It is a feature reference, not an architecture constraint. The T3 target is a small group on one VPS; VPS deployment and tunneling remain optional execution work.

## Goals / Non-Goals

**Goals:**

- Make each board independently recoverable after server restart and reconcilable after a network partition.
- Give the demonstration a defensible distinction among local state, peer receipt, and durable server persistence.
- Preserve the product's existing tools and study flows while keeping high-frequency previews out of durable CRDT history.
- Make membership checks apply to HTTP content, server sync, signaling, and active peer sessions.

**Non-Goals:**

- Git-compatible commits, branches, and merges. The bounded visual history explains Yjs synchronization; it is not version control.
- Permanent retention of every raw update or the ability to undo arbitrary historical checkpoints.
- Migrating the original group's live `current_board.json`; the copied application supplies the product baseline.
- Operating multiple VPS servers or guaranteeing live P2P communication while the VPS and its access authority are unavailable.

## Decisions

### 1. One application server and one Yjs document per board

Use one Node.js service on the VPS for account and board APIs, authenticated WebSocket document sync, an adapted private signaling endpoint, image upload/download, and the diagnostic control channel. Keep account, board, membership, session, asset, and synchronization records in one SQLite database; keep image bytes in a board-scoped directory or content-addressed file store on the VPS. This avoids a second database service and runs Yjs in its native JavaScript environment. The copied Canvas UI can be retained or rebuilt without changing the behavior contract.

Alternative: retain the FastAPI server and bridge to a separate Yjs process. That adds a cross-process authorization and persistence boundary without helping this small VPS deployment.

### 2. Board model and conflict semantics

Each board has a stable server-issued ID and its own `Y.Doc`. Model elements by stable element IDs in a top-level `Y.Map`; each element is a nested `Y.Map`. Store its geometry as one value and color/style as separate values. Concurrent move and recolor can therefore both survive; concurrent moves resolve to one complete geometry. Put completed stroke points in one immutable value rather than one CRDT item per point. Use a `Y.Array` of element IDs for stacking order, filtering IDs whose elements are deleted.

Deletion marks an element as deleted in its shared record. A concurrent property update cannot reset that marker; rendering ignores deleted records. The eraser replaces a clipped stroke with new stable-ID segments in one transaction. Deletion undo is an explicit new edit that restores a visible element, rather than an accidental effect of a concurrent update. Test these semantics under both update arrival orders.

Alternative: store each whole element as one JSON value. It makes a concurrent move and recolor overwrite each other. Making every coordinate and stroke point independently shared instead adds CRDT overhead and can produce incoherent geometry.

### 3. Two network paths attached to the same document

Attach an authenticated server sync provider and `y-webrtc` to the same browser `Y.Doc`. The server holds a replica of each active board. Peers exchange updates directly; each browser also sends and receives updates through the VPS. Yjs state vectors reconcile missing changes on reconnection, and duplicate updates are safe to apply. The signaling server only helps peers establish connections; it is not the persisted board replica. Keep the board's document identity stable across membership-epoch changes.

Use provider/transaction origin tags to distinguish local, P2P, and server updates and to prevent canvas-to-document-to-canvas loops. A Canvas interaction writes to Yjs once; observers render resulting state without emitting another user edit.

Alternative: server-only WebSockets simplify authorization but remove the P2P experiment. P2P-only cannot recover a board when all browsers close.

### 4. Authentication, signaling, and revocation

Store Argon2id hashes with unique salts. Use server-side sessions in SQLite and secure browser cookies. Every HTTP content/asset request and server WebSocket connection checks board membership. Serve signaling only from the VPS under the application's authenticated origin; do not use public signaling servers for private boards. Adapt the `y-webrtc` signaling endpoint to check membership and the current board epoch on subscription and publication. Give authorized members an opaque epoch-specific room name and secret after authentication.

On revocation, deny the revoked account at all server endpoints, invalidate its signaling access, advance the board epoch, notify connected members to close old P2P links, and reconnect them in the new room. Members who were offline must fetch the current epoch before reconnecting. Previously downloaded content cannot be recalled. While the VPS is unreachable, existing honest peers may continue editing, but membership cannot be newly granted or revoked there; revocation takes effect among peers when they receive the new epoch.

Alternative: a static room name or shared password is insufficient for revoking one member who already knows it. Requiring the VPS to relay every document update would make authorization simpler but defeat direct synchronization.

### 5. Durable board state and bounded inspection history

Persist each received Yjs update as bytes associated with its board before sending a custom durable acknowledgement. Periodically store a self-contained encoded document state as a checkpoint. Recovery loads the latest durable checkpoint and applies later updates; only then may older operational updates be pruned. Keep a separate bounded list of inspectable checkpoints and event metadata for the demo. History pruning never removes the latest recovery checkpoint or its required tail. Keep referenced image files while current or retained historical states use them.

The event timeline records the local action ID, replica, first arrival channel, size, and local receive time. It shows each replica's observed order; wall-clock timestamps from different machines are not treated as a global total order. The visual diff compares renderable object states between retained checkpoints. Yjs binary updates provide synchronization, while this metadata makes them understandable to a person.

Alternative: writing only full JSON boards loses the incremental synchronization story. Keeping every raw update forever would grow without bound and still would not provide a readable Git-like history.

### 6. Offline edits, images, and rendering

Persist each browser's Yjs document with IndexedDB so a completed local edit survives closing the tab before reaching the VPS. Keep pan and zoom local to that browser. Store each image as a VPS asset with a stable asset ID; the Yjs element stores that ID, position, size, and stacking ID rather than base64 bytes. A connected insertion uploads the asset before publishing its board element. An insertion without VPS access is a local pending asset stored in IndexedDB and shown to its author; after reconnection it uploads and publishes the element. Peers cannot fetch a new asset until the upload completes. The existing explicit PNG save for AI analysis remains a derived board image, scoped to one board.

Alternative: putting image bytes into every Yjs document update simplifies offline peer transfer but makes board synchronization and retained history much larger. A separate P2P asset transfer protocol is possible but adds a second transport protocol to the T3.

### 7. Interaction frequency, presence, and undo

Use Awareness for connected users and cursors. Throttle live stroke previews and drag previews as ephemeral messages; commit the completed stroke or final geometry once per gesture in a Yjs transaction. This preserves the live experience without persisting every pointer movement. Scope undo/redo to local transaction origins with `Y.UndoManager` where its behavior matches the product, and use explicit semantic handling for deletion or eraser actions that need an atomic replacement. Remote edits must not enter another member's undo stack.

Alternative: committing every pointer move or point to Yjs provides a very detailed log but increases network traffic, document size, and undo complexity without improving the final board state.

### 8. Demonstration and evaluation

Provide a demonstration panel with one compact board preview per replica, connection and persistence status, an event timeline, and per-channel pause/resume controls scoped to the demonstration board. Retain a configurable bounded number of recent checkpoints and events. Reproduce late join, server lag, different-object edits, move-versus-color, same-object moves, and delete-versus-update. Measure updates and bytes per channel, recovery behavior, and time to convergence after a partition is released. Compare the hybrid mode with a server-only mode using the same board actions to assess what P2P changes in this application. Use separate browser profiles during tests so same-browser tab communication does not bypass the intended partition.

## Risks / Trade-offs

- [A server acknowledgement may be mistaken for a peer acknowledgement] -> Label local, peer-received, and durable-server states separately; only the server sends the durable acknowledgement.
- [A revoked browser retains prior data or an old direct connection] -> Deny future server access, rotate the room epoch, and close honest peers' old channels; document that already copied data cannot be erased.
- [A server checkpoint is created before outstanding updates are durable] -> Serialize writes and checkpoints per board; prune only after a committed checkpoint contains the updates being removed.
- [Image metadata arrives before its bytes] -> Publish connected images only after upload; retain offline images as local pending assets until upload succeeds.
- [Tombstones and retained history grow over time] -> Bound inspection history and measure document size; compact operational updates only after a recoverable checkpoint.
- [A WebRTC path fails behind a restrictive network] -> Continue via the authenticated VPS WebSocket path; optional TURN can be added for a VPS deployment if the experiment requires it.
- [A merged Yjs update is mistaken for an authored action] -> Keep application event metadata separate from CRDT bytes and show it as an observation, not as a Git commit.

## Migration Plan

The existing copied app remains the feature reference. Build the new board model and storage behind isolated board IDs, then connect the UI to the new model while checking each original interaction. Do not overwrite a real `current_board.json`. For a future data import, convert each legacy element into a stable-ID board element and upload each embedded image as an asset; that import is not required for the T3.

## Open Questions

- The history retention count and preview layout can be tuned after a realistic board is measured; they do not change the storage or permission model.
- The course rubric and whether a live VPS demonstration is required must be checked before the final submission package. The application behavior and experiment design do not depend on that deployment choice.
