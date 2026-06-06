# Testing

Three layers of automated tests plus a short manual checklist for things that require human judgement or cross-process workflows. If a behaviour is covered by the automated suites, fix the code, don't re-verify by hand.

## Quick reference

```bash
cd plugin
npm install               # one-time, installs all test tooling

npm run test              # Layer 1: unit tests               (~1.5s,   no deps)
npm run test:integration  # Layer 2: container integration    (~30s,    needs Docker)
npm run test:e2e          # Layer 3: real Obsidian UI         (~25s,    needs display / xvfb)
npm run test:e2e:headless # same as above but wrapped in xvfb-run (includes the Docker-free bridge spec)
npm run test:e2e:bridge   # Layer 3b: bridge container tier   (~10s,    needs display + Docker)
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
- **Ports 17681 (ttyd) and 38080 (MCP)** free on `127.0.0.1`. The test compose remaps away from production defaults so it can run alongside a live container.
- **Optional, Claude Code auth seeding:** to run the `claude-code.test.ts` subsuite you need a live `oas_oas-claude-config` Docker volume. See "Claude Code authentication" below. Without it the Claude tests skip; everything else still runs.

### E2E tests (Layer 3)

- **Obsidian desktop**: `wdio-obsidian-service` downloads it on first run, cached in `plugin/.obsidian-cache/`
- **A display server**: locally any X/Wayland session works; in CI or SSH use `npm run test:e2e:headless`, which wraps the runner in `xvfb-run`:
  ```bash
  # Ubuntu / Debian / WSL
  sudo apt install xvfb
  # macOS: not needed, Obsidian uses the native display
  ```
- **Native libraries for Electron/Chrome** (Linux/WSL only): the bundled Obsidian/chromedriver needs
  NSS and ALSA shared libs to launch, or the browser session fails with "Unable to connect to browser
  driver". macOS ships these.
  ```bash
  # Ubuntu / Debian / WSL (Ubuntu < 24.04: libasound2 instead of libasound2t64)
  sudo apt install libnss3 libnspr4 libasound2t64
  # Optional hygiene: silences a non-fatal "Could not load libsecret-1.so.0" warning
  # (Chromium dlopens it lazily for os_crypt; absence does NOT block launch).
  sudo apt install libsecret-1-0
  ```
  No Chromium sandbox flag is needed: `wdio-obsidian-service` already passes `--no-sandbox` on Linux.
- **Built plugin artifacts**: run `npm run build` before `npm run test:e2e`; `dist/main.js`, `dist/manifest.json`, `dist/styles.css` must exist before the suite launches Obsidian

On first run, wdio downloads Obsidian from GitHub releases into `plugin/.obsidian-cache/`. Network errors are transient; retry.

### Lint infrastructure (pre-push, one-time install)

Four host-side tools mirror the `lint-infra.yml` and `links.yml` CI jobs. Install once:

```bash
# shellcheck: shell script linter (in Ubuntu repos; brew install shellcheck on macOS)
sudo apt install shellcheck

# hadolint: Dockerfile linter (not in Ubuntu repos)
curl -sSL https://github.com/hadolint/hadolint/releases/latest/download/hadolint-Linux-x86_64 \
  -o /tmp/hadolint && chmod +x /tmp/hadolint && sudo mv /tmp/hadolint /usr/local/bin/hadolint
# brew install hadolint   # macOS

# actionlint: GitHub Actions workflow linter
bash <(curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash) \
  && sudo mv actionlint /usr/local/bin/
# brew install actionlint  # macOS

# lychee: markdown link checker
curl -sSL https://github.com/lycheeverse/lychee/releases/latest/download/lychee-x86_64-unknown-linux-gnu.tar.gz \
  | tar xz -C /tmp && sudo mv /tmp/lychee-x86_64-unknown-linux-gnu/lychee /usr/local/bin/
