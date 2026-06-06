# CLAUDE.md: Obsidian Plugin Development

## Build and test

```bash
npm install          # Install dependencies
npm run build        # Type-check + bundle (produces dist/main.js)
npm run check        # Lint + format check + type-check + tests (run this before committing)
npm run dev          # Watch mode for development
npm run test         # Run tests only
npm run lint:fix     # Auto-fix lint issues
npm run format       # Auto-format code
```

Pre-commit hooks run `lint-staged` (eslint --fix + prettier) on staged files automatically.

## Architecture

Hub-and-spoke. `main.ts` orchestrates leaf modules; a few small shared utilities cross-cut.

```
main.ts (Plugin entry, commands, lifecycle, context menu, firewall toggle)
├── settings.ts          : Settings interface + tabbed UI (General/Terminal/Advanced/MCP)
├── docker.ts            : DockerManager runs WSL → docker compose commands + firewall
├── status-bar.ts        : StatusBarManager + FirewallStatusBar, state + composed tooltip
├── terminal-view.ts     : TerminalView, xterm.js + WebSocket to ttyd
├── ttyd-client.ts       : Pure functions, polling, auth token, URL building
├── analyse.ts           : AnalyseManager, prompt-template runner for "Analyse in Sandbox"
├── session-ui.ts        : Session picker / cleanup modals
├── modals.ts            : confirmModal / inputModal helpers (reused across modules)
├── activity.ts          : ActivityUi (per-session prefix routing) + AgentOutputNotifier
├── diff-review-modal.ts : DiffReviewModal + BatchReviewModal for reviewed writes
├── mcp-server.ts        : ObsidianMcpServer, HTTP+SSE transport, auth, session lifecycle
├── mcp-lifecycle.ts     : McpLifecycle, queue, start/stop/toggle, apply/restart wiring
├── mcp-rate-limiter.ts  : RateLimiter, per-tool sliding-window rate limiter
├── mcp-audit.ts         : AuditEntry / AuditLog / createFileAuditSink, JSONL audit trail
├── mcp-sse.ts           : startSseKeepalive, SSE keepalive to prevent proxy timeouts
├── mcp-tools.ts         : buildTools(), all read/write/manage MCP tools
├── mcp-extensions.ts    : Extensions tier, Dataview / Templater / Tasks / Canvas / Periodic Notes
├── mcp-cache.ts         : VaultCache, graph + tag/property counts, invalidated on metadata `resolved`
├── permission-tiers.ts  : Tier metadata + reviewsRequired() / vaultWriteTiers() derivations
├── prompt-template.ts   : Tiny template-string interpolator used by analyse.ts
├── templater-adapter.ts : Templater plugin probe + folder-template resolution
├── obsidian-internals.ts : Centralised casts for unstable Obsidian internals
├── view-types.ts        : VIEW_TYPE_TERMINAL constant (shared between activity.ts and terminal-view.ts to avoid a cycle)
├── validation.ts        : Shared input validators (used by settings.ts, docker.ts, mcp-*.ts)
├── format.ts            : formatUptime, container "Up: 1h 30m" rendering for status notices
└── logger.ts            : Levelled logger + errMsg() helper
```

`main.ts` wires the leaves together. Most leaves are independent, but a few have intentional in-tree dependencies. For example, `mcp-tools.ts` re-exports `gateVaultWrite` to `mcp-extensions.ts`, `activity.ts` uses `view-types.ts` to talk about terminal leaves without importing `terminal-view.ts`, and several MCP modules share `obsidian-internals.ts`. `validation.ts` and `logger.ts` are leaf-of-leaves, used everywhere.

## Key patterns

