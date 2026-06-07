# QA Test Plan: End-to-End Manual Scenarios

This plan covers scenarios outside the scope of `npm run test`, `test:integration`, and `test:e2e`: those that require human judgement, cross-process workflows, real LLM calls, real target plugins, or specific OS/hardware. See `docs/testing.md` for the automated coverage matrix.

## How to use this plan

- **Stages are ordered by setup cost.** Setup done in an earlier stage carries forward into later stages, so work top-to-bottom on a fresh machine for the cheapest path. If you only need a slice, jump to the relevant stage and read its "Setup carried forward" line for what must already be in place.
- **Each scenario lists:** Setup (in addition to the stage's), Steps, Expected, and Notes (gotchas, cleanup, severity).
- **Severity convention:** `P0` blocks ship, `P1` ships only with workaround, `P2` polish.
- **Cleanup discipline:** scenarios that mutate state (symlinks, firewall, custom sudo password, files in vault) end with explicit cleanup. Run it: later scenarios assume a clean baseline.
- **Don't repeat automated coverage.** If a behaviour is covered in `src/__tests__/*`, `test/integration/*`, or `test/e2e/*`, don't re-verify here. This plan is the gap-filler.
- **Automation markers.** Two prefixes flag CI coverage, each with a pointer to the covering test:
  - **`✅ Automated`** — fully covered by CI; needs **no manual run**. Retained for traceability and as the reference spec for that test.
  - **`🟡 Partially automated`** — the core logic is covered by a test (named in the marker), but a residual still needs a human. The marker always names the covering test **and** spells out the remaining manual step(s) (the trailing "… stays/stay manual" clause); only that residual is worth running by hand.

  A scenario with **no** marker is fully manual (or, for a few, blocked from automation — see its Notes).

---

## Stage 0: Environment prerequisites (one-time per machine)

These aren't test scenarios; they're the baseline. Verify each before touching Stage 1.

- [ ] Host OS: Linux (native Docker), WSL2 with Docker Engine + mirrored networking, macOS with Docker Desktop, or Windows with Rancher Desktop / Docker Desktop.
- [ ] `docker info` succeeds from the host shell Obsidian will inherit `PATH` from.
- [ ] `oas-sandbox:latest` image built: `cd container && docker compose build`.
- [ ] `docker compose version` reports ≥ 2.24 (required for `!reset` syntax in the sudo override, see 2.19).
- [ ] Obsidian desktop ≥ `1.5.0` installed.
- [ ] A real vault to test against (not the e2e fixture). Recommend a fresh vault with a handful of notes, at least one with frontmatter, and one folder with 2-3 cross-linked notes.
- [ ] Plugin artifacts built and installed into the vault: `cd plugin && npm run build`, then copy `dist/main.js`, `dist/manifest.json`, `dist/styles.css` into `<vault>/.obsidian/plugins/obsidian-agent-sandbox/`.
- [ ] Claude Code authenticated inside the container at least once (see `docs/testing.md` → "Claude Code authentication"). Required from Stage 3 onward.

---

## Stage 1: Plugin enabled, container not yet started

**Setup carried forward:** Stage 0.

This stage exercises the settings UI, error/fallback paths before any container exists, and the plugin's load-time behaviour. Quick to run: no LLM, no Docker round-trips.

### 1.1 First-enable settings tab render

- **✅ Automated** — `test/e2e/specs/settings-inventory.e2e.ts` serializes every tab's rendered settings rows in DOM order (field name, control type, default value, dropdown label, "Requires container restart" flag, headings, list editors, buttons) and diffs the whole inventory against a committed reference (`test/e2e/fixtures/settings-inventory.json`). Any added/removed/reordered field, changed default, flipped restart label, or renamed dropdown option fails CI until the reference is deliberately re-blessed (`OAS_UPDATE_SETTINGS_SNAPSHOT=1`, then `prettier --write` the fixture). The MCP auth token value is redacted (auto-generated). The expected inventory below is the human-readable companion to that fixture — keep them in step.
- **Setup:** Plugin freshly enabled (toggle off then on in Community Plugins). DevTools open (Ctrl+Shift+I) before clicking, to catch transient errors.
- **Steps:** Open Settings → Agent Sandbox. Visit all four tabs in order: **General, Terminal, MCP, Advanced**. For each, verify fields appear in the order listed below with the stated defaults and "Requires container restart." labels where noted.
- **Expected:**
  - **General** (top to bottom):
    - Docker mode = `WSL (Windows)` *(Requires container restart.)*
    - Docker Compose path = empty *(Requires container restart.)*
    - WSL distribution = empty with placeholder `Ubuntu` *(Requires container restart., visible only when Docker mode = WSL)*
    - Vault write directory = `agent-workspace` *(Requires container restart.)*
    - Memory file name = `memory.json` *(Requires container restart.)*
    - Auto-start on load = off *(no label)*
    - Auto-stop on exit = off *(no label)*
    - **Agent output notifications** *(heading)*
      - Notify on file created = on *(no label)*
      - Notify on file edited = off *(no label)*
      - Notify on file deleted = on *(no label)*
      - Notify on file renamed/moved = on *(no label)*
      - Vault-wide scope = off *(no label)*
  - **Terminal** (top to bottom):
    - Port = `7681` *(Requires container restart.)*
    - Bind address = `127.0.0.1` *(Requires container restart.)*
    - **Appearance** *(heading)*
      - Terminal theme = `Follow Obsidian theme` *(no label)*
      - Terminal font = empty *(no label)*
      - Font size = `14` *(no label)*
      - Scrollback = `10000` *(no label)*
      - Auto-copy on selection = on *(no label)*
  - **MCP** (top to bottom):
    - **Server** *(heading)*
      - Enable MCP server = on *(no label)*
      - MCP port = `28080` *(Requires container restart.)*
      - MCP bind address = `127.0.0.1` *(no label, hot-swap - applies without container restart)*
      - Auth token = auto-generated value, with **Regenerate** button *(Requires container restart.)*
    - **Always enabled** *(heading, with a two-item info list, no controls)*
    - **Escalations** *(heading)*
      - Vault-wide writes = `None` *(no label)*
      - Navigate / Manage / Extensions tiers = off *(no label each)*
    - **Path restrictions** *(heading)*
      - Allowed paths = empty, list editor with **Add** button *(no label)*
      - Allowlist mode = off *(no label)*
      - Blocked paths = empty, list editor with **Add** button *(no label)*
    - **Timeouts** *(heading)*
      - Tool timeout (seconds) = `10` *(no label)*
      - Review timeout (seconds) = `180` *(no label)*
      - User edit suppression window (seconds) = `10` *(no label)*
  - **Advanced** (top to bottom):
    - **Diagnostics** *(heading)*
      - Log level = `Warn` *(no label)*
    - **Resource limits** *(heading)*
      - Memory limit = `4G` *(Requires container restart.)*
      - CPU limit = `2` *(Requires container restart.)*
    - **Security** *(heading)*
      - Auto-enable firewall on start = **on** *(no label)*
      - Allowed private hosts = empty, list editor with **Add** button *(Requires container restart.)*
      - Additional firewall domains = empty, list editor with **Add** button *(Requires container restart.)*
      - Effective allowlist (Refresh button, no input) *(no label)*
      - Sudo password = empty *(Requires container restart.)*
  - No red console errors on any tab. A `[Violation] Forced reflow …` yellow warning on plugin enable/disable is known and benign.
- **Notes:** P1. This inventory is the authoritative list: field order, defaults, and label presence all matter. Update this scenario when settings change.

### 1.2 Restart-required modal on settings close

- **🟡 Partially automated (modal wiring)** — the diff that gates the modal (`restartKeysChanged`, including revert-clears-the-prompt) is unit-tested in `src/__tests__/settings-restart.test.ts`, and the modal wiring (text + two buttons, **Later** = no restart, **Restart** = dispatches `restartContainer()`, revert→no modal, container-down→Notice + `pendingRestartMarker`) is e2e-tested in `test/e2e/specs/restart-modal.e2e.ts`. The real container recreate (`docker compose down/up`) and the changed setting actually taking effect stay manual.
- **Setup:** Container running.
- **Steps:** Open Settings → Agent Sandbox. Change any field flagged in 1.1 as "Requires container restart." (e.g. General → Vault write directory). Close the settings tab (click another settings section or close the settings modal entirely).
- **Expected:** While the settings tab is open, no inline indicator or status bar change appears. On close, a **Restart Container?** modal appears: message reads "You changed settings that require a container restart. Restart now? This will stop all active terminal sessions." Two buttons: **Restart** (restarts container and dismisses) and **Later** (saves settings without restarting and dismisses). Both dismiss the modal cleanly with no console errors. The modal does NOT appear if the container is not running when settings close.
- **Notes:** P1. Reverting a changed restart field to its value **at the time the settings tab was opened**, before closing, skips the prompt — the modal diffs against an open-time snapshot. Cross-session caveat: after a change is saved via **Later** and the tab is reopened, the snapshot rebaselines, so reverting to the *container-start* value will still prompt. Field list is single-sourced in 1.1.

### 1.3 MCP token regenerate

- **✅ Automated** — `test/e2e/specs/settings.e2e.ts` ("token regenerate produces a new value") and `smoke.e2e.ts` ("auto-generates an MCP token on first load") assert the field changes to a fresh 32-char hex value. No manual step. Whether the *running* MCP server adopts the new token is the live-session check 3.6.

### 1.4 Bind address security warning toggle

- **✅ Automated** — `test/e2e/specs/settings.e2e.ts` asserts the network-exposure warning appears at `0.0.0.0` and clears on revert, for **both** the Terminal (ttyd) and MCP bind-address fields. The warning's styling (amber `#ffc107` 3px solid left-border) is asserted via `getCSSProperty` ("bind address warning renders the amber left-border") — a deterministic computed-style check rather than pixel visual-regression. No manual step.

### 1.5 Start with Docker daemon stopped

- **🟡 Partially automated (error classification)** — `DockerManager.classifyCommandError` maps a stopped daemon's stderr (Linux socket, Windows named pipe) and the other start failures (WSL missing, bad distro, missing compose file, timeout) to the user-facing message, unit-tested in `src/__tests__/docker.test.ts` ("classifyCommandError"). Stopping the real host daemon and observing the live Notice + errored status bar stays manual.
- **Setup:** Stop Docker on the host. On Linux with systemd: `sudo systemctl stop docker.socket docker.service`. On macOS/Windows: quit Docker Desktop or Rancher Desktop.
- **Steps:** Command palette → **Sandbox: Start Container**.
- **Expected:** Clear Notice within ~5 s naming the failure ("Docker not available", "Cannot connect to Docker daemon", etc.). No infinite spinner. Status bar settles to a stopped/errored state with a useful tooltip.
- **Notes:** P0. After the test, restart Docker before continuing. On Linux with systemd: `sudo systemctl start docker.socket docker.service`. On macOS/Windows: relaunch Docker Desktop or Rancher Desktop.

### 1.6 Write directory validation in settings

- **✅ Automated (keystroke rejection)** — `settings.e2e.ts` ("write directory rejects escaping paths") covers typed `../escape` / `/root/forbidden` → `sandbox-input-error`; `validation.test.ts` unit-tests the validator. Manual residual below covers only the *stored-escape* path.
- **Setup:** Plugin enabled.
- **Steps:** Manually edit the vault's `data.json` (`.obsidian/plugins/obsidian-agent-sandbox/data.json`) to set `vaultWriteDir` to a path that escapes the vault, then reload the plugin (toggle off/on in Community Plugins).
- **Expected:** On load the settings tab shows the field in error state (red border / `sandbox-input-error` class). The stored value is **not** auto-corrected; attempting to start the container while the invalid value is stored emits a Notice and fails to start.
- **Notes:** P1. Only the stored-escape half is manual: the e2e harness loads the plugin out-of-tree, so it cannot seed `data.json` and reload (see the skipped probe in `test/e2e/specs/harness-probe.e2e.ts`).

### 1.7 Port conflict detection

The plugin has **two separate** conflict-detection mechanisms with different code paths, failure modes, and platform behaviour. Keep them separate when testing.

**Port-occupier reference**: pick the one-liner that matches your host OS and the bind address shown in settings. The occupier must run in the **same network namespace as the process doing the bind** (see per-scenario notes below).

| Host                       | `127.0.0.1` (loopback)                                                                                                          | `0.0.0.0` (all interfaces)                                                                    | Specific IP                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Windows (PowerShell)       | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, <PORT>); $l.Start()`                              | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, <PORT>); $l.Start()` | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('<IP>'), <PORT>); $l.Start()` |
| Linux / macOS / WSL shell  | `python3 -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',<PORT>)); s.listen(); print('bound'); sys.stdin.read()"` | same with `'0.0.0.0'`                                                                         | same with `'<IP>'`                                                                                      |
| Linux, netcat-openbsd only | `nc -l 127.0.0.1 <PORT>`                                                                                                        | `nc -l 0.0.0.0 <PORT>`                                                                        | `nc -l <IP> <PORT>`                                                                                     |

