# QA Automation Gap Analysis

A roadmap for closing the manual residuals in [qa-test-plan.md](./qa-test-plan.md). For every
scenario that is **fully manual** (no marker) or **🟡 partially automated**, this document states
what is *missing*, 2–3 candidate approaches to close it, and — most importantly — **the precondition**
that has to hold for each approach to work.

It is a companion to `qa-test-plan.md` (the reference spec) and `testing.md` (the layer guide), not a
replacement. Where an item genuinely cannot be automated in this harness without disproportionate cost
(visual fidelity, real hardware, live-LLM judgement, third-party CLI behaviour), this document says so
plainly rather than inventing three contrived approaches.

**How to read an entry:** lead with the *precondition* — it is the thing that decides whether any
approach is viable. The approaches are ordered cheapest-first.

---

## Part 1 — Deflaking (done in this pass)

The user asked to "deflake any flaky tests." No flake was *observed* in CI — what follows is **proactive
hardening** of timing-fragile patterns, not a fix for a witnessed failure.

The integration suite (`test/integration/*`) is already robust: it polls via `waitForHealth()` with
bounded timeouts rather than sleeping. The fragility lived in the e2e suite, which used **fixed
`browser.pause(N)` sleeps** before assertions that depend on an asynchronous DOM/state update (a
validator toggling a class, a Notice rendering, a leaf detaching, a modal dismissing). A fixed sleep
races the update: too short → flake on a slow runner; too long → wasted wall-clock on every run.

**Rule applied:** replace `pause(N)` with `waitUntil()` on the *observable post-condition*, and only
where that post-condition is queryable. Left as fixed sleeps (correctly):

- **Negative assertions** ("nothing fires") — `agent-output.e2e.ts` 5.9 waits 3 s then asserts no
  Notice. You cannot `waitUntil` a non-event.
- **Deferred internal registration with no exposed signal** — `agent-output.e2e.ts` `before()` waits
  2.5 s for the vault listeners that `main.ts` attaches ~2 s after layout-ready.
- **Synchronous-open negative branches** — `restart-modal.e2e.ts` `closeSettings()` / `prepareDirty()`
  settles: the confirm modal opens synchronously inside `setting.close()`, and the dirty-diff tracker
  is in-memory and not queryable, so a small settle is the right tool for the "no modal" assertions.

Changed files (all verified: each spec run 2× green locally with the command-sandbox disabled, lint +
prettier clean):

| File | Conversions |
|------|-------------|
| `test/e2e/settings-helpers.ts` | Added `waitForInputError()` + `waitForDescContains()` (re-query by name to survive bind-address section re-render) |
| `test/e2e/specs/settings.e2e.ts` | 16 `pause()` → `waitUntil` (validator class toggles, warning text, token regen). Runtime 9.6 s → 4.8 s. Also fixed a stale comment block claiming persistence/disable-enable can't be tested (they now live in `harness-probe.e2e.ts`). |
| `test/e2e/specs/sessions.e2e.ts` | 8 `pause()` → `waitUntil` (leaf counts, filtered rows, active tab, notices, killed list). Added `terminalLeafCount()` helper. |
| `test/e2e/specs/restart-modal.e2e.ts` | 2 `pause()` → `waitUntil` (modal dismissal after Later/Restart). |
| `test/e2e/specs/notices.e2e.ts` | 4 `pause()` → `waitUntil` (Notice text present). |
| `test/e2e/specs/uri-handler.e2e.ts` | 3 `pause()` → `waitUntil` (notice present, leaf opened/detached). |
| `test/e2e/specs/analyse.e2e.ts` | 2 `pause()` → `waitUntil` (modal close, leaf detach). |

A further hardening — a global console-error sentinel — is proposed under item 12.7 below.

---

## Part 2 — Shared enablers

Most residuals collapse onto a handful of missing capabilities. Build the enabler once and several items
close together. Each enabler names the concrete existing mechanism it extends.