- **Settings reactivity**: DockerManager and TerminalView accept `() => Settings` getter functions, not snapshots. Settings changes in the UI take effect immediately.
- **Generation counter**: TerminalView uses an incrementing counter to prevent race conditions when the view is rapidly closed/reopened. Each async operation checks if its generation is still current.
- **Shell escaping**: `buildWslCommand()` in docker.ts handles both bash single-quote escaping and cmd.exe double-quote escaping. Distro names are validated against `/^[\w][\w.-]*$/`.
- **ttyd protocol**: Binary WebSocket frames with ASCII command prefix. Directions are asymmetric: `'0'` carries OUTPUT (server→client) and INPUT (client→server); `'1'` carries TITLE_CHANGED (server→client) and RESIZE (client→server); `'2'` is SET_PREFERENCES (server→client, ignored by this client). The plugin only consumes inbound OUTPUT: title/preferences are dropped. Connection requires `['tty']` subprotocol and a JSON handshake with `{columns, rows}` on open. Uses Obsidian's `requestUrl` for HTTP polling (bypasses CORS) and native WebSocket for the terminal stream. No authentication: security relies on the bind address (127.0.0.1 by default).
- **Clipboard**: Auto-copies on text selection via `onSelectionChange`. Paste via `Ctrl+Shift+V`.
- **Vault path injection**: Plugin auto-detects vault path via `FileSystemAdapter.getBasePath()`, converts Windows→WSL format via `windowsToWslPath()`, and passes `OAS_VAULT_HOST_PATH` env var to all docker compose commands.
- **Container lifecycle**: `DockerManager.start()` runs `docker compose up -d` only; compose's own idempotency reconciles config changes (reuses the running container when env vars match, recreates when they differ). `restart()` is the explicit `down` + `up -d` escape hatch for forcing a clean recreate. `stop()` and `stopDetached()` both run `docker compose down`. `main.ts` gates terminal-leaf detachment on `DockerManager.parseIsRunning()` at layout-ready so persisted terminal tabs can re-attach to a still-running container after Obsidian reopens.
- **Multiple terminals**: Each "Open Sandbox Terminal" creates an independent terminal tab with its own WebSocket connection and unique instance ID. Terminals open at the bottom via horizontal split.
- **Debounced save**: Settings saves are debounced to 500ms and flushed on plugin unload.

## Testing

Three automated layers. See `docs/testing.md` for full setup, prerequisites, and coverage.

| Layer | Command | Time | Dependencies |
|-------|---------|------|--------------|
| Unit (`src/__tests__/`) | `npm run test` | ~1.5s | none |
| Integration (`test/integration/`) | `npm run test:integration` | ~30s | Docker + built `oas-sandbox:latest` |
| E2E (`test/e2e/specs/`) | `npm run test:e2e` / `test:e2e:headless` | ~25s | Obsidian (auto-downloaded); display or xvfb |

Vitest unit test files (`npm run test`) live in `src/__tests__/`: one `*.test.ts` per module under test (`ls src/__tests__/`), plus `fixtures.ts` for shared mock app / TFile builders. Each test file mirrors its source module's name; add a new test by copying an adjacent file's setup.

Integration tests share one `oas-test-sandbox` container via `globalSetup.ts`. The container is isolated from your live `oas-sandbox` via the `oas-test` compose project prefix. Claude-Code subsuite seeds auth from the live `oas_oas-claude-config` volume when present (see `docs/testing.md` for setup), otherwise skips.

E2E tests use `wdio-obsidian-service`. Each spec launches a fresh Obsidian against an ephemeral copy of `test/e2e/vaults/simple/`.

**Running e2e as an AI agent:** the suite spawns Electron/Chromium, which needs to write `/dev/shm` and `~/.config`. A restricted command-sandbox blocks those writes, so the run dies with `session not created: Chrome instance exited` even though every dependency is present (`--no-sandbox` does not help — it only disables Chromium's own sandbox, not the outer one). Run `npm run test:e2e:headless` with the command-sandbox disabled, or in a normal (unsandboxed) shell. Prerequisites and a fuller troubleshooting note live in `docs/testing.md`.

The Obsidian API-dependent modules (main.ts, settings.ts, terminal-view.ts) are not unit tested: they would require mocking Plugin, ItemView, WorkspaceLeaf, etc. Instead they're exercised end-to-end by the e2e suite. Keep pure logic in testable modules (docker.ts, ttyd-client.ts, status-bar.ts, validation.ts, mcp-*.ts).

## Conventions

- TypeScript strict mode enabled
- ESLint with typescript-eslint (flat config)
- Prettier: tabs, semicolons, double quotes, trailing commas, 100 char width
- Type-only imports enforced: `import type { Foo }` not `import { Foo }`
- No `console.log` in production code (ESLint warns)
- Obsidian API externalised in esbuild, never bundled

## Key files for common tasks

| Task | Files |
|------|-------|
| Add a new setting | `src/settings.ts` (interface + default + UI) |
| Add a new command | `src/main.ts` (register in `onload()`) |
| Change Docker command behaviour | `src/docker.ts` |
| Change terminal connection logic | `src/ttyd-client.ts` + `src/terminal-view.ts` |
| Change status bar display | `src/status-bar.ts` |
| Add a test | `src/__tests__/` (follow existing patterns) |

## Deployment

`npm run build` produces a ready-to-install `dist/` folder containing `main.js` (minified, all dependencies bundled), `manifest.json`, and `styles.css`. Copy the contents of `dist/` to the vault's `.obsidian/plugins/obsidian-agent-sandbox/` directory. The `styles.css` includes the full xterm.js base styles; Obsidian loads it automatically.
