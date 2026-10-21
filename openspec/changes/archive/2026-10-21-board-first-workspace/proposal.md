# Proposal

## Why

At 1280×720, the board canvas starts below the visible page because account details, membership lists, study actions, and a large tool grid precede it. Drawing must be the primary activity; the current layout gives most of the first screen to secondary controls.

## What Changes

- Give the board a wide workspace with a compact header and tool controls.
- Move membership, study tools, replica diagnostics, history, and traffic panels into a scrollable secondary column without removing their actions.
- Adapt the layout for narrow screens so the canvas remains usable and panels remain reachable.

## Capabilities

### New Capabilities

- `board-workspace`: Defines the visual priority and access to primary and secondary board controls across viewport sizes.

### Modified Capabilities

None. Existing board, membership, study, and synchronization behaviors remain in place.

## Impact

Changes the static board page layout and CSS in `src/public/index.html`, plus the Canvas tool binding in `src/public/board-entry.js` and its call in `src/public/app.js` so secondary actions can move to the side column. No transport, persistence, dependency, or HTTP API change is planned.