Release: PowerShell → `$l.Stop()`. Python / nc → Ctrl+C. (`nc -l <port>` without an IP is netcat-openbsd syntax only; netcat-traditional requires `-p <port>`. The Python one-liner works everywhere.)

To confirm your WSL2 networking mode: `wsl --status` (look for "Networking mode") or check `%USERPROFILE%\.wslconfig` for `networkingMode=mirrored`; absence means NAT (default).

---

**1.7a: ttyd port pre-flight (container start)**

- **What it exercises:** `checkStartupPortConflicts` (`main.ts:1051`) → `DockerManager.checkStartupConflicts` (`docker.ts:879`), which dispatches to `checkPortConflicts` (`docker.ts:829`) or `checkPortConflictsWsl` (`docker.ts:890`), probes `Settings → Terminal → Bind address` + `Port` inside the **plugin process (Obsidian host netns)** before invoking Docker.
- **Setup:** On the **Obsidian host**, occupy `<ttydBindAddress>:<ttydPort>` (default `127.0.0.1:7681`) using the table above. **On WSL2**: the plugin probes the Windows host netns; compose binds inside WSL2's netns. These are the same only in WSL2 mirrored mode (see expected outcomes below).
- **Steps:** Command palette → **Sandbox: Start Container**.
- **Expected:**
  - **Linux native Docker / macOS Docker Desktop / WSL2 mirrored mode:** Notice `Port conflict: 7681 already in use on 127.0.0.1. Stop the other process or change the port in settings.` Container does not start. *(The Notice interpolates the configured Bind address; `127.0.0.1` shown here is the default, not a hardcoded value.)*
  - **WSL2 NAT mode (default):** Pre-flight probe is blind to the WSL netns, so the container starts without blocking. Within ~5 s, `checkTtydReachability` (`main.ts:705`) polls the port and fires a 10 s Notice: `Sandbox started but terminal isn't reachable on 127.0.0.1:<port>. Check for a port conflict or run 'docker compose logs' to investigate.` Terminal tab will spin until a manual start/stop cycle resolves the conflict.
- **Cleanup:** Release the port. Restart container if it started in the NAT-mode gap case.
- **Notes:** P1 on platforms where pre-flight works. Known gap on WSL2 NAT.

---

**1.7b: MCP port reactive failure (server start)**

- **What it exercises:** `McpLifecycle.startServer` catch path (`mcp-lifecycle.ts`): `listen()` fails, plugin shows a Notice and tears down the half-started server, but **leaves `mcpEnabled` untouched** - the toggle records user intent, not runtime state, so a transient start failure must not silently flip and persist it off.
- **MCP runs in the plugin process on the Obsidian host** (not inside Docker/WSL). Occupy the port on the **Windows host** (not inside a WSL shell) on WSL2 setups.
- **Setup:**
  1. Container running.
  2. MCP must be **stopped** before occupying the port. If "Enable MCP server" is on, toggle it off first via **Sandbox: Toggle MCP Server**.
  3. Occupy `<mcpBindAddress>:<mcpPort>` (default `127.0.0.1:28080`) using the table above, on the **Obsidian host**.
- **Steps:** Command palette → **Sandbox: Toggle MCP Server** (starts MCP because it is stopped).
- **Expected:**
  - Notice: `MCP server failed to start: …` (error will mention address in use).
  - Settings → MCP → **Enable MCP server** stays **ON** (not auto-disabled, nothing persisted; reopen settings to confirm). The status bar shows MCP not running (`MCP: off`).
  - Container itself remains running.
- **Recovery sub-step (recommended):** Release the port, then trigger a restart - toggle MCP off then on, **or** change a hot-swap MCP setting (e.g. bind address). `restartMcpIfRunning` reconciles the enabled-but-stopped server and it starts cleanly. Confirms the half-state cleanup in the catch block.
- **Cleanup:** `$l.Stop()` / Ctrl+C.
- **Notes:** P0. Host-process path: must fire on all platforms.

### 1.8 URI handler without container

- **🟡 Partially automated (handler guard)** — `test/e2e/specs/uri-handler.e2e.ts` ("1.8: with the container stopped …") invokes the extracted `handleOpenTerminalUri()` with `isContainerRunning` stubbed false and asserts the "Sandbox container is not running." Notice fires and no terminal tab opens. The wdio harness can't dispatch a real OS-level `obsidian://` URI, so the browser-paste round-trip stays manual.
- **Setup:** Container stopped.
- **Steps:** Paste `obsidian://agent-sandbox/open-terminal` into a browser.
- **Expected:** Obsidian focuses; a Notice explains the container isn't running. No crash, no zombie terminal tab.
- **Notes:** P1.

### 1.9 Command palette entries present

- **✅ Automated** — `test/e2e/specs/smoke.e2e.ts` ("registers all 12 expected commands") asserts the **exact** set of all 12 command ids (fails if any are added, removed, or renamed). No manual step. `plugin/src/main.ts` is the canonical source if the count changes.

---

## Stage 2: Container running, no Claude interaction yet

**Setup carried forward:** Stage 0–1, plus container running cleanly (status bar green/running).

This stage covers lifecycle, terminal, and status-bar behaviour without depending on an authenticated Claude.

### 2.1 Auto-start on Obsidian launch

- **Setup:** Auto-start enabled. Container stopped. Obsidian closed.
- **Steps:** Open Obsidian.
- **Expected:** Status bar transitions through Starting → Running within ~30 s. Tooltip detail cycles "Starting: checking Docker availability…" → "Starting: probing WSL (5s fast-fail)…" → "Starting: probing container status…" → "Starting: docker compose up -d (auto-start)…". On Linux/macOS the WSL probe should still appear briefly but resolve to "not WSL".
- **Notes:** P0.

### 2.2 Auto-stop on Obsidian close

- **Setup:** Auto-stop enabled.
- **Steps:** Close Obsidian completely.
- **Expected:** `docker ps` shows no `oas-sandbox` within ~10 s.
- **Notes:** P0. Pair with 2.3.

### 2.3 Auto-stop off: survives close

- **Setup:** Auto-stop disabled. Note container ID from status bar.
- **Steps:** Close Obsidian. Reopen.
- **Expected:** `docker ps` still shows `oas-sandbox` (same ID) while Obsidian is closed. After reopen, status bar shows Running immediately with the same ID.
- **Notes:** P0.

### 2.4 Config change triggers recreate

