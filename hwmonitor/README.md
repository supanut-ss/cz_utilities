# HW Monitor

Live hardware monitor for Windows with full component specs, temperatures and fan speeds. Needs Node.js; the optional sensor helper needs the .NET 10 runtime.

## Desktop app (exe)

**`release\feature-build\HWMonitor.exe`** — the latest single-file Windows app (WinForms + WebView2) with LibreHardwareMonitor built in. No Node.js or server needed. `app\publish.cmd` builds the standard `release\HWMonitor.exe` output.

- Requires the .NET 10 Desktop Runtime and the Edge WebView2 Runtime (included with Windows 11).
- Always runs as administrator (UAC prompt on launch) and starts maximized.
- Requires the PawnIO driver: if it is missing, a setup dialog installs it with winget before the dashboard opens. If the install fails the dialog offers Retry, the download page, or Exit; the app does not start without it.
- **Overlay setup** offers Gaming, Compact and All metrics profiles, custom sensor selection and opacity. The borderless overlay has a rounded, draggable header and a hide button; custom layouts are saved per selected game, and **Ctrl+Shift+O** toggles the overlay.
- **Health & sessions** checks CPU/GPU temperature and memory/VRAM pressure, records an alert after three high readings, saves readings every 10 seconds during a session, and exports the session as CSV.
- **Game mode** captures FPS, frame time and 1% low for a selected running app through PresentMon. HW Monitor detects an existing console executable or downloads the latest official x64 CLI to the user profile and checks its published SHA-256 digest; use **Locate manually** if automatic setup is unavailable. Capture may need administrator rights or membership in the Windows **Performance Log Users** group.
- The browser version includes health alerts and session logging. Native overlay and game capture require the desktop app.
- Rebuild with `app\publish.cmd`, or `app\publish.cmd standalone` to bundle the .NET runtime into the exe (larger, runs on PCs without .NET).
- Source: `app/` — `MainForm.cs` hosts the dashboard from embedded `public/` files on a virtual `https://hwmonitor.local/` origin, `Collectors.cs` runs the PowerShell collectors (piped from embedded resources) and LibreHardwareMonitor, pushing data with `PostWebMessageAsJson`.

## Run with Node.js (browser version)

- Double-click **`HW Monitor.cmd`** — opens the dashboard maximized in its own window (Edge app mode). The background server exits ~30 s after the window is closed.
- Double-click **`HW Monitor (Admin).cmd`** for CPU, motherboard and drive sensors (asks for UAC). Close any open HW Monitor window first, otherwise the running non-elevated server is reused.
- Or run `node server.js` and open http://localhost:5757 (`--port=NNNN` or `PORT` to change it).

## Temperatures & fans

Read by `sensors/` — a small .NET helper around [LibreHardwareMonitorLib](https://www.nuget.org/packages/LibreHardwareMonitorLib) 0.9.6 that streams sensor values as JSON lines.

- Build it once with `sensors\build.cmd` (output: `sensors\dist\HwSensors.exe`). Without it the dashboard still works, just without the Sensors data.
- **GPU** temperature, hot spot, fan RPM and power work without admin rights (vendor APIs).
- **CPU, motherboard (Super I/O fans) and drive** sensors need the app/server to run elevated **and** the [PawnIO](https://pawnio.eu) driver installed. The desktop app runs elevated and installs PawnIO (`winget install namazso.PawnIO`) before opening, so both are always met there. LibreHardwareMonitor 0.9.6+ uses PawnIO instead of the old WinRing0 driver. The dashboard shows a notice when either requirement is missing.

## What it shows

| Section   | Specs                                                         | Live                                   |
|-----------|---------------------------------------------------------------|----------------------------------------|
| Processor | Model, cores/threads, base clock, L2/L3 cache                 | Total + per-thread load, effective clock |
| Memory    | Total, type, speed, voltage, per-slot module part numbers     | In use, available, committed, cached   |
| Graphics  | Model, exact VRAM (DXGI), driver version/date, display mode   | GPU load, VRAM usage, per-engine load  |
| Storage   | Model, NVMe/SATA, SSD/HDD, capacity, health, firmware, volumes | Active time, read/write throughput     |
| Network   | Adapter, link speed, IPv4, MAC                                | Download / upload                      |
| Sensors   | —                                                             | CPU/GPU/drive temps, fan RPM, power, temperature history |
| System    | Motherboard, BIOS, OS, displays, audio devices, battery       | Processes, threads, uptime, ACPI thermal zones (if exposed) |

## How it works

- `ps/specs.ps1` — one-shot CIM/WMI + DXGI scan, printed as JSON (takes ~10 s).
- `ps/live.ps1` — long-running loop emitting `Win32_PerfFormattedData_*` counters as JSON lines. These classes are not localized, so it works on any Windows display language.
- `sensors/` — LibreHardwareMonitor helper for temperatures, fans and power.
- `server.js` — serves `public/`, exposes `/api/specs` and streams `live` and `sensors` events over Server-Sent Events at `/api/live`.
- `launch.ps1` — starts the server (elevated with `-Admin`) and opens the window from a non-elevated process.