| # | Enabler | Extends | Closes |
|---|---------|---------|--------|
| **A** | Assert the plugin's **real Docker round-trip** (container id, `docker ps`, recreate) — see the wiring caveat below | integration suite (drives `DockerManager` directly) | 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.12, 2.17, 8.1, 8.5, 12.1 |
| **B** | Read the **real clipboard** in e2e (`require("electron").clipboard.readText()` — *confirmed available*) | any e2e spec via `executeObsidian` | 2.10, 2.16 |
| **C** | A **scripted live `claude` session** in the container (seeded auth already supported) | integration `claude-code.test.ts` | 2.19, 9.3, the capability-sweep residuals; *not* the `/mcp` CLI dance |
| **D** | **Computed-style / structural** visual assertions (the `getCSSProperty` pattern already used for 1.4) | e2e specs | partial coverage of 2.7b, 2.8, 2.9 |
| **E** | **Pre-seed fixtures before Obsidian loads** so the metadata index sees them | e2e vault fixture copy step | 7.4, 6.4 |
| **F** | **Console-error sentinel** (`browser.getLogs("browser")` for `SEVERE` — *confirmed working*) | global e2e hook | 12.7, and the "no red errors" residual on 1.1 / 2.5a |
| **G** | **Cross-platform CI matrix** (windows-latest + WSL2, macos-latest) | `.github/workflows` | Stage 10 |
| **H** | **Release/BRAT dry-run in CI** | `.github/workflows` | 11.1, 11.2, partial 11.3/11.4 |

