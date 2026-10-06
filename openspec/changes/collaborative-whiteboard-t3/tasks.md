# Tasks

## Execution and parallel work

The numbered sections group work by capability; their numbers are not a strict execution order. Dispatch only tasks whose prerequisites below are ready. An implementer owns one task at a time, and a task is checked off only after its stated verification passes. Integration checks may wait for another lane, but an unfinished check must remain visible in the task rather than being silently treated as complete.

Start `1.1` and `1.2` in parallel. `1.2` reads the copied product and writes the feature checklist; it does not need the new application skeleton. Before dispatching work against the new skeleton, `1.1` must establish the module boundaries and shared contracts for board IDs, session/membership checks, Yjs board data, binary update storage and durable acknowledgements, asset references, and diagnostic events. Assign one owner to each shared contract. Other implementers consume it and coordinate any change before editing the same file.

| Lane | Tasks in local order | May overlap with | Handoff needed before integration |
| --- | --- | --- | --- |
| Accounts and access | `2.1 → 2.2 → 2.3 → 2.4` | Yjs model and update storage after `1.1` | `2.3` supplies board access checks to `5.1` and `6.1`; `2.4` supplies revocation and board epochs to `5.2` and `5.4`. |
| Board model and Canvas | `3.1 → 3.2 → 3.3 → 3.4` | Accounts and update storage after `1.1` | `3.1` fixes element IDs, geometry, order, and asset reference shape; `3.3` exposes the Canvas binding used by `5.3`, `6.1`, `6.3`, and `6.4`. |
| Durable updates | `4.1 → 4.2` | Accounts and board model after `1.1` | `4.1` supplies committed update storage and acknowledgements to `5.1`; `4.2` supplies reconstructed VPS state to `7.2` and recovery history to `7.3`. Store opaque Yjs bytes so this lane does not depend on Canvas code. |
| Browser offline | `4.3` after `3.1`; `4.4` after `4.1`, `5.1`, and `5.3` | Server storage and access work | Local restoration can be built early; the reconnect and status checks finish only after both transports exist. |
| Network paths | `5.1` after `2.3` and `4.1`; `5.2` after `2.4`; then `5.3 → 5.4` and `5.5` | `5.1` and `5.2` may run in parallel; `5.4` and `5.5` may run in parallel after `5.3` | `5.3` integrates both providers with the Canvas-bound document; `5.4` connects revocation to live P2P sessions. |
| Images and product features | `6.1` after `2.3`, `3.1`, and `3.3`; `6.2` after `6.1` and `4.3`; `6.3` after `1.2`, `3.3`, and `6.1`; `6.4` after `1.2`, `3.2`, and `3.3` | Server storage, signaling, and diagnostics | `6.3` and `6.4` can be divided by UI module only if they do not edit the same Canvas handlers; otherwise serialize those edits. |
| Diagnostics and evaluation | `7.1` after `4.1`, `5.1`, and `5.3`; `7.2` after `4.2`, `4.4`, `5.3`, and `7.1`; then `7.3` and `7.4` in parallel; finally `8.1 → 8.2` | Image and remaining product work where module ownership is separate | `7.2` reads actual VPS-persisted state through an authenticated diagnostic path separate from the paused sync path. `8.1` runs after the behaviors it tests exist; `8.2` uses measured results from `7.4` and `8.1`. |

For the demonstration controls, pause the selected replica's P2P provider and server-sync provider independently. Keep its authenticated diagnostic connection active so the panel can still show that replica while sync is paused. Do not route board updates through this diagnostic connection. A complete VPS outage also removes the diagnostic panel until the VPS returns; existing direct WebRTC connections may continue. Record this distinction in the demonstration script.

When multiple implementers share this uncommitted working tree, assign exclusive file ownership before they edit. Give one implementer ownership of shared bootstrap files, migrations, the board schema, and the Canvas event layer; integrate at the handoff points above before dependent tasks start. Isolated worktrees are optional if their changes can be brought back as patches without a commit. Avoid marking a task complete based only on its isolated module tests when its acceptance check requires another lane.

## 1. Project foundation

- [x] 1.1 Set up the single Node.js application, locked dependencies, SQLite migrations, and static UI entry point; verify a clean install and focused smoke checks from a fresh checkout.
- [x] 1.2 Record the copied whiteboard's tool, image, gallery, sidebar, export, AI-save, presence, and undo/redo behaviors in a feature-parity checklist; verify each checklist entry against the copied UI and source.

## 2. Accounts, boards, and membership

