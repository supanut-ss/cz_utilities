# Phase 4 — Microphone Scoring and Listener Votes

**Status:** Reference-free scoring implementation is in place; verification is deferred as requested.

## Implemented

- Added an explicit microphone opt-in for the current singer before a song starts, with a live input-level meter.
- Added local pitch and voice-activity analysis. Raw audio is not recorded or sent to the server.
- Added a 0–100 estimate: 60% voice-activity coverage (capped at 35% coverage) and 40% short-window pitch stability. The server derives the score from summary metrics.
- Added one 1–5 listener vote per player when microphone data is unavailable. The singer cannot vote for their own performance.
- Added a ready stage between queue selection and playback so the singer has a chance to enable the microphone.

## Limits and verification

- The score does not compare singing pitch with the song melody and does not judge lyrics or rhythm accuracy.
- Speaker audio and room noise may affect voice detection; the score is an unverified estimate until calibrated with real devices.
- Verify microphone permission, level display, pause/resume timing, and cleanup after skip, room leave, and song end.
- Confirm score updates and duplicate-vote prevention across multiple clients.
- Microphone access on non-localhost origins requires a secure context such as HTTPS.