**Enabler A wiring caveat (load-bearing — read before trusting any "drive `plugin.X()`" idea below).**
In the current harness the plugin's `DockerManager` (inside wdio-Obsidian) is wired to the **production**
compose project. The bridge-container tier brings up `oas-test` *externally* (via the integration
helpers' `containerUp()`) and only configures the plugin's **MCP** settings — it never repoints the
plugin's `DockerManager`. So calling `plugin.restart()` / `toggleFirewall()` / a Settings **Refresh**
from the wdio Obsidian would act on the wrong container.

Two consequences:
1. **Near-term, the feasible path is the integration suite**, which already owns the `oas-test` compose
   project: import `DockerManager`, point its settings getter at the test compose file + `oas-test`
   project, and assert the real id/`docker ps`/recreate directly (no Obsidian). The "but it misses the
   status-bar/Notice surfacing" objection is **moot** — that surfacing is already e2e-tested against the
   *stubbed* DockerManager (`notices.e2e.ts`, `lifecycle.e2e.ts`). So **integration (Docker round-trip)
   + existing stubbed-e2e (surfacing) = full coverage**, without new harness plumbing.
2. The bridge-container option only becomes viable after a harness enhancement that repoints the
   plugin's `DockerManager` at a test compose project via its settings getter. Worth doing if you want
   the modal→restart→recreate *joined* end-to-end, but it is the larger lift.

Two empirical checks done while writing this (so the recommendations are grounded, not assumed):

- **Clipboard:** `executeObsidian(() => require("electron").clipboard)` returns a live object →
  Enabler B is real.
- **Console logs:** `browser.getLogs("browser")` returns `{level:"SEVERE", …}` entries after a
  `console.error` → Enabler F is real. **Now wired** as the 12.7 sentinel — see below.

---

## Part 3 — Per-item assessment

### Stage 1 — pre-container

#### 1.2 Restart-required modal → real recreate
- **Residual:** modal wiring is e2e-tested; the real `docker compose down/up` and the changed setting
  taking effect are manual.
- **Precondition:** Enabler A — with the wiring caveat (the modal's **Restart** button calls the
  plugin's production-wired `DockerManager`, so the *joined* modal→recreate path needs the harness
  repointed; the recreate itself is testable from integration today).
- **Approaches:**
  1. **Integration (recommended):** `container-restart.test.ts` already proves a `docker restart`
     survives a volume marker; add a case that drives `DockerManager.restart()` (the plugin's own
     down+up) against `oas-test` and asserts a fresh id. Covers the Docker half without Obsidian. The
     modal→`restartContainer()` wiring is already e2e-tested (`restart-modal.e2e.ts`).
  2. **Bridge-container:** after repointing the plugin's `DockerManager` (caveat), set a restart field,
     click **Restart**, assert a *different* `getContainerId()`. This is the only way to test the
     *joined* path, but it is the larger lift.
  3. Accept the "setting visibly takes effect" half as a manual spot-check (open a terminal,
     `echo $OAS_VAULT_WRITE_DIR`).

#### 1.5 Start with Docker daemon stopped → real daemon round-trip
- **Residual:** classification (unit) + surfacing (e2e, stubbed throw) are covered; stopping the *real*
  daemon is manual.
- **Precondition:** CI privilege to stop dockerd in an isolated, disposable job (Enabler F-adjacent;
  destructive).
- **Approaches:**
  1. **Dedicated CI job:** a separate workflow step that `sudo systemctl stop docker`, runs the
     plugin's `start()` headlessly, asserts the classified message, then restarts docker. Isolate it so
     it never runs alongside the integration suite (which needs the daemon).
  2. **Reuse the stress probe:** `stress-checks.sh --with-daemon-stop` already does the container-probe
     half; extend it to assert the plugin-surfaced message via a running Obsidian.
  3. **Accept the gap (recommended):** the stderr→message mapping is unit-tested for both Linux and
     Windows socket strings, and the Notice+pill surfacing is e2e-tested. The only thing manual is "the
     real socket really is down," which buys little over the stub for high CI cost and flakiness.

#### 1.7a ttyd port pre-flight → real bind race / WSL-NAT blindness
- **Residual:** the abort-on-conflict path is e2e-tested with a stubbed conflict; the real OS bind race
  and the WSL-NAT netns blindness are manual.
- **Precondition:** ability to occupy the real port in the *same netns* as the binding process.
- **Approaches:**
  1. **Integration:** bind `127.0.0.1:17681` from the test process, then drive
     `DockerManager.checkStartupConflicts()` and assert it reports the port. Real OS bind, no stub.
  2. **Bridge-container:** occupy the port, attempt a plugin start, assert it aborts with the Notice.
  3. The WSL-NAT half is **hardware-bound** (Enabler G) — accept as manual; it is a documented known
     gap, not a regression risk on Linux/macOS CI.

#### 1.7b / 3.6 / 3.7 MCP reactive failure & auth lifecycle → the `/mcp` CLI reconnect
- **Residual:** the bind-failure Notice, `mcpEnabled` invariant, token-rotation reject/accept, and
  connection-drop are all e2e/bridge-tested. The only residual is the user typing `/mcp` in the
  **Claude CLI** to reconnect.
- **Precondition:** a scripted interactive `claude` session (Enabler C).
- **Approaches:**
  1. **Accept the gap (recommended):** `/mcp` is *Claude CLI* behaviour, not the plugin's. The plugin
     side (force-close, teardown, re-accept) is fully covered. Testing the CLI's reconnect tests
     Anthropic's code, not this repo's.
  2. If ever wanted: drive a `pexpect`-style script against `claude` in the container that issues
     `/mcp` and asserts tool access resumes — high maintenance, low marginal value.

#### 1.8 / 6.1 / 6.2 URI handlers → real `obsidian://` dispatch
- **Residual:** handler bodies are extracted and invoked directly in e2e; dispatching a real OS-level
  `obsidian://` URI is manual. 6.2 (analyse) is fully manual.
- **Precondition:** an OS that has registered the `obsidian://` protocol and a way to fire it (Enabler
  G-adjacent).
- **Approaches:**
  1. **Extend the extracted-handler pattern to 6.2 (recommended):** 1.8/6.1 already invoke
     `handleOpenTerminalUri()`. Do the same for the analyse URI — invoke the extracted handler with
     `{path, template}` params and assert the seeded terminal command. Closes 6.2 to the same level as
     6.1 cheaply.
  2. **Real dispatch via `xdg-open`/`open`** in a desktop CI runner — fragile (focus stealing, protocol
     registration timing); not worth it.
  3. Accept the "real browser paste → OS → Obsidian focus" hop as manual; it is the OS's job, and the
     handler logic is what we own and now test.

### Stage 2 — container running

#### 2.1 / 2.2 / 2.3 / 2.4 / 2.5 / 2.12 / 2.17 lifecycle observables
These all share the **same residual and the same fix**: the orchestration is e2e-tested against a
*stubbed* DockerManager; observing the **real** Docker round-trip (a fresh container id, `docker ps`
empty/present, an out-of-band recreate detected) is manual.
- **Precondition:** Enabler A — and note the **wiring caveat** above: the plugin's `DockerManager` in
  the e2e harness points at the production project, so the Docker round-trip is driven from
  *integration*, not from the wdio Obsidian.
- **Approaches (apply per item):**
  1. **Integration (recommended)** for the real Docker observables — `DockerManager` pointed at the
     `oas-test` project:
     - 2.1 auto-start → `start()`, assert `docker ps` shows oas-test.
     - 2.2/2.5 auto-stop / disable → `stop()` / `stopDetached()`, assert `docker ps` empty.
     - 2.3 auto-stop-off → after a stop-skipped path, assert the container id is unchanged.
     - 2.4/2.17 recreate → `restart()` (or rebuild then restart), assert a *new* id.
     - 2.12 out-of-band recreate → `docker compose down/up` externally, then `getContainerId()` +
       `checkContainerIdDrift()` returns the drift signal.
     The status-bar/Notice **surfacing** for all of these is *already* e2e-tested against the stubbed
     DockerManager (`lifecycle.e2e.ts`, `notices.e2e.ts`), so this completes coverage.
  2. **Bridge-container** — only after repointing the plugin's `DockerManager` at a test project (see
     caveat). Then the *joined* path (real Obsidian event → real recreate → real pill) becomes testable.
     Larger lift; do it only if the joined end-to-end is specifically wanted.
  3. Keep the human-observable status-bar transitions as manual spot-checks.
