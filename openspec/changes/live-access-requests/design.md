# Design

## Context

`loadBoard` currently fetches members and pending requests once. The server already exposes authenticated board metadata and request-list endpoints, so no transport or data model change is needed.

## Goals / Non-Goals

**Goals:** Refresh access state while the board page is open and keep the active Yjs document and Canvas mounted when only the request list changes.

**Non-Goals:** Add push notifications, a new WebSocket channel, or background polling outside the board page.

## Decisions

- Poll at a short fixed interval using existing GET endpoints. This is sufficient for small study groups and avoids another long-lived connection.
- Members refresh only the pending list. Requesters check board membership and call the existing board loader once approval is visible.
- Stop timers and discard stale responses when a board reloads or the user signs out. Avoid overlapping requests on a slow connection.

## Risks / Trade-offs

- Polling can take a few seconds to show a change. Keep the interval at five seconds and refresh immediately after local approval.
- A request may resolve after navigation. A generation check prevents it from updating the new page.
