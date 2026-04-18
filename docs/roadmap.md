# Roadmap

## Phase 1: Stabilize & Polish (Current)

Bug fixes and UX improvements identified during testing.

### Bug Fixes
- [x] Surface real error messages in backgroundStartup() and healthCheck() — user-friendly messages in notices, full detail in console (done on main)
- [x] Fix Local Docker mode on Windows / Rancher Desktop (buildLocalWindowsCommand)
- [x] Fix MCP path traversal vulnerability (isPathWithinDir)
- [x] Fix MCP timing-safe auth, body size limit, error handling

### UX Quick Wins
- [ ] Terminal font size setting (hardcoded to 14 in terminal-view.ts:272)
- [ ] Auto-start container when opening terminal (instead of error notice)
- [ ] Per-setting restart labels (replace blanket "most settings require restart" warning)
- [ ] Bind address security warning when set to 0.0.0.0
- [ ] Compose path validation on input (check docker-compose.yml exists)
- [ ] Terminal scrollback size setting (hardcoded to 10000)

## Phase 2: Release Automation (BRAT)

Enable managed beta testing via Obsidian BRAT.

- [ ] Create `plugin/versions.json`
- [ ] Create `plugin/version-bump.mjs` (syncs manifest.json + versions.json on npm version)
- [ ] Create `plugin/.npmrc` (tag-version-prefix="")
- [ ] Create `.github/workflows/release.yml` (build + GitHub Release on version tags)
- [ ] Create `.github/workflows/check.yml` (lint + test on PRs touching plugin/)
- [ ] Add `"version"` script to plugin/package.json
- [ ] First BRAT-compatible release

## Phase 3: Documentation (Diataxis)

Restructure docs for beta tester audience using the Diataxis framework.

### Tutorials (learning, practical)
- [ ] `docs/tutorials/getting-started.md` — first-time setup through running Claude
- [ ] `docs/tutorials/first-agent-task.md` — walk through a real Claude + vault task

### How-to Guides (working, practical)
- [ ] `docs/how-to/install-via-brat.md`
- [ ] `docs/how-to/configure-firewall.md`
- [ ] `docs/how-to/persistent-sessions.md`
- [ ] `docs/how-to/use-multiple-terminals.md`
- [ ] `docs/how-to/add-tools-to-container.md`
- [ ] `docs/how-to/customize-workspace.md`
- [ ] `docs/how-to/update-plugin.md`

### Reference (working, theoretical)
- [ ] `docs/reference/commands.md`
- [ ] `docs/reference/settings.md`
- [ ] `docs/reference/keyboard-shortcuts.md`
- [ ] `docs/reference/docker-resources.md`
- [ ] `docs/reference/project-structure.md`

### Explanation (learning, theoretical)
- [ ] Move `docs/architecture.md` to `docs/explanation/architecture.md`
- [ ] `docs/explanation/security-model.md`
- [ ] `docs/explanation/container-lifecycle.md`
- [ ] `docs/explanation/design-decisions.md`

### README
- [ ] Add GIF/screenshot of core workflow at top
- [ ] Slim down — move detailed sections into docs/ tree
- [ ] Add link grid to docs/ structure

## Phase 4: MCP Server Enhancements

Extend the MCP server with deeper Obsidian integration.

### Plugin API Integrations
- [ ] Dataview queries (`vault_dataview_query` tool)
- [ ] Templater note creation (`vault_templater_create` tool)
- [ ] Tasks plugin integration (`vault_tasks_list`, `vault_tasks_toggle`)
- [ ] Periodic Notes (`vault_daily`, `vault_weekly`)
- [ ] Canvas manipulation
- [ ] New "Extensions" permission tier for plugin-dependent tools

### Additional Core Tools
- [ ] `vault_search_fuzzy` — fuzzy search using Obsidian's prepareFuzzySearch
- [ ] `vault_properties` — list all properties across vault with counts
- [ ] `vault_recent` — recently modified files
- [ ] `vault_graph_neighborhood` — links within N hops of a file

### Infrastructure
- [ ] MCP server status in status bar tooltip
- [ ] Auto-restart MCP server on tier setting changes
- [ ] Health check endpoint for container to verify MCP is alive

## Phase 5: UX & Integration Depth

Deeper Obsidian integration and workflow improvements.

### Obsidian Integration
- [ ] File context menu — "Analyze in Sandbox" (right-click a note)
- [ ] Agent output sync (watch agent-workspace/ for new files, notify user)
- [ ] URI handler (`obsidian://agent-sandbox/open-terminal`)
- [ ] Quick Switcher integration for terminal tabs

### Container Improvements
- [ ] Container ID verification (prevent connecting to wrong container)
- [ ] Port conflict pre-flight check
- [ ] Firewall state polling (detect out-of-band changes)
- [ ] Session cleanup / garbage collection for stale tmux sessions

### Terminal Polish
- [ ] Clipboard auto-copy opt-out setting
- [ ] Connection retry with exponential backoff
- [ ] Startup progress indicator (elapsed time or step description)

## Phase 6: Community Plugin Submission

Prepare for the official Obsidian community plugin directory.

- [ ] Remove `--prerelease` flag from release workflow
- [ ] Ensure manifest.json meets community requirements
- [ ] Final documentation pass
- [ ] Submit PR to `obsidianmd/obsidian-releases`
- [ ] Add root-level manifest.json if required by community review process
- [ ] Respond to review feedback

## Completed

- [x] Windows Local Docker mode (buildLocalWindowsCommand)
- [x] MCP server with granular vault permissions (22 tools, 5 tiers)
- [x] MCP security hardening (path traversal, timing-safe auth, body limit, try-catch)
- [x] MCP settings tab (4th tab with server config + permission toggles)
- [x] MCP manual testing checklist (sections 21-30)
- [x] Code review and simplification (/simplify pass)
- [x] Real error messages in Docker error handlers (user-friendly notices + console detail)
