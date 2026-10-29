# Verification

Verified on Windows x64, 2026-10-29.

## Version 1.0.0 release and automatic machine transfer

- Production renderer build passed with Vite 6.4.5 (1,584 modules), and the Windows x64 portable executable was packaged with Electron Builder 26.18.0 and Electron 45.1.0 at `release/SkillHub-1.0.0-Windows-x64.exe`.
- All 55 unit tests passed, including the 201-skill batching case that verifies installer plans remain at or below 200 skills.
- `npm run test:desktop` passed and confirmed the app header displays `v1.0.0` from the package version.
- `npm run test:migration:desktop` passed against the source app and `release/win-unpacked/Skill Hub.exe`. In isolated source and destination homes it verified transfer-package export, automatic sidecar discovery, support-file and GitHub provenance retention, preservation of destination data, installation to detected Codex, skipping missing Claude Code, idempotent replay, and restart suppression after restore.
- The portable self-extractor was built, but Playwright could not attach to its wrapper process for direct UI automation. Its packaged application payload passed the complete desktop transfer smoke test; direct interaction with the outer self-extractor remains unverified.

- Production renderer build passed with Vite 6.4.5.
- Store, discovery, repository and installer suites: 46 tests, 43 passed and 3 skipped. The skipped tests require permission to create Windows symlinks; static checks reject symlinks, but those paths were not exercised by this host.
- Real Electron 45.1.0 source-app smoke test passed.
- Packaged `release/win-unpacked/Skill Hub.exe` smoke test passed using an isolated test-data directory. The portable executable contains this packaged application.
- Desktop tests exercised an empty first run, skill creation, search, assignment persistence, native folder import (dialog selection stubbed), supporting-file preservation, profile creation, Markdown preview, and native folder export (dialog selection stubbed).
- No renderer JavaScript errors occurred in the smoke test. Layout had no document overflow at widths 1380, 1024 and 860 pixels. The light-theme screenshot was inspected.

The portable self-extractor itself was built successfully; the automated interaction check targets its unpacked application payload. This build is unsigned. Live AI-account connections, periodic automatic updates and cloud synchronization are outside this version's scope.

## Version 0.3 repository import and installation

- A live public GitHub preview and selected import succeeded for `https://github.com/vercel-labs/skills` at commit `92a9a34ac3bf88e695e468b90c7bf32f163d32c8`. Three skills were discovered and one imported into an isolated library, preserving repository/commit/subpath metadata. No live AI skill directories were written.
- Repository unit tests validate URLs, pinned commits, failed downloads, strict ZIP paths, symlinks, Windows filename collisions, bounded extraction, CRC integrity, cache completion markers, local repository scanning and partial failures.
- Installer unit tests exercise normalization, native detection evidence, conflict protection, repeat no-ops, managed update backups, same-repository revision ownership, stale plans, modified source/destination/receipts, target-volume staging, and rollback including a simulated recovery failure.
- The real 0.3 Electron source-app UI test passed local-repository import, profile assignment, planning and installation of three skills into two isolated native target roots. Both SKILL.md and support files were checked. A second plan showed six unchanged entries. No actual user AI configuration was modified.
- The same complete 0.3 UI smoke test passed against `release/win-unpacked/Skill Hub.exe`, the application payload shipped inside the portable executable.
- Local read-only target detection found Codex and Claude Code executables and configuration directories; Cursor, Gemini CLI and Copilot were detected from configuration directories. Such directories alone do not prove the application is currently installed or active. OpenCode was not detected.
- Manual visual review confirmed the updated library screen and native installation entry point. The full desktop smoke test includes no renderer errors and checks desktop widths 1380, 1024 and 860 pixels.

## Version 0.2 local discovery

- Read-only discovery on this machine found 107 source folders: 16 under Codex skills, 76 in Codex plugin caches and 15 under Claude skills. These counts include cached entries and do not establish active AI configuration.
- Discovery unit tests exercised nested cache folders, header/depth/candidate bounds, opaque expiring tokens, duplicate roots, repeated imports, source disappearance and partial failure reporting.
- The real Electron 0.2 UI smoke test passed startup discovery, selecting a discovered skill, importing it, refreshing results, marking it as already imported and confirming the library count remains unchanged. Scan fixtures and Electron userData are isolated from the user's actual app.
- The same 0.2 smoke test passed against the packaged Windows executable payload.

Run `npm test` and `npm run test:desktop` to repeat the checks. Tests create only isolated fixture data. Dialog stubbing verifies the application bridge and filesystem behavior; manual folder-picker interaction was not automated.