- **Note:** 2.17 also needs an image rebuild; gate it behind a CI job that does `docker compose build`
  (already in `integration.yml`).

#### 2.7 Terminal attach → render fidelity + clipboard
- **Residual:** live attach+render is bridge-container-tested; "no flicker / no garbled escapes" and the
  clipboard write are manual.
- **Precondition:** clipboard read (Enabler B); a way to assert render correctness (Enabler D).
- **Approaches:**
  1. **Clipboard half (recommended, now cheap):** see 2.10 — read the real clipboard after a copy.
  2. **Render half:** assert the xterm buffer *content* (already partly done) plus structural checks —
     e.g. after `printf` of a known escape sequence, assert the resulting DOM rows/colours via the
     xterm serialize addon. This catches "garbled escapes" deterministically.
  3. "Looks right / no flicker" is genuinely visual — accept as manual (see Accepted Gaps).

#### 2.10 Auto-copy on selection opt-out
- **Residual:** the `shouldAutoCopy` predicate is unit-tested; the actual clipboard write/no-write is
  manual.
- **Precondition:** **met** — Enabler B (clipboard readable; confirmed).
- **Approaches:**
  1. **e2e (recommended):** open a terminal, programmatically select buffer text, then
     `executeObsidian(() => require("electron").clipboard.readText())` and assert it updated (auto-copy
     on) or did not (opt-out). Three assertions: drag-select with auto-copy on/off, and Ctrl+C with a
     selection.
  2. Container-tier variant if a real shell output is wanted for the selection source.

#### 2.16 Copy terminal connection log
- **Residual:** the formatter is unit-tested; clipboard copy + live lifecycle capture are manual.
- **Precondition:** Enabler B (met) + at least one real connect/disconnect to populate the ring buffer
  (bridge-container has a live ttyd).
- **Approaches:**
  1. **Bridge-container (recommended):** open+close a real terminal against oas-test, run the copy
     command, read the clipboard, assert the multi-line log shape and that the WS URL carries no token.
  2. **Docker-free e2e:** point a terminal at a dead port to generate connect-fail/retry entries, copy,
     and assert the formatted lifecycle — covers the formatter→clipboard path without Docker.

#### 2.19 / 2.19a Custom sudo password → live `sudo apt-get`
- **Residual:** env+compose wiring is unit-tested and secret isolation is covered; the live sudo round
  trip is manual.
- **Precondition:** oas-test started with the no-new-privileges override and `OAS_SUDO_PASSWORD` set
  (Enabler C-adjacent — needs the container, not Claude).
