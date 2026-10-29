# AI Quota Monitor

A Windows desktop app for monitoring AI service quotas and reset times without collecting account passwords.

## Status

Step 2 complete: Windows Forms app shell, tray, typed quota model, demo provider, local settings, and Windows Credential Manager wrapper. The build passes; app launch, Refresh, and hide-on-close have been observed. Tray reopen and credential round-trip still need live verification.

Step 3 in progress: the advanced OpenAI API organization usage adapter is available to organization admins. Ordinary ChatGPT and Codex users do not need an API key for the app. The adapter reports tokens used this UTC month; it does not report subscription quota, remaining allowance, or reset time. No authenticated account test has been run.

Ordinary users can add a manual reset tracker without any credentials. These entries are stored under the user's local application data and are labeled as manual; they never claim to know remaining quota. The advanced OpenAI API card appears only after an admin credential is connected.
The tracker form offers ChatGPT/Codex, Claude/Claude Code, Gemini, GitHub Copilot, Perplexity, Grok, Cursor, Poe, and Microsoft Copilot, plus a free-text service name.

GitHub Copilot personal AI credit usage can optionally be connected with a fine-grained GitHub token that has read-only Plan permission. The token is stored in Windows Credential Manager. This report shows credits used in the selected calendar month; it does not establish remaining included credits or the reset time.

The manual add, reload after app restart, and remove flows have been verified in the running Windows app.

The app now has a draggable overlay, tray show/hide control, automatic provider refresh, reset reminders for manual trackers, and settings for notifications, startup, tray launch, and overlay behavior. Startup is opt-in. The build and main-window overlay toggle were verified; Windows restart and notification delivery have not yet been verified.

Run with `dotnet run --project AIQuotaMonitor.csproj` on Windows with the .NET 10 SDK. Closing the window hides it in the tray; use the tray menu to quit.

See [docs/plan.md](docs/plan.md) for milestones, architecture, and acceptance criteria.
See [docs/provider-feasibility.md](docs/provider-feasibility.md) for documented provider access and data limitations.

## Product principles

- Show only provider data that can be obtained through supported access methods.
- Use provider OAuth when available, or user-created API credentials where supported. Never request account passwords.
- Label unavailable or unknown quota and reset information clearly.
- Keep credentials in the Windows credential store, never in plaintext configuration or logs.
- Let users disconnect each provider and remove its stored credentials.
