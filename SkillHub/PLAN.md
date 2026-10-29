# Skill Hub for Windows

## Scope
Local-first Electron + React desktop application. Import a skill folder (SKILL.md and supporting files), create/edit Markdown skills, search the library, assign skills to AI profiles, install selected skills into supported local AI folders, and export versioned bundles. The app does not request provider credentials or invoke models.

Version 0.2 adds startup discovery of known per-user skill directories, selectable batch snapshot import and canonical source-path deduplication. See DISCOVERY.md for the bridge contract and bounds. Version 0.3 adds public GitHub/local repository import and managed native installation into detected local AI user skill directories. Version 0.4 adds an offline machine-transfer folder that merges the library and profiles at the destination, then offers one-click installation into detected supported AI targets. The transfer omits old-machine paths, receipts and backups. See MIGRATION.md for the archive and migration contract. INSTALLATION.md documents native target safeguards.

## Architecture and ownership
- Lead: integration, Electron main/preload, build configuration, Windows packaging, final verification.
- Storage agent: `lib/**` and `tests/store.test.cjs`, filesystem store, validation, import/export.
- UI agent: `src/**` only, React interface and browser preview adapter.
- Data lives in Electron userData; writes are atomic. Exports create a new bundle folder, never overwrite an existing destination.
- Visual direction: Windows utility, Segoe UI, cool white #f6f7fa, ink #202738, indigo #5046c7, quiet borders #dfe3ec, dark appearance supported. Left navigation, searchable library, right profile assignment inspector. No hero or decorative metrics.

## Shared bridge contract
`window.skillHub` provides Promise methods:
- getState() -> {version:1, skills:Skill[], profiles:Profile[], dataPath:string}
- importSkill() -> State | null (main owns folder dialog)
- saveSkill({id?:string,name:string,description:string,category:string,content:string}) -> State
- deleteSkill(id:string) -> State
- saveProfile({id?:string,name:string,provider:string,skillIds:string[]}) -> State
- deleteProfile(id:string) -> State
- exportProfile(profileId:string) -> {path:string,count:number} | null (main owns folder dialog)
- openDataFolder() -> void

Skill = {id,name,description,category,content,updatedAt,source,fileCount}; content is SKILL.md markdown. Profile = {id,name,provider,skillIds}. `source` is 'created' or 'imported'. All bridge failures reject with user-readable Thai messages. UI must handle cancellation, failures, empty state, unsaved assignments and loading. Browser preview uses a separate localStorage adapter clearly labeled as preview, with native folder operations unavailable.

## Store API
`createStore(root)` from `lib/store.cjs` returns async getState(), importSkill(folder), saveSkill(input), deleteSkill(id), saveProfile(input), deleteProfile(id), exportProfile(profileId,destination). Export returns {path,count}. openDataFolder is main only. Initial state includes four empty profiles: Codex, Claude, Gemini, ChatGPT; no invented skills. Store validates all input, rejects symlinks and unsafe paths, bounds import size/files, copies support files, never executes skill contents, rejects unsupported or corrupted state without replacing it.

## Verification
Node filesystem tests for persistence, validation, import supporting files, symlink rejection, non-overwriting export, assignment cleanup and invalid IDs. Build renderer. Exercise desktop through Playwright Electron when available; otherwise distinguish build/tests from unverified desktop behavior. Package Windows portable distribution and include English README with exact commands and limitations.
