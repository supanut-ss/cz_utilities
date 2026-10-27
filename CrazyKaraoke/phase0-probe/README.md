# Phase 0 probe

This local-only probe checks YouTube Data API search, video embed status, and IFrame Player events. It has no production dependencies and does not store the API key or search results.

## Run

From PowerShell:

```powershell
Set-Location D:\GitSource\CrazyKaraoke\phase0-probe
.\run-probe.ps1
```

Enter the API key at the hidden prompt. The server binds to `127.0.0.1:4173`; open `http://127.0.0.1:4173` in Chrome. The key stays in the local Node process and is never returned by the health endpoint or sent to the browser. Stop the server with Ctrl+C.

To run the player-only probe without an API key, start `node .\server.mjs` directly. Search will show that a key is required.

## Checks

- Search with `videoEmbeddable=true`, then add one result to the test list.
- Search with `videoEmbeddable=any` to inspect videos whose `status.embeddable` is false.
- Load one allowed and one disallowed video in the YouTube Player. Use the player's own fullscreen control and note the `ENDED` or error event.
- Set the end time to `0` to play the full video; a positive value is only a short event probe.

The probe needs an internet connection. It does not implement Cast: Web Sender requires HTTPS and a real Cast receiver, so that check needs a separate hosted origin and target device. This probe is for Phase 0 only, not the application.
