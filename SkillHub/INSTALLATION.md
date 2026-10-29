# Version 0.3: repositories and native installation

## Architecture
- Lead owns store metadata additions, IPC/main/preload, integration tests, packaging and docs.
- Installer agent owns `lib/installer.cjs` and `tests/installer.test.cjs` only.
- Repository agent owns `lib/repository.cjs` and `tests/repository.test.cjs` only.
- UI agent owns `src/**` only.

## Store extension (lead)
`importSkill(folder, {repo:{url,ref,commit,subpath}}?)` preserves optional `originRepo` metadata. `materializeSkill(id,destination)` writes that skill and support files to a new, nonexistent folder; it rejects overlapping private data paths and all symlinks, using existing validation. Metadata is retained on edits. Do not use exportProfile for individual installation payloads.

## Bridge contract
- detectTargets() -> Target[] = {id,name,path,detected,supported,evidence:string[],note:string}. No target paths accepted from renderer. Targets with no detected local tool/configuration remain disabled. ChatGPT/cloud account installation is unsupported, shown explicitly.
- planInstallation({profileId,targetIds}) -> {id,profileName,targets:Target[],entries:[{targetId,targetName,skillId,skillName,folder,status:'new'|'update'|'unchanged'|'conflict',reason}],warnings:string[]}. Plan token expires on new plan and locks the current content hashes. Existing unmanaged folders are conflicts, never overwritten.
- applyInstallation(planId) -> {installedCount,unchangedCount,failures:[{targetName,skillName,error}],backups:string[],restartNote:string}. Revalidate source and target hashes before writes, backup managed updates outside all skill roots, atomic per-skill writes and rollback on failure. Do not remove unselected or unmanaged skills.
- previewRepository({url,ref?}) -> RepoPreview = {id,url,ref,commit,items:[{id,name,description,path}],warnings:string[]}. Initially public HTTPS GitHub repo root URLs only. Empty ref uses default branch. Resolve exact commit via GitHub API, bounded codeload ZIP download with safe extraction via yauzl. Never execute code, git hooks, npm scripts or package installers from a repo. Cache snapshot privately. No credentials requested or embedded.
- previewLocalRepository() -> RepoPreview|null; main owns folder dialog; module `.previewLocal(folder)` scans selected local repo read-only. url may be a local folder label, commit may be empty; do not read .git/config/credentials.
- importRepository({repoId,skillIds}) -> {state,importedCount,failures:[{name,error}]}; IDs opaque per preview. Copies only selected SKILL folders; passes repo metadata to store.importSkill. Existing import deduplication is respected.
- All errors surface Thai messages. Browser preview explicitly rejects native operations.

## Native service contracts
`createInstaller({home,dataRoot,store,env?,testTargets?})` -> detectTargets(), plan({profileId,targetIds}), apply(planId). dataRoot is sibling of store library, holds receipts/backups and staging. Tests use fixture home; testTargets override adapters only for test callers, never renderer.
`createRepository({cacheRoot,fetchImpl?})` -> preview({url,ref?}), previewLocal(folder), importSelected({repoId,skillIds},store). Inject fetchImpl for offline deterministic tests. Use built-in fetch in production and lazy yauzl ZIP extraction.

## Verified provider roots
- Codex user skills: ~/.agents/skills (https://learn.chatgpt.com/docs/build-skills, Where Codex loads local skills).
- Claude Code: ~/.claude/skills (https://code.claude.com/docs/en/skills). Does not install into Cowork/cloud accounts.
- Cursor: ~/.cursor/skills (https://cursor.com/help/customization/skills).
- Gemini CLI: ~/.gemini/skills (https://geminicli.com/docs/cli/skills/).
- OpenCode: ~/.config/opencode/skills (https://opencode.ai/docs/skills/).
- GitHub Copilot: ~/.copilot/skills (https://docs.github.com/en/copilot/concepts/customizations/agent-skills).
Detect configuration directories and/or known executables without running the tools. Shared .agents roots can make skills visible to other standards-compatible tools; disclose in plan warnings.

## Installer requirements
Use YAML parser dependency `yaml` to inspect frontmatter; standard lowercase hyphen names, ensure target folder matches frontmatter name. For library-created Markdown lacking frontmatter, add minimal valid name/description while preserving body. Preserve existing frontmatter and supporting files. Reject invalid/reserved names and malformed metadata rather than claiming compatibility. Metadata extensions specific to one AI are copied, not translated; mention compatibility limit.
Keep receipt files/backups outside provider skill folders. Existing unmanaged same-name directories conflict even if same skill name. Never overwrite user-managed content. Managed updates require receipt path and old content hash to match actual disk. Repeated unchanged installs are no-ops. No automatic execution or process termination/restart.

## UI
Add Import repository button/dialog for GitHub URL + optional ref and local-folder alternative; preview discovered Skill list before copying. Add Install to AI on saved profile (disabled when draft dirty); native install modal detects targets, preselects all detected/supported, shows actual directories and plan results, then one final Install all selected action. No placeholder success: render partial failures, conflicts and backup paths. Preserve existing library, discovery and profile features.