- **Approaches:**
  1. **Integration (recommended):** bring up oas-test with a sentinel password, then
     `containerExec("echo <pw> | sudo -S apt-get update")` and assert success; bring up *without* and
     assert refusal. `container-advanced.test.ts` already drives sudo-scope assertions — extend there.
  2. The 2.19a grep-the-vault isolation check is host-side and shell-scriptable: add it to
     `stress-checks.sh` (assert the sentinel is absent from the vault tree).

### Stage 4

#### 4.6 Big-diff modal stays responsive
- **Residual:** the ~500-line diff *renders and approves* (bridge); the "<1 s / scrolls smoothly"
  latency is manual.
- **Precondition:** a stable latency budget CI can hold — which it cannot (noisy shared runners).
- **Approaches:**
  1. **Accept the gap (recommended):** render-without-error is the automatable invariant and is covered.
     A hard latency gate on shared CI is a flake factory.
  2. If a soft signal is wanted: log the render duration and assert a *generous* ceiling (e.g. <5 s)
     purely to catch O(n²) regressions — not the <1 s UX target.

### Stage 5

#### 5.7 Agent-output rate-limit timing
- **Residual:** the requeue logic is unit-tested with fake timers; the live two-burst timing is manual.
- **Precondition:** real-timer stability over a >5 s window — CI-hostile.
- **Approach:** **accept the gap (recommended).** It is *deliberately* not an e2e (the spec comment in
  `agent-output.e2e.ts` says so). The deterministic fake-timer unit test is the correct home.

### Stage 6

#### 6.4 Templates render on first right-click after reload
- **Residual:** the template *cache* is proven populated post-reload; the submenu **DOM** render on
  right-click is manual.
- **Precondition:** ability to trigger Obsidian's file context-menu in wdio (Enabler E for the seed).
- **Approaches:**
  1. **e2e (recommended):** after `reloadObsidian()`, dispatch the file-menu (`app.workspace.trigger
     ("file-menu", menu, file)` with a captured Menu, as `analyse.test.ts` does with a fake Menu but
     here against the live registration) and assert the submenu items are present — closes the
     render half.
  2. Accept as manual: the cache (the substance) is covered; the DOM render is cosmetic.

### Stage 7

#### 7.4 Symlink inside write-dir pointing into vault (allow-path)
- **Residual:** unit-tested; the e2e allow-path fails because Obsidian's metadata index never indexes a
  symlink **created after load**.
- **Precondition:** the symlink must exist **before** Obsidian indexes the vault (Enabler E).
- **Approaches:**
  1. **Pre-seed the fixture (recommended):** create the in-vault symlink in the ephemeral vault copy
     *before* launching Obsidian (in the fixture prep / a `before` that runs prior to first index), so
     `vault_read` resolves it. This is the *likely* unlock for the "Folder not found before realpath
     guard" problem — it depends on whether Obsidian's indexer follows symlinks at all (regardless of
     creation time); verify that before investing.
  2. **Force a re-index:** after creating the symlink, trigger a metadata rescan and wait for
     `resolved` before the call. Less reliable than (1).
  3. Accept as unit-only (current state) — the realpath guard logic is fully unit-tested.

### Stage 8

#### 8.1 Firewall toggle live (real iptables)
- **Residual:** state machine + pill wiring are tested with the apply stubbed; the ~2 s real iptables
  apply is manual.
- **Precondition:** Enabler A. The real iptables apply is *already* integration-tested
  (`firewall.test.ts`); the pill flip is *already* e2e-tested with the apply stubbed (`notices.e2e.ts`).
  Joining them in one test hits the wiring caveat (`plugin.toggleFirewall()` uses the production-wired
  DockerManager).
- **Approaches:**
  1. **Accept as-is (recommended):** real apply (integration) + pill flip (stubbed e2e) already span the
     behaviour from both ends; the missing piece is only the *joined* round-trip.
  2. **Bridge-container:** after repointing the plugin's `DockerManager` (caveat), drive
     `plugin.toggleFirewall()` against oas-test and assert `firewallStatus()` flips *and* the pill aria
     updates. Larger lift.
  3. Keep the wall-clock "~2 s" as an untested soft expectation.

#### 8.4 `--list-sources` `[file]` tag + 8.5 effective-allowlist refresh live
- **Residual:** `[baseline]`/`[plugin]` tags are integration-tested; the `[file]` tag needs a non-empty
  `firewall-extras.txt`, and the Settings refresh against a live container is manual.
