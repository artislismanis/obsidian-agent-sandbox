# Testing

Three layers of automated tests plus a short manual checklist for things that require human judgment or cross-process workflows. If a behavior is covered by the automated suites, fix the code, don't re-verify by hand.

## Quick reference

```bash
cd plugin
npm install               # one-time, installs all test tooling

npm run test              # Layer 1 — unit tests              (~1.5s,   no deps)
npm run test:integration  # Layer 2 — container integration   (~30s,    needs Docker)
npm run test:e2e          # Layer 3 — real Obsidian UI        (~25s,    needs display / xvfb)
npm run test:e2e:headless # same as above but wrapped in xvfb-run
npm run check             # lint + format:check + tsc + unit tests with coverage (run before committing)
```

Exit code `0` means the suite passed. Any non-zero code = one or more failures. Vitest and WebDriverIO both print a per-test summary at the end.

## Prerequisites

### All layers

- **Node.js 24+** and **npm 10+**
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
- **Built plugin artifacts** — run `npm run build` before `npm run test:e2e`; `dist/main.js`, `dist/manifest.json`, `dist/styles.css` must exist before the suite launches Obsidian

On first run, wdio downloads Obsidian from GitHub releases into `plugin/.obsidian-cache/`. Network errors are transient; retry.

## Running the suites

### Layer 1 — unit tests

```bash
npm run test              # one-shot
npm run test:watch        # vitest watch mode
```

No Docker, no Obsidian, no network. Covers pure logic: validators, shell escaping, ttyd polling, MCP auth + path traversal, tool handlers, status bar state machines. Runs in under 2 seconds and should always pass locally.

The suite ends with a vitest summary listing all test files as `passed`. Any non-zero exit is a real failure — investigate the stack trace.

### Layer 2 — integration tests

```bash
npm run test:integration
```

All four integration spec files share **one** container, brought up once by `test/integration/globalSetup.ts` and torn down at the end. This keeps the suite to ~30 seconds. Tests are serialized (`fileParallelism: false`, `sequence.concurrent: false`) to avoid `docker exec` races.

Skip behavior: if Docker isn't running or `oas-sandbox:latest` isn't built, all tests are marked `skipped` and the process exits 0. Look for `[integration] Docker unavailable — tests will skip` in the output.

The suite finishes with a vitest summary; either every spec passes or every spec is skipped (when Docker is unavailable). Mixed pass/skip is fine — Claude Code subsuite skips when seeded auth is absent.

The test harness uses an isolated Docker Compose project (`oas-test` prefix) so it never touches your real `oas-sandbox` container, volumes, or network.

### Layer 3 — end-to-end (real Obsidian)

```bash
npm run test:e2e             # local dev (needs a display)
npm run test:e2e:headless    # CI / SSH (wraps in xvfb-run)
```

Each spec file launches its own fresh Obsidian instance against an ephemeral copy of `test/e2e/vaults/simple/`. The `wdio-obsidian-service` installs the built `dist/` as a plugin and enables it automatically.

A full run prints a per-spec summary followed by the wdio total — every spec file should report `passed` and `100% completed`. Failures are flagged with the offending selector or assertion.

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
2. Before running Claude tests, `seedClaudeAuth()` copies this volume into the test's external `oas-test-claude-config` volume (declared `external: true` in `docker-compose.test.yml`, so no compose project prefix) via a throwaway alpine container.
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

| Suite | Path | What's covered |
|-------|------|----------------|
| **Unit** | `src/__tests__/*.test.ts` | Input validation (write dir, private hosts, memory, CPUs, bind address, memory file name, path-prefix lists; numeric range checks like port / font size / scrollback are inline in `settings.ts` via `addNumberSetting` rather than a named validator), WSL + Windows shell escaping (incl. `$`/backtick neutralisation), WSL path conversion, env var injection, `parseIsRunning` state machine, ttyd polling / URL construction, status bar state transitions, firewall status bar, timing-safe MCP auth, path traversal protection, every MCP tool handler |
| **Integration** | `test/integration/*.test.ts` | Container health + `verify.sh`, vault ro/rw mounts + mount isolation, narrow sudo scope + `OAS_SUDO_PASSWORD` unset after drop-privileges, MCP env var injection, MCP HTTP auth / routing / CORS, Docker resource naming (`oas-test` prefix), firewall enable / allowlist / disable, tmux session create + list + persist, ttyd port remapping, Claude Code auth + `claude -p` execution + memory MCP tool use + filesystem `Read` tool |
| **E2E** | `test/e2e/specs/*.e2e.ts` | Plugin loads and is enabled, ribbon icon present, status bar renders, all commands registered, settings tabs render, MCP permission tiers visible with correct defaults, MCP token auto-generates and regenerates, numeric/text setting validation adds/removes `sandbox-input-error` class, bind address security warning toggles dynamically, per-setting "Requires container restart" labels appear on restart-needing settings only |

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

## Security and stress smoke

Two host-runnable bash scripts cover the shell-verifiable scenarios from `qa-test-plan.md`. Requires: live container, a test vault, and `jq` on the host.

**`container/test-scripts/security-checks.sh`** — Stage 7 (symlink/path-traversal boundary), Stage 8 (firewall egress, list-sources tagging, MCP path isolation), and Stage 9 tool-bug regression probes (string→bool/number coercion, periodic-note default, canvas changes validation). Firewall must be enabled with `example.com` in Additional firewall domains.

```bash
bash container/test-scripts/security-checks.sh /path/to/test-vault
# Firewall-off egress probe (toggle firewall off in Obsidian first):
bash container/test-scripts/security-checks.sh /path/to/test-vault --firewall-off
```

**`container/test-scripts/stress-checks.sh`** — Stage 12 stress scenarios: unicode vault path, large-file read (~5 MB), oas-test-* teardown debris check. The daemon-stop probe (`--with-daemon-stop`) is host-disruptive and optional for routine runs.

```bash
bash container/test-scripts/stress-checks.sh /path/to/test-vault
# Daemon-stop probe (stops and restarts Docker):
bash container/test-scripts/stress-checks.sh /path/to/test-vault --with-daemon-stop
```

Both scripts complement but do not replace the `mcp-capability-test.md` cell sweep. Stage 7 bodies are in `qa-test-plan.md` for reference; Stage 9 is reduced to one human-only scenario (9.3 Tasks recurring semantics); Stage 12 UI-bound scenarios (12.4–12.6, 12.7) remain in the QA plan.

## Manual test scenarios

End-to-end manual scenarios — things that need human judgment, interactive LLM use, cross-process workflows, or specific hardware — live in [qa-test-plan.md](./qa-test-plan.md). That plan is organised by setup cost (Stage 0 prerequisites → Stage 12 stress/recovery) so you can run it top-to-bottom on a fresh machine, or jump to a single stage when verifying a focused change.

For an exhaustive sweep of the MCP tool surface (every read/write/manage/extensions tool, gating behaviour, error shapes), hand [mcp-capability-test.md](./mcp-capability-test.md) to an in-container Claude Code session — it drives the run itself and emits a matrix-format report. Run it whenever the tool surface changes or as part of release validation; `qa-test-plan.md` Stage 3 cells matrix defines the six permission configurations to run it under.

Run the automated suites here first; only fall through to the QA plan or the MCP capability plan for behaviour the harness genuinely can't reach (see "What's NOT covered" above for the canonical list of gaps).

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
docker volume rm oas-test-claude-config oas-test_oas-test-shell-history
docker network rm oas-test_default
```
