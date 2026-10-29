# Skill Hub for Windows

A local-first desktop application for collecting Markdown AI skills and assigning them to independent AI profiles.

## Run the packaged application

Open `release/SkillHub-1.0.0-Windows-x64.exe` on Windows x64. Close an older running version before opening this release. The portable application does not require an installer. Windows may show its unsigned-publisher warning because this build has no code-signing certificate.

## Workflow

1. On startup the app discovers SKILL.md folders in known per-user locations. Click the local-discovery banner, select up to 200 entries, and import copies into the library. Alternatively, import an individual folder containing `SKILL.md`, or create a skill in the editor.
2. Select an AI profile, choose its skills, and save assignments.
3. Click Install to AI on a saved profile. The app detects supported local tools, preselects detected targets and shows the actual directories. Review the per-skill installation plan, then install into all selected tools in one operation.
4. Alternatively, export the saved profile to a directory you select. Each export creates a new bundle folder containing `manifest.json`, a README, and one directory per skill with its supporting files.

## Automatic machine transfer

1. Choose **ย้ายเครื่อง** and create a transfer folder. It contains `SkillHub-Transfer.skillhub`, all library skills with supporting files, profiles and their assignments, plus the running portable app when available.
2. Copy the whole folder to the other Windows machine. Open the copied app; if no app was included, open Skill Hub there and select the `.skillhub` file.
3. Choose **นำเข้าและติดตั้งให้ AI**. The app merges the library without replacing existing skills or profiles, detects supported AI tools on that machine, and installs the saved deployment sets. Turn off automatic installation to import only the library and profiles.

Only supported local tools found on the destination are installed: Codex, Claude Code, Cursor, Gemini CLI, OpenCode and GitHub Copilot. Missing tools, unsupported targets and conflicts are reported and skipped. ChatGPT accounts and Claude Cowork are not local folder targets. The transfer is a file copy you initiate; it does not use cloud storage or keep machines synchronized. Old-machine installation receipts and absolute source paths are not transferred. Skill instructions are copied as written, so any machine-specific paths inside Markdown remain unchanged.

Profiles group the skills to deploy. The app installs local user-scope skill files; it does not connect to AI accounts, invoke models or guarantee that provider-specific instructions and YAML extensions work identically across tools. It never executes imported scripts. Imported files are copied into the application library; later changes in the original folder are not synchronized.

## Repository import

Click Import repository to preview a public HTTPS GitHub root URL, optionally selecting a branch, tag or commit. The app resolves a full commit, downloads a bounded ZIP snapshot and lists SKILL.md directories before import. Only selected skills and their support files enter the library. Git, repository hooks, npm and install scripts are never run. Remote imports require internet access; GitHub API rate limits apply.

Use Choose local repository folder for a checkout already on the machine, including a private repository that you cloned yourself. The app does not request credentials or read Git configuration. Private remote URLs, SSH, GitLab and Bitbucket downloads are not implemented in this version.

The library preserves repository URL, ref, commit and relative skill path through edits. A new commit creates a separate library snapshot; choose that revision in a profile. Installation can update a previously managed target from the same repository and skill path even when the library snapshot ID changes. Selecting two revisions with the same skill folder in one profile is a conflict. Reopening a repository does not silently pull changes into assigned profiles.

## Local auto installation

| Target | User skill directory |
| --- | --- |
| Codex | `~/.agents/skills` |
| Claude Code | `~/.claude/skills` |
| Cursor | `~/.cursor/skills` |
| Gemini CLI | `~/.gemini/skills` |
| OpenCode | `~/.config/opencode/skills` |
| GitHub Copilot | `~/.copilot/skills` |

Detection reports configuration directories and executable or extension evidence; a configuration directory alone does not establish a running or signed-in AI. Targets not detected are disabled. ChatGPT web/cloud accounts and Claude Cowork are not local-folder installation targets. Shared `.agents/skills` can also be loaded by other standards-compatible tools.

An installation plan marks each item new, managed update, unchanged or conflict. Names must follow the portable skill standard. Existing imported frontmatter is preserved and validated. For app-created Markdown without frontmatter, the installed copy gains a minimal name/description; the library content stays unchanged. Claude-reserved names and duplicate folders are rejected.

