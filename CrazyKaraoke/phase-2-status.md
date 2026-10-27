# Phase 2 — YouTube Search and Shared Queue

**Status:** Implementation is in place; verification is deferred as requested.

## Implemented

- Added server-side YouTube Data API search using `type=video` and `videoEmbeddable=true`.
- Added result title, channel, thumbnail, duration, embeddable status, and Made for Kids status.
- Added pagination, short-lived result caching, a per-player cooldown, and a limit of 10 searches per player in 10 minutes.
- Rechecks embed permission on the server before adding a video to the room queue.
- Added duplicate prevention, a three-song per-player limit, and synchronized queue state.
- Added host-only queue reorder and remove actions.
- Kept the API key in the server process, loaded by `app/run-app.ps1` from the ignored local key file or a hidden prompt.

## Still to verify

- Search results and embed status against the supplied YouTube API key.
- Queue updates, duplicate prevention, per-player limits, and host controls across multiple browser contexts.
- Pagination and rate-limit messages.
- Confirm the key never appears in browser responses or server output.