# brew install lychee      # macOS
```

Verify: `shellcheck --version && hadolint --version && actionlint --version && lychee --version`

## Running the suites

### Layer 1: unit tests

```bash
npm run test              # one-shot
npm run test:watch        # vitest watch mode
```

No Docker, no Obsidian, no network. Covers pure logic: validators, shell escaping, ttyd polling, MCP auth + path traversal, tool handlers, status bar state machines. Runs in under 2 seconds and should always pass locally.

The suite ends with a vitest summary listing all test files as `passed`. Any non-zero exit is a real failure: investigate the stack trace.

### Layer 2: integration tests

```bash
npm run test:integration
```

All four integration spec files share **one** container, brought up once by `test/integration/globalSetup.ts` and torn down at the end. This keeps the suite to ~30 seconds. Tests are serialised (`fileParallelism: false`, `sequence.concurrent: false`) to avoid `docker exec` races.

Skip behaviour: if Docker isn't running or `oas-sandbox:latest` isn't built, all tests are marked `skipped` and the process exits 0. Look for `[integration] Docker unavailable, tests will skip` in the output.

The suite finishes with a vitest summary; either every spec passes or every spec is skipped (when Docker is unavailable). Mixed pass/skip is fine: the Claude Code subsuite skips when seeded auth is absent.

The test harness uses an isolated Docker Compose project (`oas-test` prefix) so it never touches your real `oas-sandbox` container, volumes, or network.

### Layer 3: end-to-end (real Obsidian)

```bash
npm run test:e2e             # local dev (needs a display)
npm run test:e2e:headless    # CI / SSH (wraps in xvfb-run)
```

Each spec file launches its own fresh Obsidian instance against an ephemeral copy of `test/e2e/vaults/simple/`. The `wdio-obsidian-service` installs the built `dist/` as a plugin and enables it automatically.

A full run prints a per-spec summary followed by the wdio total. Every spec file should report `passed` and `100% completed`. Failures are flagged with the offending selector or assertion.

To run a single spec file:

```bash
npx wdio run ./wdio.conf.mts --spec test/e2e/specs/settings.e2e.ts
```

Test matrix: set `OBSIDIAN_VERSIONS` to target multiple versions:

```bash
OBSIDIAN_VERSIONS="latest/latest earliest/earliest" npm run test:e2e
```

### Layer 3b: bridge (real plugin MCP server, driven end-to-end)

The bridge specs drive the **real plugin's MCP server** running inside a wdio-launched Obsidian, then assert the resulting UI via `executeObsidian`. Two tiers:

```bash
# Docker-free: lives in test/e2e/specs/bridge.e2e.ts, runs with the normal e2e suite.
npm run test:e2e:headless

