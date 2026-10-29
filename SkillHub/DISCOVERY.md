# Local skill discovery

The desktop app scans known per-user skill directories on startup and when Refresh is pressed. It reads only folder metadata and SKILL.md headers. It never executes scripts or modifies the source folders.

## Contract

- `discoverSkills()` -> `{items: [{id, name, description, provider, path, imported}], roots: [{path, provider, status}], warnings: string[]}`. `id` is an opaque main-process token; scanning refreshes the token allowlist. Known roots include `.codex/skills`, `.codex/plugins/cache`, `.agents/skills`, `.claude/skills`, `.cursor/skills`, `.gemini/skills` under the Windows user home; also `$CODEX_HOME/skills` when set. Missing roots are expected. Exclude symlinks, `.git`, node_modules, venv, build output. Bound discovery by directories, depth, entries and SKILL.md size, and report incomplete scans.
- `importDiscovered(ids)` -> `{state, importedCount, failures:[{name,error}]}`. Main resolves tokens only against the most recent scan; no renderer-supplied filesystem path is accepted. Import validates/copies all support files through the existing store. Importing an already imported path is a no-op. Sources are snapshots and are not live-synchronized.
- Existing imported skills may have `originPath` (canonical source folder) for duplicate detection; preserve it through skill edits and validate when loading.
- Browser preview returns an empty discovery result with a desktop-only message. Native imports remain unavailable.

## Ownership

Discovery agent owns `lib/discovery.cjs`, `tests/discovery.test.cjs`, and minimal `lib/store.cjs`/store tests provenance changes. Lead owns main/preload integration, all React changes, packaging, integration tests and documentation.
