# Implementation Plan

## Goal

Build a Windows desktop app that shows quota usage and reset times for multiple AI services. The app runs in the system tray, offers an optional always-on-top overlay, sends configurable notifications, and can start with Windows.

"All AI" means an extensible provider system. Coverage depends on each provider's supported data and authorization methods; the UI must never invent unavailable values.

## Step 1: Scope and feasibility (complete)

- Define common provider states: connected, disconnected, unavailable, and error.
- Define common quota fields: provider, account label, metric name, used, limit, remaining, unit, reset time, observed time, and data source.
- For each candidate provider, verify its current supported authorization and quota endpoints before implementing an adapter.
- Record whether each field is available, unavailable, or requires manual entry.

Acceptance: the product requirements and implementation sequence are documented; no password-based integration is planned.

The initial provider review is recorded in [provider-feasibility.md](provider-feasibility.md). It is a documentation review and does not claim live account verification.

## Step 2: Desktop foundation (complete)

- Create the app shell, local settings, provider interface, and typed quota model.
- Add system tray controls to open the main window or overlay, refresh data, and quit.
- Implement secure credential storage and a disconnect action.

Acceptance: the app launches, remains accessible from the tray, and stores no credentials in plaintext files or logs.

Current implementation: WinForms shell, tray, normalized quota model, demo provider, local settings, and Windows Credential Manager wrapper. Build verification passed. The main window and demo values were observed in the running app; Refresh updated the observation time. Closing the window removed it while the process remained running. Reopening from the tray and credential round-trip remain unverified; no real provider credentials are requested yet.

## Step 3: First provider adapters (in progress)

- Implement adapters only for providers with verified supported access methods.
- Normalize provider responses into the common quota model.
- Show a clear unknown state when a provider does not expose a metric or reset time.
- Handle authorization expiry, offline operation, and rate limiting.

Acceptance: connected providers show source-backed values and an observed time; failures do not display stale values as current.

Implemented first: OpenAI organization completions usage. The app requests an Admin API key from the user, stores it in Windows Credential Manager, and can disconnect it. Usage is shown as tokens used in the current UTC month; remaining quota and reset time stay unknown because this endpoint does not supply an allowance. Build and disconnected UI state were verified. An authenticated API response has not been tested.

Product correction: this is an advanced organization feature. The default consumer experience must not ask for an API key. Subscription integrations should use provider-supported authorization when available; if no supported quota access exists, display that limitation and offer manual reset tracking separately.

The default consumer flow now opens without an API key prompt and supports local manual reset trackers. Manual entries are clearly labeled and never display a fabricated remaining quota. Adding a tracker, loading it after a fresh app launch, and removing it were observed in the running app on 2026-10-29. The test tracker was removed afterward.

GitHub Copilot personal-account AI credit usage is now an optional adapter using a fine-grained token with Plan (read) permission. It reports usage only; remaining allowance and reset time are unknown until entitlement data can be verified. Authentication and live report parsing have not been tested with a real account.

## Step 4: Overlay and notifications (implemented; validation in progress)

- Add a compact overlay with expand/collapse, drag, position persistence, and optional always-on-top mode.
- Add per-provider notification settings for low quota, exhausted quota, reset, and connection errors.
- Deduplicate repeated alerts and respect Windows notification settings.

Acceptance: overlay state persists across restarts; each alert fires only when its condition changes or a new reset cycle begins.

Implemented: a draggable, optional always-on-top overlay with saved position; main-window and tray show/hide controls; five-minute provider refresh by default; one-minute reset checks; notifications before and at a manually entered reset time, with persisted deduplication keys. The main-window overlay control was observed changing between Show and Hide in the running app. Notification delivery and overlay position persistence have not yet been verified end to end.

## Step 5: Startup and release validation (in progress)

- Add an opt-in "Start with Windows" setting and an option to start minimized to tray.
- Package the app for Windows.
- Verify fresh install, sign-in and disconnect, restart, offline recovery, tray behavior, overlay, and notification delivery.

Acceptance: startup can be enabled and disabled from settings; the installed app survives a Windows restart and retains only intended settings.

Implemented: opt-in Windows startup registration under the current user's Run key, start minimized to tray, overlay on launch, notification threshold, and refresh interval. Settings UI was observed in the running app. Startup behavior after a Windows restart has not been tested.

## Design decisions to confirm before Step 2

- Desktop framework and distribution format.
- First provider list, based on verified access to usage and reset data.
- Polling intervals and notification thresholds, constrained by provider limits.
- Whether manually entered reset schedules should appear alongside provider-sourced data.

## Initial architecture

`Provider adapter -> normalized quota snapshot -> local state -> main view / overlay / notification engine`

Each adapter owns authorization, refresh, and error mapping. The app shell owns scheduling, credential storage, tray, startup, and UI preferences. A snapshot always carries its observation time and source so the UI can distinguish current, stale, and manually entered information.
