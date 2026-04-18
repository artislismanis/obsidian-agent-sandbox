# Testing

The project is covered by three layers of automated tests plus a short manual checklist for things that require human judgment or cross-process workflows. Run the automated suites first — if a behavior is covered, fix the code, don't re-verify by hand.

## Quick reference

```bash
cd plugin
npm install               # one-time, installs all test tooling

npm run test              # Layer 1 — unit tests              (~1.5s,   no deps)
npm run test:integration  # Layer 2 — container integration   (~30s,    needs Docker)
npm run test:e2e          # Layer 3 — real Obsidian UI        (~25s,    needs display / xvfb)
npm run test:e2e:headless # same as above but wrapped in xvfb-run
npm run check             # lint + format:check + tsc + unit tests (run before committing)
```

Exit code `0` means the suite passed. Any non-zero code = one or more failures. Vitest and WebDriverIO both print a per-test summary at the end.

## Prerequisites

### All layers

- **Node.js 20+** and **npm 10+**
- From `plugin/`: `npm install` (installs vitest, wdio, esbuild, eslint, prettier)

### Integration tests (Layer 2)

- **Docker Engine** running and reachable via `docker info`
- **Image built:** `cd container && docker compose build` (or let CI build it)
  - Helpers check for `oas-sandbox:latest` and skip the whole suite if missing
- **Ports 17681 (ttyd) and 38080 (MCP)** free on `127.0.0.1` — the test compose remaps away from production defaults so it can run alongside a live container
- **Optional — Claude Code auth seeding:** to run the `claude-code.test.ts` subsuite you need a live `oas_oas-claude-config` Docker volume. See "Claude Code authentication" below. Without it the Claude tests skip; everything else still runs.

### E2E tests (Layer 3)

- **Obsidian desktop** — `wdio-obsidian-service` downloads it automatically the first time, cached in `plugin/.obsidian-cache/`
- **A display server** — locally any X/Wayland session works; in CI or SSH use `npm run test:e2e:headless` which wraps the runner in `xvfb-run`
- **Built plugin artifacts** — the `pretest:e2e` npm hook runs `npm run build` automatically; `dist/main.js`, `dist/manifest.json`, `dist/styles.css` must exist before the suite launches Obsidian

On first run, wdio will download Obsidian from GitHub releases. If you see a 504 or network error, just retry — the download is resumable and transient GitHub failures are common.

## Running the suites

### Layer 1 — unit tests

```bash
npm run test              # one-shot
npm run test:watch        # vitest watch mode
```

No Docker, no Obsidian, no network. Covers pure logic: validators, shell escaping, ttyd polling, MCP auth + path traversal, tool handlers, status bar state machines. Runs in under 2 seconds and should always pass locally.

Expected output ends with:

```
 Test Files  8 passed (8)
      Tests  184 passed (184)
```

### Layer 2 — integration tests

```bash
npm run test:integration
```

All four integration spec files share **one** container, brought up once by `test/integration/globalSetup.ts` and torn down at the end. This keeps the suite to ~30 seconds. Tests are serialized (`fileParallelism: false`, `sequence.concurrent: false`) to avoid `docker exec` races.

Skip behavior: if Docker isn't running or `oas-sandbox:latest` isn't built, all tests are marked `skipped` and the process exits 0. Look for `[integration] Docker unavailable — tests will skip` in the output.

Expected output ends with:

```
 Test Files  4 passed (4)
      Tests  40 passed (40)
```

Or, when Docker is unavailable:

```
 Test Files  4 skipped (4)
      Tests  40 skipped (40)
```

The test harness uses an isolated Docker Compose project (`oas-test` prefix) so it never touches your real `oas-sandbox` container, volumes, or network.

### Layer 3 — end-to-end (real Obsidian)

```bash
npm run test:e2e             # local dev (needs a display)
npm run test:e2e:headless    # CI / SSH (wraps in xvfb-run)
```