- **Setup:** Container running.
- **Steps:** In settings, change Write directory. Close the settings tab. In the **Restart Container?** modal that appears (covered in 1.2), click Restart. (If you chose "Later" earlier, the modal won't reappear; use **Sandbox: Restart Container** from the command palette instead.)
- **Expected:** New container ID appears in status bar. Old container is gone.
- **Notes:** P1. Cleanup: revert write directory if it broke anything downstream.

### 2.5 Plugin disable stops the container

- **Setup:** Container running, regardless of auto-stop setting.
- **Steps:** Settings → Community Plugins → disable "Agent Sandbox".
- **Expected:** Container stops within ~10 s. Re-enabling brings it back (per auto-start).
- **Notes:** P0.

### 2.5a Plugin disable/enable cycle leaves no debris

- **Setup:** Container running. DevTools console open.
- **Steps:** Disable "Agent Sandbox", wait 2 s, re-enable it.
- **Expected:** Plugin loads cleanly: ribbon icon present, all 12 commands re-registered in command palette, settings tab renders, no red errors in console. No duplicate status bar pills or ribbon icons.
- **Notes:** P0. Genuinely manual — not reachable in e2e: with the plugin loaded out-of-tree, `disablePlugin`/`enablePlugin` can't round-trip in the harness (skipped probe in `test/e2e/specs/harness-probe.e2e.ts`). Unload cleanup is unit-tested via `StatusBarManager.destroy()` / `FirewallStatusBar.destroy()`.

### 2.6 Settings persist across full Obsidian restart

- **Setup:** Container running.
- **Steps:** Change Terminal font size to 18. Quit Obsidian fully (not reload). Reopen.
- **Expected:** Setting still shows 18. Open a terminal: font reflects it.
- **Notes:** P0. Genuinely manual — not reachable in e2e: `wdio-obsidian-service` loads the plugin out-of-tree, so settings never reach `data.json` and a reboot resets them to defaults (see the skipped probe in `test/e2e/specs/harness-probe.e2e.ts`). Durable persistence is Obsidian's own `saveData`/`loadData` responsibility.

### 2.7 Terminal opens, attaches, renders

- **🟡 Partially automated (font + auto-copy gating)** — the font fallback chain (`composeFontFamily`: user font → Obsidian mono var → portable mono chain) and the auto-copy-on-selection predicate (`shouldAutoCopy`: gated on the opt-out setting, a non-empty selection, and window focus) are unit-tested in `src/__tests__/terminal-view.test.ts`. The live xterm attach, render fidelity (no flicker, no garbled escapes), and clipboard write need a running ttyd and stay manual.
- **Setup:** Container running.
- **Steps:** Ribbon icon (or `open-claude-terminal` command). Type `ls -la /workspace`.
- **Expected:** Tab opens, prompt appears, command runs and prints output. No flicker, no garbled escape sequences.
- **Notes:** P0. "Open in Browser" opens the system's default external browser via `window.open()` (it does not open inside an Obsidian tab); the URL builder `resolveTtydBrowserUrl` is unit-tested in `ttyd-client.test.ts`.

### 2.7a Custom font family

- **Setup:** A non-default monospace font installed on the host (e.g. JetBrains Mono, Fira Code).
- **Steps:** Settings → Terminal → Font family → enter the installed family. Reopen the terminal.
- **Expected:** Glyphs render in the chosen font. Fallback chain works when the family is misspelled (renders default mono, no broken boxes).
- **Notes:** P2.

### 2.7b Status bar icon glyphs

- **Setup:** Container in various states.
- **Steps:** Cycle through stopped → starting → running → error states. Toggle firewall.
- **Expected:** All glyphs render as icons, not `?` or tofu boxes:
  - `Sandbox: ⏹ Stopped`: container stopped. Visible at plugin load when auto-start is off.
  - `Sandbox: ⏳ Starting`: during `docker compose up -d`. Start the container and watch the transition.
  - `Sandbox: ▶ Running`: healthy container.
  - `Sandbox: ⚠ Error`: stop the Docker daemon while the plugin polls; next poll surfaces this state.
  - `Sandbox: 🔍 Checking`: emitted only during `backgroundStartup()`. Re-observe by disabling then re-enabling the plugin, or restarting Obsidian with auto-start on.
  - `🛡 FW`: firewall pill; appears when firewall is enabled.
- **Notes:** P1. Font fallback issues here are platform-specific (esp. older Windows). Awaiting-input badge (trailing ` 🔔` on the sandbox pill) requires an authenticated Claude session (see 3.11).

### 2.8 Terminal themes

- **Setup:** Terminal open with some output.
- **Steps:** Cycle Settings → Terminal → Theme through Follow Obsidian / Dark / Light. Toggle Obsidian's app theme too with "Follow".
- **Expected:** Colours update live (or after a reopen if the setting requires it). Text remains readable on each.
- **Notes:** P1.

### 2.9 Terminal resize reflow

- **Setup:** Terminal open with `htop` or `seq 1 200` printed.
- **Steps:** Drag pane edge to resize narrower then wider.
- **Expected:** Content reflows, no permanent corruption. xterm.js redraws cleanly.
- **Notes:** P1.

### 2.10 Auto-copy on selection opt-out

- **Setup:** Terminal open. Settings → Terminal → Auto-copy on selection = off.
- **Steps:** Select text by drag.
- **Expected:** Clipboard unchanged after selection alone. With a selection active, Ctrl+C copies the selection (matches Terminal.app / iTerm2 convention); confirm clipboard updated and no `^C` printed in the terminal. With no active selection, Ctrl+C sends SIGINT as normal (e.g. interrupts a running `sleep 30`). Right-click Copy also copies on explicit action.
- **Notes:** P1.

### 2.11 Connection retry / exponential backoff

- **🟡 Partially automated (backoff sequence)** — the delay curve (500 ms × 1.5^n, capped at 5 s) is unit-tested in `src/__tests__/ttyd-client.test.ts` ("exponentialBackoff"). The live in-terminal "attempt N/15, retry in Xs" rendering stays manual.
- **Setup:** Container running, one Sandbox terminal tab open.
- **Steps:**
  1. Run **Sandbox: Stop Container** from the command palette.
  2. Observe the loading text in the open terminal tab.
  3. After ≥5 s, run **Sandbox: Start Container**.
- **Expected:** Loading text reads "Connecting to terminal… (attempt N/15, retry in Xs)" with X growing exponentially (500ms × 1.5^n), capped at 5s. When container comes up, terminal establishes.
- **Notes:** P1. Use the plugin commands, not `docker compose` directly. Bare Docker commands bypass the plugin's env vars (`OAS_VAULT_HOST_PATH`, `OAS_TTYD_PORT`, etc.) and produce a misconfigured container.

### 2.11a Startup progress indicator detail

- **Setup:** Obsidian closed, container stopped, auto-start on.
- **Steps:** Open Obsidian. During startup, hover the status bar pill repeatedly. Also open DevTools (Ctrl+Shift+I) → Console tab and filter by "Agent Sandbox" to catch debug-level log entries.
- **Expected:** Status bar pill tooltip cycles through all four phase strings in order: "Starting: checking Docker availability…" → "Starting: probing WSL (5s fast-fail)…" → "Starting: probing container status…" → "Starting: docker compose up -d (auto-start)…". On warm systems the transitions are sub-second, so you may catch only one or two phases via hover; the DevTools console confirms all four fired. Phase 4 fires only when `autoStartContainer` is on and the container is not already running.
- **Notes:** P2. On non-WSL platforms the WSL probe fires and resolves to "not WSL"; the phase still appears.

### 2.12 Out-of-band recreate detection

- **Setup:** Container running, no terminals open yet OR one terminal open.
- **Steps:** From host: `cd container && docker compose down && docker compose up -d`.
- **Expected:** Within 30 s, Notice: "Sandbox container was recreated outside the plugin. Terminal sessions may be disconnected; reopen to reconnect." Existing terminals detach gracefully.
- **Notes:** P1.

### 2.13 Status bar tooltip content

- **🟡 Partially automated (tooltip composition)** — the running-tooltip builder (`recomposeRunningTooltip`: container/port/firewall/MCP lines, the pending-restart line, and the awaiting-input override) is unit-tested in `src/__tests__/status-bar.test.ts` ("running tooltip …" / "pending-restart line is suppressed by attention override"). Hovering the live pill and the exact runtime state values stay manual.
- **Setup:** Container running, MCP on, firewall on.
- **Steps:** Hover the sandbox status-bar pill.
- **Expected:** Tooltip lists container state, MCP state, firewall state. Each line is current (matches command-palette status check).
- **Notes:** P2. Toggle MCP/firewall and re-hover.

### 2.14 `Sandbox: Container Status` command

- **🟡 Partially automated (notice body)** — the composed status lines (running/ID/image/uptime/MCP/firewall) are unit-tested in `src/__tests__/format.test.ts` ("buildContainerStatusLines"). Firing the command and the stopped-state Notice stay manual.
- **Setup:** Container running.
- **Steps:** Command palette → **Sandbox: Container Status**.
- **Expected:** Notice with container ID, image, uptime, MCP/firewall state. With container stopped → Notice explicitly says stopped.
- **Notes:** P2.

### 2.15 `Sandbox: Open Browser` (pop-out terminal)

- **Setup:** Container running.
- **Steps:** Command palette → **Sandbox: Open Browser**.
- **Expected:** Default browser opens at `http://localhost:7681` (or configured ttyd port/bind), terminal accessible. Note: outside Obsidian sandbox so some integrations (URI handler context) won't apply.
- **Notes:** P2.

### 2.16 `Sandbox: Copy terminal connection log`

- **🟡 Partially automated (log format)** — the ring-buffer formatter (timestamp/instance/generation/kind + code/reason/duration/byte-count fields) is unit-tested in `src/__tests__/terminal-view.test.ts` ("formatConnectionLog"). Clipboard copy and live lifecycle capture stay manual.
- **Setup:** Open and close one terminal tab.
- **Steps:** Run the copy log command.
- **Expected:** Clipboard contains a multi-line log of the connection lifecycle for **all** terminal sessions in this Obsidian instance: connect/disconnect/error/reconnect events, timestamps, session byte counts, and connection durations. The ttyd WebSocket URL (`ws://host:port/ws`) carries no auth token. Paste into a scratchpad to verify format and content.
- **Notes:** P2. Covers all terminals in this session, not only the most recent. The log is in-memory: it is lost when Obsidian closes.
### 2.17 Image rebuild triggers recreate

- **Setup:** Container running on `oas-sandbox:latest`.
- **Steps:** On host: `cd container && docker compose build`. Run **Sandbox: Restart Container**.
- **Expected:** `docker inspect oas-sandbox --format '{{.Image}}'` shows the new image id. Any baked-in change is visible in a new terminal.
- **Notes:** P1.

### 2.18 Workspace persistence

- **✅ Automated (named-volume persistence)** — `test/integration/container-restart.test.ts` writes a marker into the shell-history named volume, runs `docker restart oas-test-sandbox`, waits for ttyd to come back healthy, and asserts the marker survives. It targets a **named volume** (the meaningful ephemeral-vs-persistent property); the literal `/workspace/.claude/...` path in the steps below is a host **bind mount** that persists trivially, so the manual run is only worth it to confirm the bind-mount path specifically.
- **Setup:** Container running, terminal open.
- **Steps:** In the container: `echo "marker $(date +%s)" >> /workspace/.claude/persist-check.md`. Restart container. New terminal: `cat /workspace/.claude/persist-check.md`.
- **Expected:** File and marker line present after restart.
- **Notes:** P1. Cleanup: `rm /workspace/.claude/persist-check.md`.

### 2.19 Custom sudo password

- **Setup:** Container not running.
- **Steps:** In Advanced → Sudo password, use the secret component to create/select a secret holding a memorable sentinel value (e.g. `oas-qa-sentinel-9173`). Restart container. In a terminal: `sudo -k && sudo apt-get update` (enter the sentinel when prompted).
- **Expected:** Accepts the password; `apt-get update` runs. Setting the field back to empty (no secret selected) then restarting disables sudo entirely (`sudo apt-get update` should refuse without the error mentioning `no-new-privileges`).
- **Notes:** P1. Reset to default afterwards. Sudoers is restricted to `apt-get`/`apt` only; other `sudo` commands are rejected regardless of password. The password is stored via Obsidian secret storage (app-level local storage, outside the vault mount); it is **not** mounted inside the container, so the agent cannot read it. Toggling the sudo password between empty and non-empty changes the container's `security_opt` set, so the next start/restart recreates the container (compose detects the config drift). New container ID expected.

### 2.19a Sudo password secret storage (isolation + persistence)

- **Setup:** Sudo password set to a unique sentinel via 2.19 (e.g. `oas-qa-sentinel-9173`).
- **Steps:**
  1. **Settings hold only the name:** open `<vault>/.obsidian/plugins/obsidian-agent-sandbox/data.json` and inspect `sudoSecretId`.
  2. **Value never lands in the vault:** from the host, run `grep -rIl 'oas-qa-sentinel-9173' <vault-path>` (the whole vault, including `.obsidian/`).
  3. **Persists across restart:** fully quit and reopen Obsidian, then run sudo in a container terminal as in 2.19 (no re-entry of the password in settings).
- **Expected:**
  1. `data.json` contains `"sudoSecretId": "<the secret's name>"` — **not** the sentinel value.
  2. The `grep` returns **nothing** (the plaintext sentinel is absent from the vault tree the container mounts). It *does* live in Obsidian's app-level local storage (outside the vault, e.g. `~/.config/obsidian/…` on Linux), which the container does not mount.
  3. After restart the password still gates sudo — the value survived via secret storage, not a re-entry.
- **Notes:** P1. Step 2 is the load-bearing security check; treat step 3 (sudo actually works post-restart) as proof the value is genuinely persisted, since a clean grep alone would also pass if no value were stored at all. As of Obsidian 1.11.4 the value is plaintext at rest in local storage (parity with the prior `secrets.json`); isolation from the container, not at-rest encryption, is the property under test.

---

## Stage 3: Claude authenticated, MCP enabled

**Setup carried forward:** Stage 0–2, plus Claude logged in inside the container (`docker compose exec sandbox claude` once) and MCP enabled in plugin settings.

**How Stage 3 works.** This stage has two parts. The human configures the plugin into a permission cell (3.1–3.3) and runs the Claude-driven capability sweep against that configuration; then the human-only scenarios (3.4–3.11) catch what the sweep can't observe. The capability test validates schema shapes, error messages, and per-tier gating exhaustively; the scenarios below catch UI/UX and host-process behaviour that requires a human at the keyboard.

**Tier model (`src/permission-tiers.ts`):**
- Always-on when MCP is enabled: `read`, `writeScoped`, `agent`.
- Toggled per-tier: `navigate`, `manage`, `extensions`.
- Vault-wide writes (dropdown, labels `None` / `Reviewed` / `Full (no review)`): `None` (default, stored value `scoped`, no extra tier) / `Reviewed` (`writeReviewed` tier, diff modal per change) / `Full (no review)` (`writeVault` tier, unrestricted, no review).

### 3.1 Permission cells matrix

- **✅ Automated (tier gating)** — `test/e2e/specs/bridge.e2e.ts` ("Bridge C1: permission-tier matrix") configures six cells against the real plugin and asserts, per cell, that `mcp_capabilities` reports the right enabled tiers and that the registered tool set (cross-checked against `tools/list`) contains a gated tool iff its tier is on (`vault_open`/navigate, `vault_rename`/manage, `vault_modify_reviewed`/reviewed, `vault_modify_anywhere`/full). Tier filtering is list-time (`mcp-server.ts` `buildTools(...).filter`), so this is a deterministic regression gate. **Not covered by the matrix:** the `extensions` tier — its tools probe for Dataview / Templater / Tasks / Canvas, which aren't installed in the test vault, so they don't register regardless of the toggle; extensions-tier gating stays in the capability sweep below. The sweep is otherwise now only the **LLM-behaviour** sanity check (does Claude pick the right tool, honour a denial), not the tier-gating proof.

Each cell is a specific combination of plugin settings. Run [mcp-capability-test.md](./mcp-capability-test.md) under each relevant cell. For release validation run all six; for focused regression testing run only cells affected by the change.

| Cell | Nav | Mng | Ext | Write mode | Active tier tags                                       |
| ---- | --- | --- | --- | ---------- | ------------------------------------------------------ |
| A    | ON  | ON  | ON  | none       | read, writeScoped, agent, navigate, manage, extensions |
| B    | ON  | ON  | ON  | reviewed   | + writeReviewed                                        |
| C    | ON  | ON  | ON  | full       | + writeVault                                           |
| D    | OFF | ON  | ON  | none       | read, writeScoped, agent, manage, extensions           |
| E    | ON  | OFF | ON  | none       | read, writeScoped, agent, navigate, extensions         |
| F    | ON  | ON  | OFF | none       | read, writeScoped, agent, navigate, manage             |

> **Note:** `reviewed` and `full` are mutually exclusive vault write modes: only one of `writeReviewed` / `writeVault` is active at a time. See `vaultWriteTiers()` in `plugin/src/permission-tiers.ts`.

**Full-sweep cells (A, B, C):** run every capability-test scenario; skip those whose `Requires:` tag is not in the active set.

**Smoke cells (D, E, F):** only visit scenarios that *become* skipped in this cell; these confirm the tier gate is working. Always run S0.1 (capability discovery) and S9.5 (disabled-tier gate check).

**Run-file naming:** `workspace/mcp-testing/<YYYY-MM-DD>-cell-<letter>-<short-name>.md`. Examples: `2026-05-26-cell-A-baseline.md`, `2026-05-26-cell-D-nav-off.md`.

- **Notes:** P0. Gates the entire MCP tool surface.

### 3.2 Cell setup walkthrough

Repeat for each cell before handing the capability test to Claude:

1. **Settings → MCP**: confirm `Enable MCP server` is on.
2. In the **Escalations** section: set the Navigate / Manage / Extensions toggles and the Vault-wide writes dropdown to match the cell's row in the matrix above.
3. **Sandbox: Toggle MCP Server** (command palette): off, then on, so the server re-publishes the tool list with the new settings.
4. Verify in a terminal: `claude -p "Call mcp_capabilities and tell me which tier tags are enabled."` Confirm the response matches the cell's "Active tier tags" column exactly.
5. Open `docs/mcp-capability-test.md` and hand it to the in-container Claude session. Save the run to `workspace/mcp-testing/<YYYY-MM-DD>-cell-<letter>-<short-name>.md`.

- **Notes:** P0. If step 4 doesn't match, toggle MCP off/on again before proceeding.

### 3.3 Sanity-diff run against code

After all cells are complete, skim the run files for any PASS scenario that relied on a tool name or tier tag that may have changed in `plugin/src/mcp-tools.ts` since the run was recorded. Most release cycles this is a no-op.

- **Notes:** P1.

### 3.4 Always-on tiers have no toggle

- **✅ Automated** — `test/e2e/specs/smoke.e2e.ts` ("MCP tab shows permission tier toggles") asserts the Escalations section renders the Navigate / Manage / Extensions toggles plus the Vault-wide writes dropdown, while `read` and `writeScoped` appear only as non-interactive "Always enabled" bullets (not toggles). No manual step.

### 3.5 Navigate tier: active tab changes (UI assertion)

- **✅ Automated** — `test/e2e/specs/bridge.e2e.ts` ("drives a real UI effect: vault_open changes the active file") POSTs a navigate-tier `vault_open` to the real plugin and asserts the active tab changes. The LLM-driven invocation (`claude -p "Open …"`) is an optional manual sanity check.

### 3.6 MCP token rotation kicks live connections

- **✅ Automated (auth rejection)** — `test/e2e/specs/bridge.e2e.ts` ("3.6 token rotation rejects the old token, accepts the new") rotates the token on the real plugin server and asserts a connection with the old token is rejected (HTTP 401/403) while the new token is accepted. The container tier (`test/e2e/container/bridge-container.e2e.ts`) also proves token accept/reject from inside a live container. Manual residual: the in-CLI `/mcp` reconnect dance after a rotation is Claude-CLI behaviour.
- **Setup:** Active Claude session connected to MCP.
- **Steps:** Click Regenerate token in plugin settings. In the same terminal, try another tool call.
- **Expected:** The next call fails auth. Restarting the container per the regenerate-button description, then restarting Claude, restores tool access.
- **Notes:** P1.

### 3.7 MCP turn-off mid-session

- **✅ Automated (connection drop)** — `test/e2e/specs/bridge.e2e.ts` ("3.7 turning MCP off drops connections; re-enabling restores them") turns the server off mid-session and asserts a reconnect fails, then re-enables and asserts a fresh session connects. Manual residual: the user-visible `/mcp` reconnect step in the Claude CLI is CLI behaviour.
- **Setup:** Active Claude session that recently used a vault tool.
- **Steps:** Toggle MCP off via command palette. In the same terminal, submit another tool-using prompt.
- **Expected:** The toggle force-closes all active HTTP connections (including SSE keepalives). The running `claude` process receives a connection error and cannot continue using vault tools. Re-enabling MCP alone is not enough: the user must run `/mcp` in the terminal to reconnect the Claude CLI session to the newly restarted server.
- **Notes:** P1. The force-close is intentional (prevents EADDRINUSE on next start). The `/mcp` reconnect step is the only user-visible consequence. See also the code comment at `mcp-server.ts:223`.

### 3.8 MCP cache invalidates on live edits

- **✅ Automated (graph cache)** — `test/e2e/specs/bridge.e2e.ts` ("3.8 vault_backlinks reflects a live link added after the first read") reads `vault_backlinks`, adds a backlink live in Obsidian, waits for the `resolved` event, and asserts the next call reflects it. `VaultCache` keys the **link graph and tag/property counts** (not raw file content) and clears wholesale on `resolved`, so backlinks is the meaningful target. The content-read freshness below (`version A` → `version B`) is a separate non-cached path and stays a manual spot-check.
- **Setup:** `notes/cache.md` with first line `version A`. Vault open in Obsidian.
- **Steps:** 1) `claude -p "Read notes/cache.md and quote the first line"`. 2) In Obsidian, edit the note's first line to `version B` (Obsidian saves continuously, no explicit save needed). 3) Shortly after editing, re-read via Claude.
- **Expected:** Second read returns `version B`. The cache invalidates on Obsidian's `metadataCache.resolved` event, typically within a second or two of the file changing. If the second read still returns `version A`, wait 5 s and retry once; document any lag >5 s.
- **Notes:** P1. Stale reads after user edits are silent and confusing.

