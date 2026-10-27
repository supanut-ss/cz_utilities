# Karaoke Club

The Phase 1–5 app is a dependency-free Node.js prototype for karaoke rooms, YouTube search, queue management, host-controlled playback, scoring, and room moderation.

## Run locally

From the repository root, start the app with the local key helper:

```powershell
.\app\run-app.ps1
```

The helper reads the ignored `YOUTUBE_API_KEY.txt` file without printing the key. If that file is missing, it prompts for the key without echoing it. The key stays in the server process and is never sent to the browser. Room features still work without a key when starting the server directly, but search will be unavailable.

Open `http://127.0.0.1:4173`. To let other devices on the same network join, set `KARAOKE_HOST` to `0.0.0.0` before starting the server, then open the host computer's LAN address on each device. The invite link uses the address from which the room is opened.

## Room and queue behavior

- Create a room with a five-character invite code or join with a code or link.
- Rooms accept up to 16 players.
- The creator starts as host and can transfer host rights, remove a player, or close the room.
- Room state is sent to all connected players over Server-Sent Events.
- A random, HttpOnly session cookie identifies the player after refresh. Disconnected players remain in the room and appear offline until they reconnect or leave.
- Search runs on the server and only returns embeddable videos. Queue additions are checked against YouTube's current embed status; the queue shows the requester, duration, and Made for Kids status when available. Each player can queue up to three songs, add requests are rate limited, and the room queue is capped at 50 songs.
- Room members can report a problem with the current video once per song; the room sees only the aggregate count and reason totals.
- The host controls the IFrame Player and native fullscreen control. Playback state is shared with the room; when the host returns on a new player, the song restarts from the beginning.
- The singer can opt in to reference-free microphone scoring for any video. Audio analysis stays in the singer's browser; only the score summary is sent to the server. Listeners can vote after playback ends when microphone data is unavailable.
- Names, room codes, and state stay in the local server process. YouTube Data API handles search and video checks; the browser loads YouTube's IFrame Player API for playback.

Rooms are held in memory and disappear when the server process stops. Microphone access works on localhost or a secure HTTPS origin; LAN access over plain HTTP cannot use mic scoring. Use HTTPS for shared or public hosting; set `KARAOKE_TRUST_PROXY=1` only behind a trusted HTTPS reverse proxy.

## Scope

The current implementation covers room creation, nicknames, presence, invitations, reconnection, host transfer and removal, YouTube search, a shared queue, host-controlled playback, current-song reports, opt-in microphone scoring, and listener votes. The host device plays the video; other participants see the shared song, singer, playback state, and score summary. Cast remains for a later phase. Manual multi-browser and device verification is still pending.

## Score behavior

The microphone score is an estimate based on voice activity and short-window pitch stability. It does not compare the singer's pitch with the song melody or judge lyric and rhythm accuracy. Speaker audio and room noise can affect the estimate, so listeners can vote when microphone samples are insufficient. Votes are limited to one per listener and the singer cannot vote for themself.