Each spec file launches its own fresh Obsidian instance against an ephemeral copy of `test/e2e/vaults/simple/`. The `wdio-obsidian-service` installs the built `dist/` as a plugin and enables it automatically.

Expected output for a full run:

```
» test/e2e/specs/smoke.e2e.ts
  8 passing
» test/e2e/specs/settings.e2e.ts
  10 passing

Spec Files:	 2 passed, 2 total (100% completed) in 00:00:25
```

To run a single spec file:

```bash
npx wdio run ./wdio.conf.mts --spec test/e2e/specs/settings.e2e.ts
```

Test matrix — set `OBSIDIAN_VERSIONS` to target multiple versions:

```bash
OBSIDIAN_VERSIONS="latest/latest earliest/earliest" npm run test:e2e
```

### Claude Code authentication for integration tests

The Claude Code tests in `test/integration/claude-code.test.ts` need an authenticated subscription. Rather than burning API tokens, they **borrow auth from your live container** if available.

How it works:

1. Your live container's auth lives in the `oas_oas-claude-config` Docker volume (created the first time you run `claude` and complete the login flow inside your real sandbox). The `oas_` prefix is docker-compose's project name.
2. Before running Claude tests, `seedClaudeAuth()` copies this volume into the test project's `oas-test_oas-test-claude-config` volume via a throwaway alpine container.
3. `docker compose down -v` at teardown removes only the test volume — your live auth is never touched and never mutated.

If the live volume doesn't exist (you haven't used Claude inside the sandbox yet), these tests **skip gracefully** rather than fail. To enable them:

```bash
# In your live sandbox (not the test one), authenticate once:
cd container
docker compose up -d
docker compose exec sandbox claude
# Complete the login flow, then exit. Auth is persisted in the volume.
```

After that, `npm run test:integration` will include the four Claude tests (`claude --version`, basic prompt, memory MCP tool use, filesystem `Read` tool).

## Coverage by suite

| Suite | Path | Tests | What's covered |
|-------|------|-------|----------------|
| **Unit** | `src/__tests__/*.test.ts` | 184 | Input validation (write dir, private hosts, memory, CPUs, bind address, port), WSL + Windows shell escaping, WSL path conversion, env var injection, `parseIsRunning` state machine, ttyd polling / URL construction, status bar state transitions, firewall status bar, timing-safe MCP auth, path traversal protection, all 22 MCP tool handlers |
| **Integration** | `test/integration/*.test.ts` | 40 | Container health + `verify.sh`, vault ro/rw mounts + mount isolation, narrow sudo scope + `SUDO_PASSWORD` unset after drop-privileges, MCP env var injection, MCP HTTP auth / routing / CORS, Docker resource naming (`oas-test` prefix), firewall enable / allowlist / disable, tmux session create + list + persist, ttyd port remapping, Claude Code auth + `claude -p` execution + memory MCP tool use + filesystem `Read` tool |
| **E2E** | `test/e2e/specs/*.e2e.ts` | 18 | Plugin loads and is enabled, ribbon icon present, status bar renders, 9 commands registered, 4 settings tabs render, 5 MCP permission tiers visible with correct defaults, MCP token auto-generates and regenerates, font size + scrollback + MCP port validation adds/removes `sandbox-input-error` class, bind address `0.0.0.0` security warning toggles dynamically, per-setting "Requires restart" labels appear on restart-needing settings only |

## What's NOT covered (and why)

Some scenarios can't be reliably automated in this harness:

- **Settings persistence across full Obsidian restart** — `wdio-obsidian-service` uses an ephemeral vault copy per launch, so `data.json` is wiped between sessions. The in-memory save path is covered by validation tests; durable persistence is Obsidian's responsibility.
- **Plugin disable/enable cycle via the UI** — after `disablePluginAndSave`, the service's plugin files are no longer on disk in a re-loadable state, so re-enable fails with ENOENT. This is a harness limitation. Unload cleanup is covered by unit tests on `StatusBarManager.destroy()`, `FirewallStatusBar.destroy()`, etc.
- **Interactive Claude conversations against the plugin's running MCP server** — integration tests cover `claude -p` against memory + filesystem MCP servers, but the plugin's own Obsidian MCP server needs a real Obsidian instance listening. See the manual checklist below.
- **Cross-platform Docker edges (WSL path conversion, Rancher Desktop, Docker Desktop on Windows)** — shell escaping and path conversion are unit-tested, but the full round-trip through `wsl.exe` / Docker Desktop only runs on actual Windows hosts.
- **Visual rendering** — xterm themes, status bar icons, font fallback, terminal resize. Xvfb can't judge "does it look right".

## Interpreting failures

- **Unit failure** → almost always a real bug in the code under test. Stack trace points to the assertion and source line.
- **Integration failure** → usually either (a) the container is unhealthy (check `docker logs oas-test-sandbox`), (b) a port conflict on 17681/38080, or (c) a real regression. The helpers dump container logs + compose status on health-check timeouts.
- **E2E failure** → typically a selector issue (DOM structure changed), a timing issue (bump the `pause()` or `waitForExist` timeout), or the build artifacts are stale (re-run `npm run build`).
- **First-run e2e 504** → GitHub release download for Obsidian failed transiently. Re-run; the launcher retries with exponential backoff and caches on success.

## Running in CI

A typical CI job looks like:

```yaml
- run: cd plugin && npm ci
- run: cd plugin && npm run check          # lint + format + unit
- run: cd container && docker compose build
- run: cd plugin && npm run test:integration
- run: cd plugin && npm run test:e2e:headless
```

Cache `plugin/.obsidian-cache/` by the key printed at the start of an e2e run (`obsidian-cache-key: [...]`).

---

## Manual-only checklist

These require human judgment, interactive LLM use, cross-process workflows, or environment-specific hardware that can't be reproduced in the automated harness.

### Environment prerequisites (one-time per machine)

- [ ] WSL2 with Docker Engine and mirrored networking, OR Rancher Desktop / Docker Desktop with dockerd
- [ ] `http://localhost:7681` reachable from both Obsidian and a host browser
- [ ] Plugin installed in Obsidian vault (copy `dist/` to `.obsidian/plugins/obsidian-agent-sandbox/`)

> Claude Code authentication inside the container is **automatically verified** by the integration suite whenever the live `oas_oas-claude-config` volume exists. See "Claude Code authentication" above for the one-time login.

### Visual rendering

- [ ] Terminal themes: Follow Obsidian / Dark / Light all look correct
- [ ] Custom font family renders when installed on system
- [ ] Status bar icons (⏹/⏳/▶/⚠/🔍, 🛡️) display correctly
- [ ] Terminal resize: drag pane edge, content reflows cleanly
- [ ] No unexpected errors in Obsidian DevTools (Ctrl+Shift+I) during a full session

### Interactive Claude Code against the live Obsidian MCP server

The integration suite covers `claude -p` against memory and filesystem MCP servers. These manual tests cover the **plugin's own Obsidian MCP server** (which only listens when the real plugin is running in Obsidian).

**Setup:**
1. Container running: sandbox terminal open and healthy
2. Obsidian plugin enabled with MCP turned on (Settings → Agent Sandbox → MCP)
3. Claude authenticated inside the container (see one-time setup above)

#### Available MCP tools are announced

**Actions:** Inside the container: `claude -p "What MCP tools do you have?"`

**Expected:** Response lists `mcp__obsidian__vault_search`, `mcp__obsidian__vault_read`, and other `vault_*` tools.

#### Vault search

**Actions:** `claude -p "Search my vault for [a term that exists in a note]"`

**Expected:** Claude calls `vault_search` and returns file paths with matching snippets.

#### Create a note (Write Scoped tier)

**Actions:** `claude -p "Create a file called agent-workspace/hello.md containing the text Hello world"`

**Expected:** `hello.md` appears under the write directory in Obsidian's file explorer.