### 3.9 Concurrent MCP tool calls

- **✅ Automated (parallel burst)** — `test/e2e/specs/bridge.e2e.ts` ("3.9 resolves a parallel burst of tool calls without error") fires a `Promise.all` burst of read-tier calls against the real plugin and asserts none deadlock or return `isError` (burst kept under the 60/min read rate limit). Manual residual: interleaving across a live multi-tool Claude conversation.
- **Setup:** Vault with ≥10 notes containing "alpha" and ≥10 containing "beta".
- **Steps:** `claude -p "In parallel, search the vault for 'alpha' and for 'beta' and read the first three hits of each."`
- **Expected:** All calls complete without deadlock or `isError`. DevTools shows interleaved tool-call logs.
- **Notes:** P1. The capability test adds S9.6 for matrix completeness, but interleaving shows up only in a live conversation session, which is why this scenario stays here.

### 3.10 File ownership after Claude writes (Linux)

- **✅ Automated (Linux)** — `test/integration/container.test.ts` ("files the container writes are owned/editable by the host user") has the container write into the bind-mounted write dir and asserts the host-side file is owned by the host uid (or host-writable). Linux-gated, since macOS Docker Desktop and WSL drvfs remap ownership.
- **Setup:** Linux host, vault on host filesystem. Note host uid: `id -u`.
- **Steps:** `claude -p "Create agent-workspace/owner-test.md with content 'check uid'"`. Then: `ls -la <vault>/agent-workspace/owner-test.md` and edit in Obsidian.
- **Expected:** Obsidian edits the file without permission errors. Owner uid matches host uid, or mode is permissive enough that the host user can write.
- **Notes:** P1. Cleanup: delete the file.