# Container tier: needs Docker + the oas-sandbox image. Brings up an isolated
# oas-test container so a container can call back into the host plugin's MCP server.
npm run test:e2e:bridge          # local dev (needs a display)
npm run test:e2e:bridge:headless # CI / SSH (xvfb)
```

- **Docker-free tier** (`bridge.e2e.ts`): the wdio worker POSTs MCP tool calls to the plugin's server over loopback (no container needed — the tools act on the Obsidian-open vault). Covers navigate→active-tab; the review modals end-to-end (approve/reject/rename-affected-links/batch); the awaiting-input badge and its multi-session / MCP-off clearing (3.11, 5.2, 5.4); the permission-tier matrix across six cells (3.1/3.2) asserted via `mcp_capabilities` + `tools/list` (navigate / manage / write-mode; the `extensions` tier needs its target plugins installed, so it stays in the capability sweep); auth lifecycle — token rotation and MCP-off connection drop (3.6, 3.7); graph-cache invalidation on a live edit (3.8); and a concurrent tool-call burst (3.9). It also carries a **fidelity** group: read-tier tools (`vault_search`, `vault_search_fuzzy`, `vault_backlinks`, `vault_graph_neighborhood`) run against the **real** Obsidian search scorer and metadata graph. Unit tests stub `prepareSimpleSearch`/`prepareFuzzySearch` and hand-populate `resolvedLinks`, so this is the only layer exercising real ranking and live graph resolution — fidelity coverage, not manual-QA conversion.
- **Container tier** (`wdio.bridge.conf.mts` → `test/e2e/container/bridge-container.e2e.ts`): brings up the isolated `oas-test` container and proves the host↔container MCP round-trip — the container reaches the plugin's MCP server (bound to `0.0.0.0`) via `host.docker.internal`, with bearer-token auth. Skips with exit 0 when Docker or the image is absent, like the integration suite. Settings don't persist in the harness (the plugin is loaded out-of-tree), so the bridge configures the MCP port/token/bind at runtime via `executeObsidian` + `restartMcpIfRunning`.

### Claude Code authentication for integration tests

The Claude Code tests in `test/integration/claude-code.test.ts` need an authenticated subscription. Rather than burning API tokens, they **borrow auth from your live container** if available.

How it works:

1. Your live container's auth lives in the `oas_oas-claude-config` Docker volume (created the first time you run `claude` and complete the login flow inside your real sandbox). The `oas_` prefix is docker-compose's project name.
2. Before running Claude tests, `seedClaudeAuth()` copies this volume into the test's external `oas-test-claude-config` volume (declared `external: true` in `docker-compose.test.yml`, so no compose project prefix) via a throwaway alpine container.
3. `docker compose down -v` at teardown removes only the test volume. Your live auth is never touched and never mutated.

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
| **Integration** | `test/integration/*.test.ts` | Container health + `verify.sh`, vault ro/rw mounts + mount isolation, host-uid ownership of container-written files in the write dir (3.10, Linux-gated), narrow sudo scope + `OAS_SUDO_PASSWORD` unset after drop-privileges, MCP env var injection, MCP HTTP auth / routing / CORS, Docker resource naming (`oas-test` prefix), named volumes (`oas-test-claude-config`, `oas-test-shell-history`, `oas-test-user-config`), native claude binary symlink layout, firewall enable / allowlist / disable, tmux session create + list + persist, ttyd port remapping, Claude Code auth + `claude -p` execution + memory MCP tool use + filesystem `Read` tool |
| **E2E** | `test/e2e/specs/*.e2e.ts` | Plugin loads and is enabled, ribbon icon present, status bar renders, the full set of all 12 commands registered, settings tabs render, MCP permission tiers visible with correct defaults, MCP token auto-generates and regenerates, numeric/text setting validation adds/removes `sandbox-input-error` class (incl. the vault-write-directory escape-path rejection), both ttyd and MCP bind-address security warnings toggle dynamically, per-setting "Requires container restart" labels appear on restart-needing settings only |
| **Bridge** | `test/e2e/specs/bridge.e2e.ts` (Docker-free), `test/e2e/container/bridge-container.e2e.ts` (Docker) | Drives the **real plugin's MCP server** in a wdio-launched Obsidian: navigate tool changes the active tab (3.5); review modals end-to-end — content-diff approve + reject, frontmatter JSON diff, rename affected-links list, batch checkboxes (4.1–4.5); awaiting-input badge + multi-session / MCP-off clearing (3.11, 5.2, 5.4); permission-tier matrix across six cells via `mcp_capabilities` + `tools/list` (3.1/3.2; navigate/manage/write-mode, extensions tier excepted — needs its target plugins); auth lifecycle — token rotation rejects the old token, MCP-off drops connections (3.6, 3.7); graph-cache invalidation on a live edit (3.8); a concurrent tool-call burst (3.9); plus fidelity coverage of read-tier search/graph tools against the real Obsidian scorer + metadata graph. Container tier proves the host↔container MCP round-trip: a live `oas-test` container reaches the host plugin's MCP server via `host.docker.internal`, bearer-token accepted/rejected, and a `vault_list` from the container returns the host vault's files |

## What's NOT covered (and why)

Some scenarios can't be reliably automated in this harness:

- **Settings persistence across full Obsidian restart** and **plugin disable/enable cycle via the UI** — both blocked by the same root cause: `wdio-obsidian-service` loads the built plugin **out-of-tree** (a diagnostic confirmed `<vault>/.obsidian/plugins/<id>/main.js` is absent even while the plugin is loaded and working at boot). Consequences: (a) in-session `saveData` never reaches `data.json`, and a `reloadObsidian()` reboot resets settings to defaults; (b) `enablePlugin()` after `disablePlugin()` is a silent no-op (no on-disk `main.js` to reload), so the plugin never returns. Both have a reproducible, skipped probe in `test/e2e/specs/harness-probe.e2e.ts` — un-skip and re-classify if a future service version installs the plugin on disk. Until then: durable persistence is Obsidian's own `saveData`/`loadData` responsibility (the in-memory save path is covered by validation tests), and unload cleanup is covered by unit tests on `StatusBarManager.destroy()`, `FirewallStatusBar.destroy()`, etc.
- **Interactive Claude *conversations* against the plugin's MCP server**: the bridge layer (Layer 3b) now drives the plugin's own MCP server end-to-end — over loopback and from a live container — so tool calls, review modals, the activity badge, the auth lifecycle, the cache, and the host↔container round-trip are automated, and the permission-tier **gating** (3.1/3.2) is a deterministic matrix test. What remains manual is a real multi-turn Claude **conversation** (LLM behaviour and judgement): the capability sweep (`mcp-capability-test.md`) checks that Claude picks the right tool and honours a denial, and recurring-task semantics (9.3).
- **Cross-platform Docker edges (WSL path conversion, Rancher Desktop, Docker Desktop on Windows)**: shell escaping and path conversion are unit-tested, but the full round-trip through `wsl.exe` / Docker Desktop only runs on actual Windows hosts.
- **Visual rendering**: xterm themes, status bar icons, font fallback, terminal resize. Xvfb can't judge "does it look right".

## Interpreting failures

- **Unit failure** → almost always a real bug in the code under test. Stack trace points to the assertion and source line.
- **Integration failure** → usually either (a) the container is unhealthy (check `docker logs oas-test-sandbox`), (b) a port conflict on 17681/38080, or (c) a real regression. The helpers dump container logs + compose status on health-check timeouts.
- **E2E failure** → typically a selector issue (DOM structure changed), a timing issue (bump the `pause()` or `waitForExist` timeout), or the build artifacts are stale (re-run `npm run build`).
- **First-run e2e 504** → GitHub release download for Obsidian failed transiently. Re-run; the launcher retries with exponential backoff and caches on success.
- **E2E `session not created: Chrome instance exited`** with every prerequisite present → the runner is inside a restricted seccomp/namespace sandbox (e.g. an AI coding-agent's command wrapper) that blocks Electron's `/dev/shm` and `~/.config` writes. `--no-sandbox` does not help — it only disables Chromium's own sandbox, not the outer one. Run the suite in a normal shell.

## Running in CI

Four GitHub Actions workflows run on every PR. To mirror them locally before pushing (run from repo root):

```bash
# check.yml: lint + format + type-check + unit tests + build + e2e
cd plugin && npm ci && npm run check && npm run build && npm run test:e2e:headless

# integration.yml: docker build + container integration suite
cd ../container && docker compose build
cd ../plugin && npm run test:integration

# lint-infra.yml: shellcheck + hadolint + actionlint
find container/scripts container/configs workspace/.claude \
    -type f \( -name '*.sh' -o -name '*.bash' \) | xargs shellcheck -S error
hadolint --config container/.hadolint.yaml container/Dockerfile
actionlint

# links.yml: lychee markdown link check (git ls-files avoids scanning .obsidian-cache/)
git ls-files '*.md' | xargs lychee --no-progress --max-concurrency 4 \
    --exclude '^https?://api\.github\.com/' \
    --exclude '^https?://github\.com/[^/]+/[^/]+/(issues|pull|discussions|commit)/' \
    --exclude '^https?://anthropic\.com/' \
    --exclude 'https?://claude\.ai/' \
    --accept 200,206,301,302,307,308
```

All four must exit 0 before pushing. See "Lint infrastructure" under Prerequisites for how to install `shellcheck`, `hadolint`, `actionlint`, and `lychee`.

Cache `plugin/.obsidian-cache/` by the key printed at the start of an e2e run (`obsidian-cache-key: [...]`).

---

## Security and stress smoke

Two host-runnable bash scripts cover the shell-verifiable scenarios from `qa-test-plan.md`. Requires: live container, a test vault, and `jq` on the host.

**`container/test-scripts/security-checks.sh`**: Stage 7 (symlink/path-traversal boundary), Stage 8 (firewall egress, list-sources tagging, MCP path isolation), and Stage 9 tool-bug regression probes (string→bool/number coercion, periodic-note default, canvas changes validation). Firewall must be enabled with `example.com` in Additional firewall domains.

```bash
bash container/test-scripts/security-checks.sh /path/to/test-vault
# Firewall-off egress probe (toggle firewall off in Obsidian first):
bash container/test-scripts/security-checks.sh /path/to/test-vault --firewall-off
```

**`container/test-scripts/stress-checks.sh`**: Stage 12 stress scenarios: unicode vault path, large-file read (~5 MB), oas-test-* teardown debris check. The daemon-stop probe (`--with-daemon-stop`) is host-disruptive and optional for routine runs.

```bash
bash container/test-scripts/stress-checks.sh /path/to/test-vault
# Daemon-stop probe (stops and restarts Docker):
bash container/test-scripts/stress-checks.sh /path/to/test-vault --with-daemon-stop
```

Both scripts complement but do not replace the `mcp-capability-test.md` cell sweep. Stage 7 bodies are in `qa-test-plan.md` for reference; Stage 9 is reduced to one human-only scenario (9.3 Tasks recurring semantics); Stage 12 UI-bound scenarios (12.4–12.6, 12.7) remain in the QA plan.

## Manual test scenarios

End-to-end manual scenarios live in [qa-test-plan.md](./qa-test-plan.md): things that need human judgement, interactive LLM use, cross-process workflows, or specific hardware. That plan is organised by setup cost (Stage 0 prerequisites to Stage 12 stress/recovery) so you can run it top-to-bottom on a fresh machine, or jump to a single stage when verifying a focused change.

For an exhaustive sweep of the MCP tool surface (every read/write/manage/extensions tool, gating behaviour, error shapes), hand [mcp-capability-test.md](./mcp-capability-test.md) to an in-container Claude Code session. It drives the run itself and emits a matrix-format report. Run it whenever the tool surface changes or as part of release validation; `qa-test-plan.md` Stage 3 cells matrix defines the six permission configurations to run it under.

Run the automated suites here first; only fall through to the QA plan or the MCP capability plan for behaviour the harness can't reach (see "What's NOT covered" above for the canonical list of gaps).

---

## Teardown

```bash
cd container
docker compose down
# To also remove named volumes:
# docker compose down -v
```

The integration harness cleans up its own `oas-test-*` resources via `globalSetup.ts`, even on crash, so you don't normally need to touch test containers/volumes by hand. If something gets wedged:

```bash
docker rm -f oas-test-sandbox
docker volume rm oas-test-claude-config oas-test_oas-test-shell-history oas-test_oas-test-user-config
docker network rm oas-test_default
```