#### Open a file in the editor (Navigate tier)

**Setup:** Navigate tier must be enabled in MCP settings.

**Actions:** `claude -p "Open Welcome.md in the editor"`

**Expected:** The file opens as the active tab in Obsidian.

#### Rename a file (Manage tier)

**Setup:** Manage tier must be enabled in MCP settings. A file `test-rename.md` exists.

**Actions:** `claude -p "Rename test-rename.md to test-renamed.md"`

**Expected:** File is renamed in Obsidian; any wikilinks pointing to it are updated.

#### Tier disable removes tools

**Actions:**
1. Disable the "Write Scoped" tier in MCP settings, toggle MCP off then on
2. `claude -p "What MCP tools do you have?"`

**Expected:** `vault_create` and other writeScoped tools no longer appear in the response.

---

### Obsidian close/restart lifecycle

These span process boundaries (full Obsidian close, not `browser.reloadObsidian`).

#### Auto-stop off: container survives Obsidian close

**Setup:** Auto-stop disabled in plugin General settings.

**Actions:** Note the container ID in the status bar, then close Obsidian completely.

**Expected:** `docker ps` still shows `oas-sandbox` running with the same container ID.

#### Auto-stop on: container stops on Obsidian close

**Setup:** Auto-stop enabled in plugin General settings.

**Actions:** Close Obsidian completely.

**Expected:** Container stops within ~10 seconds (`docker ps` shows no `oas-sandbox`).

#### Reopen Obsidian attaches to running container

**Setup:** Auto-stop off, container running.

**Actions:** Close and reopen Obsidian.

**Expected:** Status bar shows Running immediately; same container ID as before.

#### Config change triggers container recreate

**Actions:** Change the Write Directory setting, then click Start (or restart).

**Expected:** A new container ID appears in the status bar (old container was replaced).

#### Plugin disable stops the container

**Actions:** Disable the plugin via Settings → Community Plugins.

**Expected:** Container stops regardless of the auto-stop setting.

#### Settings persist across Obsidian reload

**Actions:**
1. Settings → Agent Sandbox → Terminal → change Font size to 18
2. Close and reopen Obsidian

**Expected:** Settings → Agent Sandbox → Terminal still shows font size 18.

#### Plugin survives disable/enable cycle

**Actions:**
1. Settings → Community Plugins → disable "Agent Sandbox"
2. Re-enable it

**Expected:** Plugin loads cleanly — ribbon icon appears, all 9 commands are registered, no console errors.

---

### Cross-platform edges

#### Windows + WSL: vault path conversion

**Setup:** Windows host, WSL2 Docker mode, vault at `C:\vault`.

**Actions:** Start the container.

**Expected:** Inside the container, `$PKM_VAULT_PATH` resolves to `/mnt/c/vault`; no WSL terminal window flashes during start/stop.

#### Rancher Desktop: path with spaces

**Setup:** Rancher Desktop on Windows, compose path contains a space (e.g. `C:\My Folder\container`).

**Actions:** Start the container.

**Expected:** Container starts without path errors; Windows backslash paths in the compose file resolve correctly.

---

### Sudo password override

**Setup:** Plugin installed, container not yet running.

**Actions:**
1. Set a custom sudo password in Settings → Agent Sandbox → General (Advanced)
2. Click Restart (forces container recreate)
3. Open a terminal, run `sudo echo test` with the new password

**Expected:** `sudo` accepts the new password. Restarting with an empty password effectively disables `sudo`.

---

---

## Teardown

```bash
cd container
docker compose down
# To also remove named volumes:
# docker compose down -v
```

The integration harness cleans up its own `oas-test-*` resources automatically via `globalSetup.ts`, even on crash — so you don't normally need to touch test containers/volumes manually. If something gets wedged:

```bash
docker rm -f oas-test-sandbox
docker volume rm oas-test_oas-test-claude-config oas-test_oas-test-shell-history
docker network rm oas-test_default
```