### 3.11 Awaiting-input badge

- **✅ Automated** — `test/e2e/specs/bridge.e2e.ts` ("3.11 agent_status_set awaiting_input toggles the status-bar bell") calls `agent_status_set` against the real plugin and asserts the status-bar pill gains then clears the trailing ` 🔔`.

### 3.12 MCP proxy: one diagnostic per unreachable burst

- **✅ Automated** — `test/integration/proxy.test.ts` spawns `obsidian-mcp-proxy.js` against a dead upstream port with a token set, feeds it two JSON-RPC requests, and asserts **exactly one** `[obsidian-mcp-proxy] unreachable` stderr line (burst suppression), that it names the host/port + `reason=ECONNREFUSED`, that the bearer token never appears, and that the client still gets an empty tool list. Pure Node — it never touches the container, so it also runs when Docker is unavailable. The live toggle-MCP-off-mid-session flow stays a manual spot-check.
- **Setup:** Active Claude session with MCP on. `docker compose logs -f sandbox` open in a host terminal to watch container stderr in real time.
- **Steps:** With a container Claude session attached, toggle MCP off via **Sandbox: Toggle MCP Server**. Immediately run a vault tool call in the terminal (e.g. `claude -p "List vault files"`). Wait a few seconds, then toggle MCP back on.
- **Expected:** In `docker compose logs`, the proxy (`workspace/.claude/scripts/obsidian-mcp-proxy.js`) emits **exactly one** structured stderr line during the unreachable window — not a line per retry. The line names the resolved host/port and a reason (`TIMEOUT_2S`, `ECONNREFUSED`, or a DNS reason). The line does **not** contain the MCP bearer token (`OAS_MCP_TOKEN`). Once MCP is re-enabled and reachable, no further diagnostic lines appear for the same host/port.
- **Cleanup:** Confirm MCP is back on (status bar tooltip or Settings → MCP → Enable MCP server).
- **Notes:** P2. Only exercisable with a live proxy process. Verifies the burst-suppression behaviour introduced in commit `6b8de46`: the proxy emits once per availability flip, not once per failed probe.

---

## Stage 4: Human-in-the-loop review modals

**Setup carried forward:** Stage 0–3, plus Settings → MCP → **Vault-wide writes = Reviewed**.

**✅ Automated (4.1, 4.2, 4.4, 4.5; 4.3 modal render)** — the bridge layer (`test/e2e/specs/bridge.e2e.ts`, see `docs/testing.md` → Layer 3b) drives these end-to-end against the real plugin: it POSTs a reviewed-tier tool call over loopback, drives the modal in real Obsidian, then asserts the file outcome. The scenarios below are the reference spec + the manual residual (4.6 responsiveness; the rename *apply* — see 4.3).

### 4.1 Content diff modal

- **✅ Automated** — `bridge.e2e.ts` ("4.1 … Approve applies the edit" / "4.5 … Reject leaves the file untouched") fires `vault_modify_reviewed`, asserts the diff renders added/removed lines, then Approve writes the file and Reject leaves it untouched with "Change rejected by user." Manual only for the visual quality of the diff (colour, scrolling).

### 4.2 Frontmatter JSON diff

- **✅ Automated** — `bridge.e2e.ts` ("4.2 frontmatter diff — Approve sets the property") fires `vault_frontmatter_set_reviewed`, asserts the "Set frontmatter" modal, then Approve writes the YAML.

### 4.3 Rename/move affected-links list

- **✅ Automated (modal + affected-links) / manual (apply)** — `bridge.e2e.ts` ("4.3 rename — affected-links list lists the backlinks") seeds two linking notes, fires `vault_rename`, and asserts the "Review: Rename file" modal lists exactly the 2 backlinks. The actual rename apply (`app.fileManager.renameFile`) does not settle under the headless wdio harness, so the spec takes the Reject path; verify the rename + backlink rewrite by hand (the apply path is unit-tested).
- **Notes:** P0.

### 4.4 Batch review checkboxes

- **✅ Automated** — `bridge.e2e.ts` ("4.4 batch review — uncheck one, approve the rest") fires `vault_batch_frontmatter` over a seeded folder, unchecks one row in `BatchReviewModal`, and asserts only the still-checked files are updated.

### 4.5 Reject persists in conversation

- **✅ Automated (tool result)** — `bridge.e2e.ts` asserts a rejected reviewed write returns isError "Change rejected by user." with the file untouched. That a real Claude *conversation* then doesn't silently retry is LLM behaviour and stays a manual spot-check.

### 4.6 Approve on big diff stays responsive

- **🟡 Partially automated (large diff renders)** — `test/e2e/specs/bridge.e2e.ts` ("4.6 large (~500-line) diff renders without error and approves") fires `vault_modify_reviewed` with a ~500-line rewrite, asserts the diff modal renders both sides (>100 added and >100 removed lines) and that Approve applies the change. This is a render-without-error guard, **not** a latency assertion — CI timing is too noisy to gate on "<1 s / scrolls smoothly", which stays the manual residual below.
- **Setup:** A note ~500 lines long.
- **Steps:** Have Claude rewrite many lines. Open the review modal.
- **Expected:** Modal renders in <1 s, scrolls smoothly, syntax-highlighted diff still legible. No Obsidian UI freeze.
- **Notes:** P2.

---

## Stage 5: Activity feedback, sessions, notices

**Setup carried forward:** Stage 0–3.

### 5.1 Tab title + badge on Claude state

- **🟡 Partially automated (title composition)** — the tab-title string (⚙/✓/❓ prefix + `Session: <name>` / `Sandbox Terminal <n>` base) is unit-tested in `src/__tests__/terminal-view.test.ts` ("composeTabTitle"). The live tab repaint on state change and the status-bar badge integration stay manual (badge logic itself is covered by `bridge.e2e.ts`, see 5.2).
- **Setup:** Open terminal, attach to named session `work`, run `claude` interactively.
- **Steps:** Submit a long-running prompt. Then submit one that triggers an approval question (or use `writeReviewed`).
- **Expected:** While working → tab title `⚙ Session: work`. Idle between prompts (after a turn completes, the Stop hook sets `idle`) → `✓ Session: work`; the bare `Session: work` with no symbol only appears for a terminal that has not yet run Claude. Awaiting input → `❓ Session: work` AND status bar pill grows a `🔔` badge whose tooltip reads `Sandbox running. 1 session(s) awaiting input: work` followed by a `Click for options` line.
- **Notes:** P0. Close+reopen Obsidian → badge clears (activity is ephemeral).

### 5.2 Multi-session independence

- **✅ Automated (badge logic)** — `test/e2e/specs/bridge.e2e.ts` ("5.2 idle sessions don't raise the badge; awaiting ones do") sets one session idle and another awaiting via `agent_status_set` and asserts an idle-only session never raises the bell, while an awaiting one does and clears correctly. The running-state tooltip that *names* the waiting sessions only composes when the container is running, so its precise text (and the `⚙` tab-title prefix on a live terminal tab) stays a manual check.
- **Setup:** Two sessions `work` and `research`, both running Claude.
- **Steps:** Prompt `work`, leave `research` idle.
- **Expected:** Only `work` shows `⚙` prefix. Badge count reflects only sessions awaiting input.
- **Notes:** P1.

### 5.3 Badge tooltip clears when session goes idle

- **Setup:** Session `a` in awaiting-input state.
- **Steps:** Answer the question; wait for transition to idle. Hover status bar pill.
- **Expected:** `🔔` badge gone; tooltip back to default running tooltip. No stale "1 session(s) awaiting input: a" string.
- **Notes:** P1.

### 5.4 Toggle MCP off clears awaiting-input state

- **✅ Automated (badge clears)** — `test/e2e/specs/bridge.e2e.ts` ("5.4 toggling MCP off clears the awaiting-input badge") sets an awaiting-input status, turns the MCP server off (`applyMcpEnabled(false)` → `clearActivity`), and asserts the bell clears. The tooltip-text half needs a running container (see 5.2) and stays a manual check.
- **Setup:** Session in awaiting-input state.
- **Steps:** Run **Sandbox: Toggle MCP Server**.
- **Expected:** Badge AND tooltip both clear.
- **Notes:** P1.

