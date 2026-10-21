# Proposal

## Why

A board member's pending-request list is fetched only when the board page loads. A request already recorded by the server remained invisible until F5 during the manual demonstration.

## What Changes

- Refresh pending requests while a member keeps the board open, without remounting its Canvas or collaboration session.
- Let a requester waiting on the board page enter automatically after a member approves access.
- Stop the refresh when the board is closed or the user signs out.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `board-membership`: Extend membership approval to update both the member and requester pages without a manual reload.

## Impact

Only the board page controller in `src/public/app.js` and a focused browser test. Existing authenticated board endpoints stay the same.
