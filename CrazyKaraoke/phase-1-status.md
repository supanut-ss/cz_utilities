# Phase 1 — Room and Player Implementation

**Status:** Implementation is in place; verification is deferred as requested.

## Implemented

- Added a dependency-free Node.js app under `app/`.
- Added room creation with five-character codes and joining by code or invite link.
- Added host controls to transfer host rights or close a room.
- Added participant presence synchronized through Server-Sent Events.
- Added refresh and temporary reconnect support with an HttpOnly session cookie.

## Still to verify

- Use at least two browser contexts to confirm participants and host transfer stay synchronized.
- Refresh a participant page and verify that the same player rejoins the room.
- Disconnect and restore EventSource to verify reconnect behavior.
- Join from another device over the intended LAN or HTTPS setup.
- Rooms are in memory and disappear when the server process stops.