### 5.5 Hook script no-ops when MCP off

- **✅ Automated** — `test/integration/hooks.test.ts` runs `notify-status.sh` inside the test container with `OAS_MCP_TOKEN` unset (which is exactly what "MCP off" means: the plugin omits the env var when `mcpEnabled` is false, no restart needed) and asserts it exits 0 with no output for every wired status, plus exits 0 on an invalid status — the silent-failure contract. No manual step.
- **Setup:** MCP off. Terminal attached.
- **Steps:** `bash .claude/hooks/notify-status.sh awaiting_input`.
- **Expected:** Exits 0. No errors. No plugin crash.
- **Notes:** P2.

### 5.6 Agent output Notice: debounced bursts

- **🟡 Partially automated (debounce/aggregation)** — `src/__tests__/activity.test.ts` ("fires a single notice for one create after debounce elapses", "aggregates burst of creates into one notice") drives `AgentOutputNotifier` with fake timers and asserts the emitted Notice text. The live Claude file-create chain stays manual.
- **Setup:** General → Agent output notifications → `Notify on file created` = on (the default).
- **Steps:** `claude -p "Create three files under agent-workspace/: a.md b.md c.md each with just 'x'."`
- **Expected:** A single Notice ~2 s after the last create: "Agent output: 3 created" (not three notices).
- **Notes:** P1.

### 5.7 Agent output Notice: rate-limit doesn't drop

- **🟡 Partially automated (rate-limit requeue)** — `src/__tests__/activity.test.ts` ("requeues buffered events under rate-limit instead of dropping them", "second burst after rate-limit window starts fresh") asserts the batched remainder is emitted after the window, not dropped. The live timing chain stays manual.
- **Setup:** Same toggle (`Notify on file created` = on). First burst fired.
- **Steps:** Within ~3 s, prompt another batch of 2 files.
- **Expected:** ~5 s after the first Notice, a second Notice appears for the batched remainder ("Agent output: 2 created"). Not silently dropped.
- **Notes:** P1.

### 5.8 `Notify on file edited` fires for modifies

- **🟡 Partially automated (modify gating)** — `src/__tests__/activity.test.ts` ("fires for modify events when notifyEdited is true" / "ignores modify events when notifyEdited is false") covers the toggle. Live Claude modifies stay manual.
- **Setup:** Enable `Notify on file edited` (off by default).
- **Steps:** Prompt Claude to modify two existing files.
- **Expected:** Notice fires for the modifies.
- **Notes:** P2.

### 5.9 All notify toggles off → silent

- **🟡 Partially automated (all-off silence)** — `src/__tests__/activity.test.ts` ("all-off suppresses everything") asserts no Notice fires with every toggle off. The live trigger stays manual.
- **Steps:** Turn off all four `Notify on file created / edited / deleted / renamed-moved` toggles. Trigger creates/modifies.
- **Expected:** No Notices.
- **Notes:** P2.

### 5.10 Session switcher

- **✅ Automated** — `test/e2e/specs/sessions.e2e.ts` ("Session switcher") opens three real terminal tabs (`work`, `research`, unnamed) via `activateTerminalView` — which has no container guard, so the tabs exist headlessly with no ttyd — fires the switch command, and asserts the modal lists `Session: work / research / (unnamed)`, that typing filters to the matching row, and that selecting a row activates the matching leaf. No manual step.
- **Setup:** Three terminal tabs: two named (`work`, `research`), one unnamed.
- **Steps:** Command palette → **Sandbox: Switch to Sandbox session…**. Type to filter. Enter on a result.
- **Expected:** Modal lists `Session: work`, `Session: research`, and `Session: (unnamed)` for the unnamed one. Filter narrows. Selecting activates the matching tab.
- **Notes:** P1.

### 5.11 Session switcher handles closed tabs mid-modal

- **✅ Automated** — `test/e2e/specs/sessions.e2e.ts` ("5.11: clicking a row whose tab closed mid-modal …") opens the switcher, detaches the `research` leaf from under the open modal, clicks its still-rendered row, and asserts the "That session has closed." Notice fires (the row handler revalidates the leaf before activating). No manual step.
- **Setup:** Two named tabs.
- **Steps:** Open the switcher. Without dismissing, close one tab from another pane. Click the closed-tab row.
- **Expected:** Notice "That session has closed." Modal closes cleanly. No crash.
- **Notes:** P1.

### 5.12 Clean up detached sessions

- **✅ Automated (modal + aggregate)** — `test/e2e/specs/sessions.e2e.ts` ("Detached-session cleanup") stubs the injected `SessionCleanupApi` (`docker.listDetachedSessions`/`killSession`) and `isContainerRunning` on the live plugin, fires the cleanup command, asserts only the detached candidates are listed, unchecks one, clicks Kill selected, and asserts exactly one `killSession` call plus the "Killed 1/1 session(s)." Notice (and the empty-list "No detached tmux sessions to clean up." path). The real tmux kill against a live container stays the manual residual.
- **Setup:** Two tmux sessions created, one attached in Obsidian, one detached.
- **Steps:** Command palette → **Sandbox: Clean up detached sessions**. Modal appears.
- **Expected:** Only the detached one listed. Uncheck to keep / check to kill. Kill selected → Notice "Killed 1/1 session(s).".
- **Notes:** P1.

### 5.13 Failed kill is logged, not swallowed

- **🟡 Partially automated (name validation)** — the load-bearing half (a space/metachar session name is rejected, so the kill fails and is counted rather than silently swallowed) is unit-tested via `isValidSessionName` in `src/__tests__/validation.test.ts` ("rejects whitespace", "rejects semicolon", "rejects newline (terminal injection)", …). The modal flow + aggregate "Killed 1/2 session(s)." Notice stay manual.
- **Setup:** Create two detached tmux sessions inside a container terminal, one with a valid name and one with an invalid name (space character, which `assertSafeSessionName` in `docker.ts` rejects against `[\w.-]+`):
  ```bash
  tmux new-session -d -s validname
  tmux new-session -d -s tempname
  tmux rename-session -t tempname "bad name"
  ```
- **Steps:** Command palette → **Sandbox: Clean up detached sessions**. Check both sessions in the modal → Kill selected.
- **Expected:** `validname` is killed. `bad name` fails name-validation; the failure is logged to DevTools console as `[Agent Sandbox] [sessions] failed to kill tmux session 'bad name': …`. Aggregate Notice reports `Killed 1/2 session(s).`.
- **Cleanup:** `tmux kill-session -t "bad name"` inside the container if it survived the failed kill.
- **Notes:** P2.

---

## Stage 6: URI handlers + context menu

**Setup carried forward:** Stage 0–3.

### 6.1 obsidian:// open-terminal

- **🟡 Partially automated (handler opens a tab)** — `test/e2e/specs/uri-handler.e2e.ts` ("6.1: with the container running …") invokes `handleOpenTerminalUri()` with `isContainerRunning` stubbed true and asserts a terminal leaf is created (its WebSocket attach fails harmlessly with no ttyd, but the tab — which is what the URI guarantees — exists). Dispatching the real `obsidian://` URI and the live attach stay manual.
- **Steps:** Paste `obsidian://agent-sandbox/open-terminal` into a browser URL bar.
- **Expected:** Obsidian focuses, opens a new terminal tab.
- **Notes:** P1.

### 6.2 obsidian:// analyse

- **Setup:** Vault note `notes/foo.md` exists. A `summarize.md` prompt template is in `<vault>/.oas/prompts/summarize.md` (copy from `workspace/.claude/prompts/summarize.md` if needed; that folder holds examples to copy from, not the live location).
- **Steps:** `obsidian://agent-sandbox/analyse?vault=<your-vault-name>&path=notes/foo.md&template=summarize`.
- **Expected:** New terminal opens; first command typed is the summarize template with `@notes/foo.md` substituted.
- **Notes:** P1. The `vault=` parameter is required when multiple vaults are open; omitting it causes Obsidian to show "Vault Not Found". Templates are loaded from `<vault>/.oas/prompts/*.md`, not from `workspace/.claude/prompts/`.

### 6.3 Context menu → Analyse in Sandbox

- **Setup:** `<vault>/.oas/prompts/` populated with the four shipped templates (copy from `workspace/.claude/prompts/` if needed).
- **Steps:** Right-click a vault note → **Analyse in Sandbox**.
- **Expected:** Submenu shows the four template labels sorted alphabetically — Critique, Explain, Extract TODOs, Summarise (note British spelling, the label is the template file's first line) — plus "Custom prompt…". Picking one opens a new terminal and seeds the prompt.
- **Notes:** P1. Templates are loaded from `<vault>/.oas/prompts/` at plugin load; changes there require an Obsidian reload to take effect.

### 6.4 Templates render on first right-click after reload

- **Setup:** `<vault>/.oas/prompts/` populated with the four shipped templates. Fully reload Obsidian.
- **Steps:** **Immediately** after Obsidian finishes loading, right-click a vault note → **Analyse in Sandbox**.
- **Expected:** Submenu already populated, not collapsed to "Custom prompt…" only.
- **Notes:** P1.

### 6.5 Empty prompts dir collapses submenu

- **Setup:** Move `<vault>/.oas/prompts/*` aside (or delete the folder).
- **Steps:** Reload Obsidian. Right-click a note → Analyse in Sandbox.
- **Expected:** Submenu shows only "Custom prompt…", which opens a modal. Typing text and clicking Run → new terminal with the one-off prompt.
- **Notes:** P2. Restore prompts after.

### 6.6 Custom prompt modal edge inputs

- **Setup:** Templates present.
- **Steps:** Right-click → Analyse in Sandbox → Custom prompt. In turn: 1) empty + Run, 2) Cancel, 3) ~2000-character prompt, 4) prompt with shell metacharacters: `` echo `id`; $(whoami) && rm -rf /tmp/nope ``.
- **Expected:** 1) Treated as a cancel — `inputModal` trims the value, so an empty/whitespace input resolves to nothing and no terminal opens (no separate validation hint). 2) Modal closes; no terminal. 3) Terminal opens with full text seeded, no truncation. 4) Metacharacters passed to `claude` as a single argument; `id` / `whoami` must not execute on open.
- **Notes:** P1. Shell-escaping regressions here are a command-injection risk.

---

## Stage 7: Symlink and path-traversal real-filesystem checks

**Setup carried forward:** Stage 0–3.

