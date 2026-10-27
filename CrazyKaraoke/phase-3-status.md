# Phase 3 — Playback and Queue Progression

**Status:** Implementation is in place; verification is deferred as requested.

## Implemented

- Added host-only controls to start the next queued song and skip the current song.
- Added the YouTube IFrame Player with YouTube controls and its native fullscreen button.
- The host device plays the video; other participants receive the shared song, singer, and playback status through Server-Sent Events.
- Added shared ready, playing, paused, ended-waiting-for-score, and playback-error states.
- A YouTube `ENDED` event stops queue progression at the score stage; the host must start the next song.
- Added a tap-to-start path when the player needs a user gesture and a restart-from-beginning path when the host reconnects on a new player.

## Still to verify

- The sandbox must reach `www.youtube.com` to load the IFrame Player API and verify playback.
- Test YouTube `ENDED`, pause/resume, unembeddable errors, and the native fullscreen control in supported browsers.
- Verify that other room members receive playback changes and that queue progression waits for the host.
- Confirm behavior after host transfer, refresh, and temporary network loss.