- **Precondition:** a non-empty extras fixture mounted into oas-test (8.4); Enabler A (8.5).
- **Approaches:**
  1. **8.4 (recommended):** add a test fixture `firewall-extras.txt` with one comment + one domain,
     mount it read-only into oas-test, and assert the `[file]` tag appears in `--list-sources` and the
     domain is curl-reachable. A small, self-contained integration addition.
  2. **8.5:** the Refresh control's wiring is already e2e-tested with a stub
     (`firewall-allowlist.e2e.ts`), and `--list-sources` is integration-tested. Joining them (Refresh →
     live container) hits the wiring caveat — `plugin.firewallSources()` uses the production DockerManager
     — so it needs the harness repointed (caveat) before bridge-container can drive it. Until then,
     **accept the joined round-trip as manual**; both ends are covered.

### Stage 9

#### 9.3 Tasks toggle with recurring
- **Residual:** the multi-line insertion the plugin owns is unit-tested; the real Tasks recurrence
  engine is manual (deliberately not vendoring a third-party build into the fixture).
- **Precondition:** the Tasks plugin installed+enabled in the e2e vault (Enabler C-adjacent: a real
  third-party plugin).
- **Approaches:**
  1. **e2e with Tasks installed:** add Tasks to a dedicated extensions-tier fixture vault and assert
     the real next-occurrence line. Cost: vendoring + version-pinning a third-party plugin.
  2. **Accept the gap (recommended):** the plugin's contract (split the returned block, insert each
     line, preserve surroundings) is unit-tested against a mocked Tasks API; the recurrence *semantics*
     are Tasks' responsibility. This is the documented rationale and it holds.

### Stage 10 — cross-platform (hardware-bound)

#### 10.1 WSL path conversion · 10.2 Rancher space-path · 10.3 macOS · 10.4 Linux · 10.5 WSL MASQ
- **Residual:** parsers/escapers are unit-tested; the real round-trip through `wsl.exe` / Docker
  Desktop / Rancher only runs on those hosts.
- **Precondition:** **real OS runners** (Enabler G). This is the one true blocker — no in-process trick
  substitutes for a real Windows+WSL2 host.
- **Approaches:**
  1. **CI matrix (the only real automation):** add `windows-latest` (WSL2 + Docker Engine) and
     `macos-latest` (Docker Desktop) jobs running the integration smoke. Rancher/Docker-Desktop GUI
     installs on hosted runners are flaky and may need self-hosted runners.
  2. **Linux 10.4** is effectively *already* covered — the existing CI *is* Linux native Docker; mark
     it automated-by-default.
  3. Accept Windows/macOS/Rancher as a **pre-release manual matrix** until/unless self-hosted runners
     are justified. Be honest that the unit-tested parsers (`windowsToWslPath`, `parseDockerNetworkMasq`)
     cover the *logic*, not the *integration*.

### Stage 11 — release & distribution

#### 11.1 `plugin check` workflow on PRs
- **Precondition:** none — it is a CI workflow.
- **Approach:** **automate the assertion of the gate itself.** Confirm the path filter (touches
  `plugin/src/` → runs; otherwise skips) with a workflow test or a documented periodic check. Low
  effort.