**✅ Automated** — `test/e2e/specs/security.e2e.ts` runs the denial cases 7.1–7.3 in CI against the real plugin MCP server inside wdio-Obsidian (real symlink fixtures on disk + `vault_read` / `vault_create` calls over loopback). The 7.4 allow-path (a symlink resolving back inside the vault must not be over-blocked) is covered by `src/__tests__/mcp-symlink.test.ts` ("allows a file whose realpath stays inside the base"): it can't run in the e2e harness because `vault_list` / `vault_read` resolve via Obsidian's metadata index, which never indexes a symlink created after load (the call fails "Folder not found" before the realpath guard is reached — an indexing artifact, not a security result). `mcp-symlink.test.ts` also unit-tests `isRealPathWithinBase` directly. The scenario bodies below are the reference spec — run 7.4 by hand only when verifying the allow-path end-to-end.

### 7.1 Read of escaping symlink is denied

- **✅ Automated** — `test/e2e/specs/security.e2e.ts` ("7.1 denies reading an escaping symlink and never leaks host content").
- **Setup:** From inside a container terminal, create a symlink in the write directory (which is rw) pointing outside the vault:
  ```bash
  ln -s /etc/hosts /workspace/vault/$OAS_VAULT_WRITE_DIR/evil.md
  ```
- **Steps:** `claude -p "Use vault_read to read agent-workspace/evil.md"`. Instruct Claude to use MCP, not direct filesystem read.
- **Expected:** `vault_read` returns "File not found." (the escaping symlink resolves outside the vault, so the read path treats it as absent). Real `/etc/hosts` is never returned.
- **Cleanup:** `rm /workspace/vault/$OAS_VAULT_WRITE_DIR/evil.md`.
- **Notes:** P0. The vault root is mounted `:ro` inside the container, so create symlinks in `$OAS_VAULT_WRITE_DIR` (`:rw`) instead. Direct filesystem access by Claude is not under test here; the instruction must trigger an MCP `vault_read` call so `isRealPathWithinBase` is exercised.

### 7.2 Create into symlinked directory denied

- **✅ Automated** — `test/e2e/specs/security.e2e.ts` ("7.2 denies creating into a symlinked-out directory").
- **Setup:** From inside a container terminal:
  ```bash
  ln -s /tmp /workspace/vault/$OAS_VAULT_WRITE_DIR/escape
  ```
- **Steps:** `claude -p "Use vault_create to create agent-workspace/escape/note.md with content 'hi'"`.
- **Expected:** `vault_create` returns "Path resolves outside the vault (symlink)." No file is created under `/tmp`.
- **Cleanup:** `rm /workspace/vault/$OAS_VAULT_WRITE_DIR/escape`.
- **Notes:** P0.

### 7.3 Nested symlinks resolve fully

- **✅ Automated** — `test/e2e/specs/security.e2e.ts` ("7.3 denies reading through a nested escaping symlink").
- **Setup:** From inside a container terminal:
  ```bash
  mkdir /workspace/vault/$OAS_VAULT_WRITE_DIR/innocent
  ln -s /tmp /workspace/vault/$OAS_VAULT_WRITE_DIR/innocent/inner
  ```
- **Steps:** `claude -p "Use vault_read to read agent-workspace/innocent/inner/x.md"`.
- **Expected:** Denied: "Path resolves outside the vault (symlink)" or similar. The realpath check resolves through multi-level symlinks.
- **Cleanup:** `rm -r /workspace/vault/$OAS_VAULT_WRITE_DIR/innocent`.
- **Notes:** P1.

### 7.4 Symlink inside write directory but pointing into vault

- **🟡 Partially automated (allow-path, unit only)** — `src/__tests__/mcp-symlink.test.ts` ("allows a file whose realpath stays inside the base") plus a direct `isRealPathWithinBase` unit test cover the allow-path. It can't run in the e2e harness: Obsidian's metadata index never indexes a symlink created after load, so the call fails "Folder not found" before the realpath guard is reached. The end-to-end allow-path stays manual.
- **Setup:** `ln -s <vault>/notes <vault>/agent-workspace/safe-link`.
- **Steps:** `claude -p "Read agent-workspace/safe-link/<some-file>.md"`.
- **Expected:** Read succeeds: the realpath check resolves the symlink to a vault-relative target inside the read-allowed area. Outcome is deterministic across repeated runs and matches `docs/reference/settings.md`.
- **Notes:** P2. Flag mismatches against documentation.

---

## Stage 8: Firewall

**Setup carried forward:** Stage 0–3.

**✅ Automated (egress + tagging)** — `test/integration/firewall.test.ts` runs against the shared test container in CI: 8.3 (extras file readable by the agent but not writable — read-only mount), enable/disable/`--status` transitions, 8.4 (`--list-sources` tags `[baseline]` + `[plugin]`), 8.2 (allowlisted domain reachable, non-allowlisted blocked), and 8.6 (egress restored when disabled). The egress probes inject a `[plugin]` domain via `OAS_ALLOWED_DOMAINS` and self-skip when the CI environment lacks outbound (baseline domains can't resolve). The scenario bodies below are the reference spec. **Manual residual:** the `[file]` tag (needs a non-empty `firewall-extras.txt`, a tracked comments-only file), 8.1 (live toggle UI), and 8.5 (Effective allowlist refresh button).

### 8.1 Firewall on/off toggle live

- **🟡 Partially automated (state machine)** — `test/integration/firewall.test.ts` ("reports enabled after a successful apply, disabled after --disable") covers the enable/disable/`--status` transitions. The live status-bar pill, tooltip, and ~2 s UI update stay manual.
- **Steps:** Toggle firewall via command palette and via settings; observe status bar firewall icon (🛡️).
- **Expected:** State updates within ~2 s. Status bar pill tooltip reflects on/off.
- **Notes:** P1.

### 8.2 Plugin-setting domain reaches host

- **✅ Automated** — `test/integration/firewall.test.ts` ("8.2 allows an allowlisted domain and blocks a non-allowlisted one"); injects a `[plugin]` domain via `OAS_ALLOWED_DOMAINS` and self-skips when the CI environment has no outbound.
- **Setup:** Settings → Additional firewall domains = `example.com`. Restart container. Enable firewall.
- **Steps:** In a terminal: `curl -I https://example.com`. Then `curl -I https://example.org`.
- **Expected:** `example.com` → 200. `example.org` → timeout or blocked by iptables.
- **Notes:** P0.

### 8.3 firewall-extras.txt works AND isn't writable by Claude

- **✅ Automated (read-only mount)** — `test/integration/firewall.test.ts` ("8.3 firewall-extras.txt is world-readable by the agent" + "… is not writable by the agent (read-only mount)") asserts both halves of the security property. The curl-reachability of a file-sourced domain stays manual (it needs a non-empty `firewall-extras.txt`).
- **Setup:** Add `example.com` (a real resolvable domain) to `container/firewall-extras.txt`. Restart container.
- **Steps:** 1) In a terminal: `curl -I https://example.com`, confirm the domain is reachable. 2) `ls -la /etc/oas/firewall-extras.txt`, note the permissions. 3) `echo "evil.com" >> /etc/oas/firewall-extras.txt`, expect permission denied.
- **Expected:** 1) `example.com` is reachable via curl. 2) The file is world-readable (Claude can read its contents; this is intentional: knowing the allowlist doesn't help Claude escape, and iptables rules enforce the firewall). 3) Write attempt is denied: the file is mounted read-only at `/etc/oas/`, so Claude cannot modify the allowlist.
- **Notes:** P0. The security property is **write protection**, not read restriction.

### 8.4 --list-sources tagging

- **🟡 Partially automated (baseline + plugin tags)** — `test/integration/firewall.test.ts` ("8.4 --list-sources tags baseline and plugin entries") asserts the `[baseline]` and `[plugin]` tags. The `[file]` tag (needs a non-empty `firewall-extras.txt`) and the cross-check against Settings → Effective allowlist stay manual.
- **Steps:** `docker compose exec sandbox /usr/local/bin/init-firewall.sh --list-sources` (or run as `claude` user, read-only path).
- **Expected:** Lines tagged `[baseline]`, `[plugin]`, `[file]`. Matches Settings → Advanced → Security → Effective allowlist (Refresh).
- **Notes:** P1.

### 8.5 Effective allowlist refresh button

- **Manual** — the Settings refresh control fetches the live allowlist from the container; no automation (UI-bound, needs a running container).
- **Setup:** Firewall on.
- **Steps:** Settings → Advanced → Security section → Refresh (the "Click Refresh to fetch the effective firewall allowlist from the container" control).
- **Expected:** UI updates to current allowlist including any extras added since last refresh.
- **Notes:** P2.

### 8.6 Firewall off restores full egress

- **✅ Automated** — `test/integration/firewall.test.ts` ("8.6 restores full egress when the firewall is disabled"); self-skips when CI lacks outbound.
- **Steps:** Disable firewall. `curl -I https://example.org`.
- **Expected:** Reaches host (no iptables block).
- **Notes:** P1.

---

## Stage 9: Plugin API integrations (extensions tier)

**Setup carried forward:** Stage 0–3, plus the target Obsidian plugin installed and enabled in the vault, and Extensions tier enabled.

Most Stage 9 scenarios are covered exhaustively by [mcp-capability-test.md](./mcp-capability-test.md) S8 (Extensions tier) and S9.4 (malformed args) — 9.1/9.2 (Dataview), 9.4 (Templater), 9.5 (Periodic Notes), 9.6 (Canvas), 9.7 (extensions list), and 9.8 (malformed args) all live there now. Run the capability test under cell A (or cell F to confirm extensions gating) instead of re-exercising these manually. The scenario below is unique to the human-driven QA flow because it validates plugin-specific recurrence semantics that the capability test's S8.4 toggle doesn't specifically check.

### 9.3 Tasks toggle with recurring

- **Manual** (automatable, deferred) — the extensions-tier tools (Dataview / Templater / Tasks / Canvas) don't register in the e2e vault because those community plugins aren't installed, so neither this scenario nor extensions-tier gating (see Stage 3 note) is covered in CI. Both could be automated by vendoring the Tasks community plugin into the e2e vault fixture (`wdio-obsidian-service` enables plugins copied into `.obsidian/plugins/`) and asserting `vault_tasks_toggle` produces both the completed line and the next occurrence. Deferred: it pins a third-party build and adds fixture weight + flakiness.
- **Setup:** Tasks plugin enabled. A note with `- [ ] weekly thing 🔁 every week 📅 2026-04-19`.
- **Steps:** `claude -p "Toggle the task at notes/recurring.md line 5"`.
- **Expected:** File now contains both the completed original and a fresh next occurrence (Tasks' recurring semantics).
- **Notes:** P1. The capability test's S8.4 exercises `vault_tasks_toggle` but does not assert the recurring-task engine's next-occurrence behaviour, which is what this scenario covers.

---

## Stage 10: Cross-platform edges

**Setup carried forward:** Stage 0–2.

These require specific host hardware/OS. Run on each supported platform before release.

### 10.1 Windows + WSL2: vault path conversion

- **Setup:** Windows host, WSL2 Docker mode, vault at `C:\vault`.
- **Steps:** Start container. Inside a terminal: 1) `echo $OAS_VAULT_WRITE_DIR` should print the configured write directory (e.g. `agent-workspace`). 2) `ls /workspace/vault` should list vault contents. Note: `OAS_VAULT_HOST_PATH` is a compose-time variable used for volume mount expansion; it is **not** passed into the container environment and prints empty if echoed.
- **Expected:** Vault is accessible at `/workspace/vault/`. `$OAS_VAULT_WRITE_DIR` is set correctly. No `wsl.exe` console flashes during start/stop.
- **Notes:** P0 on Windows.

