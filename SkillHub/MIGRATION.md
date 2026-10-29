# Version 0.4 automatic machine transfer

## Scope
Create a transfer folder containing `SkillHub-Transfer.skillhub`, an optional copy of the running portable executable, and an English README. Copy that one folder to another Windows machine. Startup discovers the sidecar automatically and opens a restore screen; one Restore and install action merges skills/profiles and installs saved deployment selections into supported AI targets detected on the destination. No old machine paths or installation receipts are reused. No cloud transport or continuous synchronization.

## Ownership
- Storage agent: `lib/store.cjs`, `lib/installer.cjs`, their existing tests only.
- Transfer agent: `lib/migration.cjs`, optional private archive helper `lib/transfer-archive.cjs`, `tests/migration.test.cjs` only.
- UI agent: `src/**` only.
- Lead: main/preload, native integration tests, package dependencies/build, documentation and review.

## Store and installer extensions
- `store.mergeSnapshot(snapshot,payloadRoot)` -> `{state,skillMap,profileMap,addedSkills,addedProfiles}`. Snapshot is `{version:1,skills:Skill[],profiles:Profile[]}`; payloadRoot contains `skills/<source-skill-id>/SKILL.md` and support files. Validate ALL source entries before committing anything. Keep original ids where free, reuse an identical same-id entry, remap colliding different ids and all profile assignments. Merge never deletes/replaces existing user skills/profiles. Preserve source type so created Markdown can still normalize at installation. Remove `originPath` and local absolute `originRepo`; preserve HTTPS GitHub provenance. Persist changed state atomically after copying new assets into fresh ids; on precommit failure clean only newly created paths. Return maps from imported ids to actual ids. Reject links, path traversal, inconsistent main content, missing support files and out-of-bounds payloads. Repeated identical import should not duplicate content; migration receipt additionally prevents package replay.
- `installer.getDeploymentIntents()` -> `[{targetId,skillIds}]`, ONLY logical known target ids and library skill ids derived from valid currently managed receipts. No machine paths leave this API. Ignore stale/foreign/user-modified installations. Existing source identity rules apply.
- `installer.planSelection({skillIds,targetIds})` -> same plan shape as plan(profileId...), without creating artificial profiles in library. Apply still validates source hashes and current target state. Existing plan(profileId...) unchanged.

## Migration native API
`createMigration({dataRoot,store,installer,binarySource?})` returns:
- `exportPackage(destinationDirectory)` -> `{path,packagePath,appIncluded,skillCount,profileCount,warnings}`. Destination exists, creates a unique transfer folder. binarySource optional trusted full path of the *portable stub* executable, not Electron's extracted application. Runtime uses `process.env.PORTABLE_EXECUTABLE_FILE` only; source/unpacked builds omit the executable and return warning. No npm, scripts, credentials, cache directories, old receipts or backups are exported.
- `preview(packagePath)` -> `{id,createdAt,skillCount,profileCount,deployments:[{targetId,targetName,skillCount,detected,supported,note}],warnings,alreadyRestored}`. Validates bounded archive, schema, declared file checksums, path/name/link safety and full payload before exposing preview. Unpacks privately under dataRoot; UI sees only opaque preview id. Destination detection is read-only.
- `restore({previewId,autoInstall:true|false})` -> `{state,addedSkills,addedProfiles,installedCount,unchangedCount,failures:[{targetName?,skillName?,error}],backups,missingTargets:string[],alreadyRestored}`. Merge then automatically re-detect targets and install deployment skill sets through planSelection+apply, per target, skipping absent/unsupported/conflicting entries with real results. Preserve existing user data. Package receipt keyed by SHA256 only after successful library merge. Receipt holds id maps so retry can install without merging duplicates; do not mark failed/absent deployment work as complete. Backups/receipt belong to new machine.
- `pending(packagePath)` -> preview|null; returns null for missing sidecar or an already restored receipt; corrupt sidecar reports an error without writing library. Explicit preview remains available for reinstallation retry.

## Archive
Use runtime `yazl` to write and `yauzl` to read streaming ZIP with `.skillhub` extension. Format root `manifest.json` = `{format:'skill-hub-transfer',version:1,createdAt,snapshot:{version:1,skills:[],profiles:[]},deployments:[{targetId,skillIds}],files:[{path,size,sha256}]}`. Per-skill files under `skills/<id>/...`; manifest snapshot content matches SKILL.md exactly. Export deployment intents from installer; if none exist, derive by matching profile.provider to known native target ids and clearly warn fallback. Exclude ChatGPT/cloud. No source-machine filesystem paths in manifest metadata.
Bound package size and expanded bytes (512 MiB), files (50k), main content2MiB, skill500files/20MiB, state64MiB, profiles500, skills5000; enforce Windows-safe relative filenames, no symlinks/ADS/traversal/case collisions, CRC+SHA256 and exact declared file set. Avoid archive bombs and partial restores. Clean only validated own staging paths.

## Bridge and startup
- exportMigration() -> native folder dialog then exportPackage; null on cancel.
- previewMigration() -> native `.skillhub` file dialog then preview; null on cancel.
- restoreMigration({previewId,autoInstall}) -> restore.
- pendingMigration() -> pending from sidecar `SkillHub-Transfer.skillhub` beside `PORTABLE_EXECUTABLE_FILE`; test-only SKILL_HUB_TEST_SIDECAR override when TEST_MODE1. No arbitrary renderer paths.
All failures Thai, cancellation quiet. Restore/export count as active writes. Browser adapter rejects desktop operations.

## UI
Sidebar Transfer machine button opens dialog with Create transfer folder and Open transfer package. Package preview shows counts, destination target statuses, warnings and auto-install checkbox (default on); single Restore and install button. Display merge/install/skip/failure/backup results. Startup calls pendingMigration once, automatically opens this same dialog only when a new valid sidecar is present. Never erase an unsaved assignment silently; startup pending screen arrives after initial state load, manual button prompts before discarding a draft or leaves it unchanged if operation just exports. onRestored updates full app state and resets current selected profile/draft correctly.

## Verification
Roundtrip between two fixture homes with DIFFERENT paths, preserve all support files/profiles/HTTPS repo provenance; no source paths or old receipts in bundle; auto install to destination roots; missing targets and conflicts reported; replay idempotent; collision merge preserves destination; corrupted/malicious/oversized package rejected before library changes; atomic failure; canceled dialogs; sidecar startup; actual portable stub copied in integration when available. Never modify real AI directories during tests.