- [x] 2.1 Implement username/password registration, Argon2id hashes with per-account salts, sign-in, sign-out, and secure sessions; verify registration without email, invalid-login rejection, cookie flags, and absence of plaintext passwords with automated tests.
- [x] 2.2 Implement board creation, stable board links, and the searchable board catalog; verify two boards retain separate titles, memberships, and content through a server restart.
- [ ] 2.3 Implement pending access requests and acceptance by any current member; verify a nonmember can discover a board but cannot fetch content, images, or sync messages before acceptance.
- [x] 2.4 Implement persistent membership and revocation by any other member, including revocation of the creator; verify a revoked session cannot use board APIs or reconnect to board synchronization.

## 3. Collaborative board model

- [x] 3.1 Define stable element IDs, per-element Yjs maps, atomic geometry values, separate style values, and shared stacking order; verify concurrent move-plus-recolor, two moves, and overlapping elements converge in deterministic tests with reversed update arrival order.
- [x] 3.2 Implement delete markers and clipping replacements for eraser actions; verify delete-versus-update leaves the object absent and clipped strokes have stable visible segments after reconciliation.
- [x] 3.3 Bind Canvas actions and rendering to the Yjs board model with transaction-origin guards; verify a remote update renders once and does not emit a new local edit.
- [ ] 3.4 Implement local-scope undo/redo for creation, movement, deletion, and erasing; verify undoing one member's action preserves an independent remote edit.

## 4. Durable storage and offline work

- [x] 4.1 Persist per-board binary updates and issue a durable acknowledgement only after storage commits; verify an acknowledged edit survives a process restart with no browsers online.
- [x] 4.2 Add recoverable checkpoints and prune covered operational updates; verify restart and late-join reconstruction before and after pruning yield the same board state.
- [ ] 4.3 Persist browser documents locally and reconcile them on reconnect; verify an edit made without network survives tab closure and appears on another authorized replica after reconnection.
- [ ] 4.4 Expose local, peer-received, and durable-server statuses separately; verify a peer-visible edit is not marked persisted while the VPS path is paused.

## 5. Authenticated hybrid transport

- [x] 5.1 Add authenticated server WebSocket synchronization per board; verify authorized clients exchange missing Yjs updates while different boards and nonmembers remain isolated.
- [x] 5.2 Adapt private WebRTC signaling with membership and board-epoch checks; verify an unapproved or revoked account cannot subscribe or publish to a board topic.
- [ ] 5.3 Connect `y-webrtc` and server synchronization to the same browser document; verify two separate browser profiles receive a direct edit while the server path is paused and converge again when it resumes.
- [ ] 5.4 On revocation, advance the board epoch and reconnect remaining members without the revoked peer; verify active honest peers close the old room and the revoked account cannot join the new one.
- [ ] 5.5 Add ephemeral presence, P2P-only remote cursors, and throttled stroke/drag previews; verify cursors never traverse or persist on the VPS, live previews appear when their transport is available, and only completed actions enter the durable board state.

## 6. Images and original product behavior

- [ ] 6.1 Add authorized image upload/download and Yjs asset references; verify file, clipboard, and study-template images appear at the same position and size for authorized members and are denied to nonmembers.
- [ ] 6.2 Store disconnected image insertions as local pending assets and publish them after upload; verify an offline paste survives tab closure and later appears on another member's board.
- [ ] 6.3 Restore the study gallery and sidebar, PNG export, per-board manual PNG save for AI analysis, and feedback display; verify each action using the feature-parity checklist and a board containing text, shapes, strokes, and images.
- [ ] 6.4 Complete the pen, highlighter, line, arrow, rectangle, MUX, ALU, text, erase, selection, move, clear, pan, zoom, and fit interactions; verify each item in the feature-parity checklist in a browser run.

## 7. Observability and bounded history

- [ ] 7.1 Capture action IDs, per-replica first arrival path, update size, and durable acknowledgement events; verify the timeline distinguishes local edit, P2P receipt, server receipt, and persistence without claiming a global event order.
- [ ] 7.2 Build compact board previews for each participating replica and the VPS, plus independent server/P2P pause and resume controls; verify a paused server replica visibly differs from two peers that continue editing together.
- [ ] 7.3 Retain a bounded set of inspectable board checkpoints and event records with a visual object-state diff; verify old inspection entries expire while a new peer still reconstructs the latest board.
- [ ] 7.4 Record bytes, update counts, and convergence timing for hybrid and server-only modes; verify the same scripted edit sequence produces an exportable comparison for both modes.

## 8. Cross-system validation and T3 evidence

- [ ] 8.1 Run automated multi-client scenarios for late join, restart, temporary partition, move-versus-color, same-object moves, delete-versus-update, and image recovery; verify all replicas reach the expected board state after each network heals.
- [ ] 8.2 Produce a reproducible demonstration script and short evaluation report with observed state differences, update paths, convergence times, traffic, and limitations; verify another person can follow the script using the documented local setup.