### 10.2 Rancher Desktop: path with spaces

- **Setup:** Rancher Desktop on Windows. Compose path includes a space: `C:\My Folder\container`.
- **Steps:** Start container.
- **Expected:** Starts without path errors. Backslashes in compose resolve correctly.
- **Notes:** P0 on Windows + Rancher.

### 10.3 macOS Docker Desktop happy path

- **Setup:** macOS, Docker Desktop running.
- **Steps:** Stage 1–3 smoke (start, terminal, claude -p hello).
- **Expected:** All pass without macOS-specific Notices or warnings.
- **Notes:** P0 on macOS.

### 10.4 Linux native Docker happy path

- **Setup:** Linux, Docker Engine via systemd (no Desktop).
- **Steps:** Stage 1–3 smoke.
- **Expected:** All pass. SELinux/AppArmor labels don't break vault mount.
- **Notes:** P0 on Linux.

### 10.5 WSL2: MASQ network recreation on networking-mode change

- **🟡 Partially automated (parser)** — `parseDockerNetworkMasq` is unit-tested in `src/__tests__/docker.test.ts`. The end-to-end observable (network actually recreated with the correct MASQ value on a real WSL2 host) needs the hardware and stays manual.
- **Setup:** Windows host, WSL2 with Docker Engine. Confirm the current networking mode: `wsl --status` or check `%USERPROFILE%\.wslconfig` for `networkingMode=mirrored`; absence means NAT (default).
- **Steps:** 1) Note the current `enable_ip_masquerade` value of the existing docker network: `docker network inspect oas_default --format '{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}'` (expect `true` for NAT, `false` for mirrored, or `not found` if no network exists yet). 2) Force MASQ drift: either change `networkingMode` in `.wslconfig` and run `wsl --shutdown` then reopen, or delete the network manually while the container is stopped (`docker compose down && docker network rm oas_default`) to force a fresh creation with the opposite setting. 3) Restart the container via **Sandbox: Restart Container**.
- **Expected:** The plugin detects the MASQ drift in `DockerManager.verifyAndMaybeRecreateNetwork` and recreates the network before starting. After restart, `docker network inspect oas_default --format '{{index .Options "com.docker.network.bridge.enable_ip_masquerade"}}'` shows the value matches the current WSL networking mode (`false` for mirrored, `true` for NAT). Container health and MCP connectivity are normal.
- **Cleanup:** Revert `.wslconfig` if modified; `wsl --shutdown` then reopen WSL.
- **Notes:** P2. WSL2 only. The `parseDockerNetworkMasq` parser is unit-tested (`docker.test.ts`); this scenario verifies the end-to-end observable outcome — network recreated with the correct MASQ value — not the parser logic.

---

## Stage 11: Release & distribution

**Setup carried forward:** Stage 0. Run when cutting a release.

### 11.1 `plugin check` workflow on PRs

- **Setup:** Open a PR touching `plugin/src/`.
- **Expected:** Workflow runs and goes green. PRs that don't touch `plugin/` don't trigger it.
- **Notes:** P1.

### 11.2 Release workflow produces signed assets

- **Setup:** Cut release per `docs/how-to/release.md` (`npm version 0.X.Y && git push --tags`).
- **Expected:** Release workflow runs; tag-vs-manifest check passes; pre-release GitHub Release contains `main.js`, `manifest.json`, `styles.css`. Working tree clean after `npm version`.
- **Notes:** P0.

### 11.3 BRAT install from Release

- **Setup:** Clean Obsidian profile with BRAT installed.
- **Steps:** BRAT: Add a beta plugin for testing → paste repo URL. Enable in Community plugins.
- **Expected:** BRAT downloads the three assets. Plugin loads, settings render, ribbon icon appears.
- **Notes:** P0.

### 11.4 Upgrade-in-place via BRAT

- **Setup:** Installed via BRAT at version N. New release N+1 published.
- **Steps:** BRAT: Check for updates.
- **Expected:** Pulls N+1. Plugin reloads cleanly. Settings preserved.
- **Notes:** P1.

### 11.5 `manifest.json` ↔ `versions.json` consistency

- **Setup:** Latest release artifacts (BRAT cache or downloaded).
- **Steps:** Compare release tag, `manifest.json.version`, and `versions.json` keys. Confirm `versions.json[manifest.version].minAppVersion` matches `manifest.json.minAppVersion`.
- **Expected:** All three agree.
- **Notes:** P1. Mismatch causes BRAT to install stale or refuse to install.

---

## Stage 12: Stress, edge cases, recovery

**Setup carried forward:** Stage 0–3.

Shell-verifiable scenarios (T12.1, T12.2, T12.3, T12.7a) run via `container/test-scripts/stress-checks.sh`. The scenarios below require Obsidian to be running or are otherwise UI-bound.

```bash
bash container/test-scripts/stress-checks.sh /path/to/test-vault
# Daemon-stop probe (host-disruptive, stops and restarts Docker):
bash container/test-scripts/stress-checks.sh /path/to/test-vault --with-daemon-stop
```

### 12.1 Docker daemon stops mid-session

- **🟡 Partially automated (recovery probe)** — `container/test-scripts/stress-checks.sh` T12.1 (`--with-daemon-stop`) verifies MCP becomes unreachable and recovers. The human-observable UI (status bar → errored, terminal disconnected message) requires Obsidian open and stays manual.

- **Setup:** Container running, terminal open.
- **Steps:** Run `stress-checks.sh --with-daemon-stop`, then observe the status bar and terminal during the stop/restart cycle.
- **Expected:** Status bar transitions to errored. Terminal shows disconnected state with helpful message. No infinite spinner. After restart: auto-start or manual Start recovers cleanly.
- **Notes:** P0. Automated probe passes before observing the UI.

### 12.2 Vault path with unicode

- **✅ Automated** — `container/test-scripts/stress-checks.sh` T12.2: passes when `vault_list` succeeds through a unicode-path symlink. The terminal `ls /vault` check is optional confirmation.
- **Setup:** A vault (or a symlink to one) whose path contains non-ASCII characters — the script uses `Документы-vault`. Skips gracefully if the host filesystem can't create such a symlink.
- **Steps:** Through the unicode path, read the plugin's MCP token and call `vault_list` over the MCP endpoint. Optionally `ls /workspace/vault` in a terminal.
- **Expected:** `vault_list` returns the vault contents with no error — the mount point and paths survive the unicode round-trip. No mojibake in the listing.
- **Notes:** P1.

### 12.3 Very large note read

- **✅ Automated** — `container/test-scripts/stress-checks.sh` T12.3: creates a ~5 MB note and calls `vault_read`. The no-UI-freeze check is optional confirmation.

- **Notes:** P2.

### 12.4 Many concurrent terminals

- **Steps:** Open 5 terminal tabs simultaneously.
- **Expected:** All connect. No port conflicts (ttyd handles multiplexing). CPU/memory remains reasonable.
- **Notes:** P2.

### 12.5 Plugin disable while modal is open

- **Setup:** Trigger a reviewed-write that opens a diff modal (e.g. `claude -p "Create reviewed-write: <vault>/.oas/prompts/test-reviewed.md with content 'x'"` under `writeReviewed` mode) and do NOT approve or reject it.
- **Steps:** With the modal open, close Obsidian entirely (Cmd+Q on macOS, Alt+F4 on Windows). Opening Community Plugins while a modal is visible is not possible; app-close is the realistic trigger for plugin teardown with an open modal.
- **Expected:** Obsidian closes cleanly. The pending tool call times out or resolves as rejected. On next Obsidian open, no zombie modal, no red console errors.
- **Notes:** P1.

### 12.6 Obsidian close while Claude is mid-tool-call

- **Setup:** Active Claude session in the middle of a long vault_search.
- **Steps:** Close Obsidian.
- **Expected:** Pending MCP requests are cancelled. With auto-stop on, container stops. No orphan processes (`docker ps` empty after close).
- **Notes:** P1. What's under test: whether in-flight MCP requests terminate cleanly (no deadlock) and whether the container stops without orphan processes. The ephemeral nature of the container means there's no persistent state to recover.

### 12.7a Teardown leaves no `oas-*` debris

- **✅ Automated** — `container/test-scripts/stress-checks.sh` T12.7a: runs `docker compose -p oas-test down -v` and greps for leftover `oas-test-*` resources. The production volumes (`oas-claude-config`, `oas-shell-history`, `oas-user-config`) are checked separately.

- **Notes:** P1.

### 12.7 No remaining DevTools console errors after a full session

- **Setup:** Open DevTools before starting. Run a representative session: start container, open terminal, do a few Claude tool calls, toggle MCP/firewall, switch sessions, close terminal.
- **Expected:** Console clean, no red errors. Warnings should each have a known reason (note them in the QA report).
- **Notes:** P1. Catch-all check.

---

## Reporting template

When recording results, prefer this shape per scenario:

```
- 3.4 Write scoped, create: PASS / FAIL / SKIP: <one-line note or screenshot link>
```

For a release, summarise:

- All `P0` scenarios across stages 1–9 + the platforms in stage 10 you ship to + stage 11.
- Any `P1` failures with workaround documented.
- `P2` failures noted but non-blocking.
