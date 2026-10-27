# Phase 5 — Reliability, Privacy, and Room Controls

**Status:** Core hardening is implemented; device verification is deferred as requested.

## Implemented

- Added host-only player removal. The removed player's queued songs, active event streams, and session tokens are cleared; their browser returns to the join screen.
- Added current-song reports for unavailable video, wrong video, audio issue, or other. Each player can report once per song; the room receives aggregate counts without reporter identities.
- Limited rooms to 16 players, each player to 10 queue-add requests per 10 minutes with a short cooldown, each player to three queued songs, and each room queue to 50 songs.
- Kept room state refresh recovery on the existing session cookie and Server-Sent Events reconnect path; a stream failure also triggers a bounded room-snapshot refresh and handles removed or closed sessions.
- Microphone access remains opt-in, local-only, and is released on song end, skip, room exit, or page close.

## Still to verify or decide

- Verify reconnection, host transfer after host exit, player removal, report updates, and queue limits across multiple devices.
- Verify microphone cleanup and permission behavior on mobile browsers and HTTPS LAN hosting.
- Rooms and scores still live in memory and disappear when the server process stops; persistent recovery is not implemented.
- Cast disconnect recovery and real-user sessions remain for their planned follow-up work.