#### 11.2 Release workflow produces signed assets
- **Precondition:** a tag push in a throwaway/test context (Enabler H).
- **Approaches:**
  1. **Dry-run job:** run the release workflow's asset-build + tag-vs-manifest check on a `workflow_
     dispatch` against a fake version, asserting `main.js`/`manifest.json`/`styles.css` are produced.
     `release-consistency.test.ts` already covers the version triple in unit tests.
  2. Accept the actual GitHub Release publication as a manual release-time check.

#### 11.3 BRAT install · 11.4 upgrade-in-place
- **Precondition:** a real Obsidian + BRAT pulling from a real Release (Enabler G+H).
- **Approaches:**
  1. **e2e against a published pre-release:** an opt-in spec that installs via BRAT from the latest
     pre-release tag and asserts the plugin loads — heavy, network-dependent, best run release-time.
  2. **Accept as manual (recommended):** BRAT is third-party; the artifact *correctness* (the three
     files, version consistency) is what we own and is unit-tested (11.5).

---

## Part 4 — Accepted gaps (and why)

Forcing automation here costs more than it returns. Each is covered at the right layer below the
manual line.

| Item | Why it stays manual | What *is* covered |
|------|---------------------|-------------------|
| 2.7a font family, 2.8 themes, 2.9 resize, 2.7 "looks right" | Visual fidelity — xvfb can't judge rendering; pixel-baseline diffing is flaky on font/AA and the team has not adopted it | font fallback chain (unit), theme is CSS-var driven, computed-style spot checks possible (Enabler D) |
| 4.6 <1 s latency, 5.7 live timing | Wall-clock gates flake on shared CI | render-without-error (bridge), requeue logic (fake-timer unit) |
| 1.7a WSL-NAT, Stage 10 Windows/macOS/Rancher | Real-hardware integration; no in-process substitute | parsers/escapers (unit), Linux path (CI) |
| 1.7b/3.6/3.7 `/mcp` reconnect, 9.3 recurrence | Third-party (Claude CLI / Tasks engine) behaviour | plugin-side teardown/auth/insertion fully covered |
| 11.3/11.4 BRAT | Third-party installer + live network | artifact + version consistency (unit, 11.5) |
| "no red console errors" sweeps | Subjective triage of *expected* warnings | the **SEVERE** subset is now automatable — see 12.7 |

### 12.7 Console-error sentinel — ✅ implemented
- **Precondition:** **met** — `browser.getLogs("browser")` returns `SEVERE` console entries (verified
  empirically with a probe: a `console.error` in the Obsidian renderer comes back as one SEVERE entry).
- **Shipped:** an `afterTest` hook in `plugin/wdio.conf.mts` (logic in `test/e2e/console-sentinel.ts`)
  fetches `getLogs("browser")` after every passing test, keeps only `SEVERE`, drops allowlisted lines,
  and fails the test on anything else — a real gate across the whole `test/e2e/specs/**` suite.
  `OAS_SENTINEL_REPORT=1` prints offenders instead of failing (regenerate the allowlist);
  `OAS_SENTINEL_RAW=1` bypasses the allowlist (see every SEVERE).
- **Empirical correction to the original plan:** the allowlist is **empty**. A full RAW recon over all
  19 specs / 98 tests found **zero** SEVERE entries — the anticipated noise (ttyd WS-attach failures in
  the no-container specs; the `[Violation] reflow` line) does **not** surface as a SEVERE *console*
  entry: the plugin routes WS failures through its levelled logger (warn/debug), not `console.error`,
  and `[Violation]` is a warning, not SEVERE. Pre-seeding those patterns would have been dead code that
  could mask a real regression, so they were deliberately left out.
- **Not yet gated:** the bridge-container tier (`wdio.bridge.conf.mts`) — it needs Docker, so its
  zero-SEVERE baseline wasn't validated here. Adding the same hook there is a small, safe follow-up once
  its baseline is confirmed.

### 12.1 Docker daemon stops mid-session
- **Residual:** `stress-checks.sh --with-daemon-stop` proves MCP becomes unreachable and recovers; the
  human-observable status-bar→errored + terminal-disconnected message needs Obsidian open.
- **Precondition:** same as 1.5 — privilege to stop dockerd in a disposable job. Shares the
  daemon-stop machinery.
- **Approach:** **accept the UI half (recommended).** The recovery probe is automated; the status-bar
  error transition is already covered structurally by the stubbed-throw path in `notices.e2e.ts` (1.5).
  Observing it during a *real* daemon stop adds little over high CI cost.

### 12.5 / 12.6 teardown with open modal / mid-tool-call
- **Precondition:** ability to tear the plugin down with state pending (no real quit needed —
  `disablePlugin` exercises the same `onunload`).
- **Approaches:**
  1. **e2e (recommended):** open a reviewed-write diff modal (bridge already opens these), then
     `disablePlugin`; assert the pending tool call rejects/times out cleanly and no zombie modal or
     `SEVERE` log remains (pairs with the 12.7 sentinel).
  2. The genuine OS-level Cmd+Q is Obsidian's lifecycle — keep as a manual spot-check.