The app will not overwrite an unmanaged folder or a managed folder modified outside Skill Hub. Managed updates create backups outside every AI skill root and recheck source and destination hashes before publication. Files are staged on the destination volume and renamed into place. If publication fails, the previous installation is restored where possible; any recovery paths are included in the result. Other skills are not removed. Close and reopen the AI or use its own skill reload mechanism if newly installed files do not appear.

Receipts and backups live beside the library under the application userData folder in `installer/`. Deleting these receipts makes existing installations unmanaged. No periodic auto-update, uninstall, account sync, app process termination or third-party dependency installation is performed. Provider root references and service contracts are recorded in INSTALLATION.md.

## Automatic local discovery

The app scans these directories beneath the Windows user home, when present:

- `.codex/skills` and `.codex/plugins/cache`
- `.agents/skills`
- `.claude/skills`
- `.cursor/skills`
- `.gemini/skills`
- `$CODEX_HOME/skills` when the environment variable is set

Only folder metadata and SKILL.md headers are read during discovery. Script/support-file contents are not read until the user imports the skill. Refresh rescans these roots. A source folder already imported into the library is marked as imported, including after app restart; edits preserve this provenance. Imports do not synchronize subsequent source changes. Removing a skill from the library makes that source eligible for import again.

Imports made in version 0.1 did not record source paths. They cannot be matched automatically to discovery entries; import them once again or keep the existing library entries.

Cached plugin versions can appear as separate entries; discovery does not establish whether a cached skill is enabled in an AI application. Project-specific skill folders or other locations can be imported manually. The scan does not enumerate entire drives, access credentials, send data over the network, or write into AI configuration folders.

Discovery is bounded at 5,000 directories, 20,000 entries, 10 levels and 1,000 candidates. It reads up to 64 KiB of each supported SKILL.md header and reports incomplete scans, inaccessible folders and skipped links. Individual imports still validate the complete skill folder. Partial batch-import failures are reported without undoing successful imports.

## Data and limits

- Desktop data: `%APPDATA%/Skill Hub/library` (the application displays the exact path).
- `state.json` contains Markdown skills, metadata and profile assignments. Imported supporting files are stored under `skills/<id>/`.
- Back up the entire application userData directory while the app is closed, including `library/` and `installer/` receipts/backups. Portable refers to the executable; data remains in the Windows user profile.
- Machine-transfer packages include the library and logical AI deployment selections, but not old-machine installer receipts or backups. Existing destination data is retained and merged.
- Imports allow at most 500 files, 20 MiB total, 2 MiB for SKILL.md, and 16 nested directory levels. Symlinks and unsupported Windows filenames are rejected.
- Deleting a skill removes it from profiles; imported supporting files remain in the library for manual recovery. Original source folders and exported bundles remain unchanged.
- Editing name/description/category changes library metadata. The Markdown editor controls the actual exported SKILL.md content, including any YAML frontmatter.
- Browser preview is a separate localStorage demonstration. Native folder import, export and opening the data directory require the desktop application. Preview data does not synchronize with desktop data.

## Develop

Requires Node.js 22 or later and npm.

```powershell
npm ci
npm test
npm run test:desktop
npm run test:migration:desktop
npm run start
```

`npm run dev` starts a browser preview at the local URL Vite prints. `npm run start` builds and runs Electron without a development server.

`npm run test:desktop` uses the installed Electron binary and isolated `.test-data/` directories. If your npm configuration disables installation scripts, run `node node_modules/electron/install.js` once after `npm ci`. To check an unpacked build instead, set `SKILL_HUB_EXECUTABLE` to its absolute `Skill Hub.exe` path before running the desktop test.

`npm run test:migration:desktop` exercises transfer between two isolated Windows homes using the source app and, when present, the unpacked packaged app. It checks automatic sidecar discovery, non-destructive library merge, detected-target installation, missing-target reporting and safe replay.

## Package

```powershell
npm run dist:win
```

The portable Windows x64 build is written into `release/`. `npm run pack:win` produces an unpacked executable directory. Packaging requires internet access on its first run to obtain Electron and builder resources.

## Desktop boundary

The renderer runs with context isolation, process sandboxing, no Node integration, a local custom protocol and a restrictive content policy. Native operations are exposed through a small typed-by-convention bridge with sender checks. AI instructions are displayed as text, never rendered as executable HTML.
