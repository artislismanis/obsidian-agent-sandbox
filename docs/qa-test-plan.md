# QA Test Plan — End-to-End Manual Scenarios

This plan covers scenarios outside the scope of `npm run test`, `test:integration`, and `test:e2e` — those that require human judgment, cross-process workflows, real LLM calls, real target plugins, or specific OS/hardware. See `docs/testing.md` for the automated coverage matrix.

## How to use this plan

- **Stages are ordered by setup cost.** Setup done in an earlier stage carries forward into later stages, so work top-to-bottom on a fresh machine for the cheapest path. If you only need a slice, jump to the relevant stage and read its "Setup carried forward" line for what must already be in place.
- **Each scenario lists:** Setup (in addition to the stage's), Steps, Expected, and Notes (gotchas, cleanup, severity).
- **Severity convention:** `P0` blocks ship, `P1` ships only with workaround, `P2` polish.
- **Cleanup discipline:** scenarios that mutate state (symlinks, firewall, custom sudo password, files in vault) end with explicit cleanup. Run it — later scenarios assume a clean baseline.
- **Don't repeat automated coverage.** If a behavior is fully covered in `src/__tests__/*`, `test/integration/*`, or `test/e2e/*`, don't re-verify here. This plan is the gap-filler.

---

## Stage 0 — Environment prerequisites (one-time per machine)

These aren't test scenarios; they're the baseline. Verify each before touching Stage 1.

- [ ] Host OS: Linux (native Docker), WSL2 with Docker Engine + mirrored networking, macOS with Docker Desktop, or Windows with Rancher Desktop / Docker Desktop.
- [ ] `docker info` succeeds from the host shell Obsidian will inherit `PATH` from.
- [ ] `oas-sandbox:latest` image built: `cd container && docker compose build`.
- [ ] `docker compose version` reports ≥ 2.24 (required for `!reset` syntax in the sudo override — see 2.19).
- [ ] Obsidian desktop ≥ `1.5.0` installed.
- [ ] A real vault to test against (not the e2e fixture). Recommend a fresh vault with a handful of notes, at least one with frontmatter, and one folder with 2-3 cross-linked notes.
- [ ] Plugin artifacts built and installed into the vault: `cd plugin && npm run build`, then copy `dist/main.js`, `dist/manifest.json`, `dist/styles.css` into `<vault>/.obsidian/plugins/obsidian-agent-sandbox/`.
- [ ] Claude Code authenticated inside the container at least once (see `docs/testing.md` → "Claude Code authentication"). Required from Stage 3 onward.

---

## Stage 1 — Plugin enabled, container not yet started

**Setup carried forward:** Stage 0.

This stage exercises the settings UI, error/fallback paths before any container exists, and the plugin's load-time behaviour. Quick to run — no LLM, no Docker round-trips.

### 1.1 First-enable settings tab render

- **Setup:** Plugin freshly enabled (toggle off then on in Community Plugins). DevTools open (Ctrl+Shift+I) before clicking — catch transient errors.
- **Steps:** Open Settings → Agent Sandbox. Visit all four tabs in order: **General, Terminal, MCP, Advanced**. For each, verify fields appear in the order listed below with the stated defaults and "Requires container restart." labels where noted.
- **Expected:**
  - **General** (top to bottom): Docker mode = `WSL (Windows)` *(Requires container restart.)*; Docker Compose path = empty *(Requires container restart.)*; WSL distribution = empty with placeholder `Ubuntu` *(Requires container restart., visible only when Docker mode = WSL)*; Vault write directory = `agent-workspace` *(Requires container restart.)*; Memory file name = `memory.json` *(Requires container restart.)*; Auto-start on load = off *(no label)*; Auto-stop on exit = off *(no label)*; Notify on agent output = `New files only (default)` *(no label)*.
  - **Terminal** (top to bottom): Port = `7681` *(Requires container restart.)*; Bind address = `127.0.0.1` *(Requires container restart.)*; Terminal theme = `Follow Obsidian theme` *(no label)*; Terminal font = empty *(no label)*; Font size = `14` *(no label)*; Scrollback = `10000` *(no label)*; Auto-copy on selection = on *(no label)*.
  - **MCP** (top to bottom): Enable MCP server = on *(no label)*; MCP port = `28080` *(Requires container restart.)*; MCP bind address = `127.0.0.1` *(no label — hot-swap)*; Auth token = auto-generated value *(no label)*; Vault-wide writes = `None` *(no label)*; Navigate / Manage / Extensions tiers = off *(no label each)*; Allowed paths = empty *(no label)*; Blocked paths = empty *(no label)*; Tool timeout = `10` *(no label)*; Review timeout = `180` *(no label)*.
  - **Advanced** (top to bottom): Log level = `Warn` *(no label)*; Memory limit = `4G` *(Requires container restart.)*; CPU limit = `2` *(Requires container restart.)*; Auto-enable firewall on start = **on** *(no label)*; Allowed private hosts = empty *(Requires container restart.)*; Additional firewall domains = empty *(Requires container restart.)*; Effective allowlist (Refresh button, no input) *(no label)*; Sudo password = empty *(Requires container restart.)*.
  - No red console errors on any tab. A `[Violation] Forced reflow …` yellow warning on plugin enable/disable is known and benign.
- **Notes:** P1. This inventory is the authoritative list — field order, defaults, and label presence all matter. Update this scenario when settings change.

### 1.2 Restart-required modal on settings close

- **Setup:** Container running.
- **Steps:** Open Settings → Agent Sandbox. Change any field flagged in 1.1 as "Requires container restart." (e.g. General → Vault write directory). Close the settings tab (click another settings section or close the settings modal entirely).
- **Expected:** While the settings tab is open, no inline indicator or status bar change appears. On close, a **Restart Container?** modal appears: message reads "You changed settings that require a container restart. Restart now? This will stop all active terminal sessions." Two buttons: **Restart** (restarts container and dismisses) and **Later** (saves settings without restarting and dismisses). Both dismiss the modal cleanly with no console errors. The modal does NOT appear if the container is not running when settings close.
- **Notes:** P1. Known limitation: editing a restart-required field then reverting the value still triggers the modal (no diff tracking). Field list is single-sourced in 1.1.

### 1.3 MCP token regenerate

- **Setup:** Settings → MCP visible.
- **Steps:** Click Regenerate. Observe token field.
- **Expected:** Field updates immediately to a new value distinguishable from the previous one. No restart required for the field to update visually (whether the running MCP server picks up the new token is covered in 3.x).
- **Notes:** P1. Take a screenshot of old and new tokens to confirm they differ.

### 1.4 Bind address security warning toggle

- **Setup:** Two bind-address fields: **Terminal → Bind address** (ttyd) and **MCP → MCP bind address**. Exercise both.
- **Steps:** For each, change `127.0.0.1` → `0.0.0.0`, then to a non-loopback IP, then back to `127.0.0.1`. Keep the input focused while typing.
- **Expected:** The field's normal description text remains visible at all times. When value is `0.0.0.0`, a distinct amber `⚠ WARNING:` banner appears *below* the description — ttyd field: "0.0.0.0 exposes ttyd to your network without authentication. Anyone on your network can access the terminal."; MCP field: "0.0.0.0 exposes MCP to your network. Bearer-token auth is the only line of defense." On revert to `127.0.0.1` (or any other non-`0.0.0.0` value) the banner disappears; the description is unchanged. Input focus is preserved across keystrokes (no full-tab re-render). Each warning shows on its own field only.
- **Notes:** P0. Verify the banner is visually distinct (amber left-border) and the base description is still readable alongside it.

### 1.5 Start with Docker daemon stopped

- **Setup:** Stop Docker on the host. On Linux with systemd: `sudo systemctl stop docker.socket docker.service`. On macOS/Windows: quit Docker Desktop or Rancher Desktop.
- **Steps:** Command palette → **Sandbox: Start Container**.
- **Expected:** Clear Notice within ~5 s naming the failure ("Docker not available", "Cannot connect to Docker daemon", etc.). No infinite spinner. Status bar settles to a stopped/errored state with a useful tooltip.
- **Notes:** P0. After the test, restart Docker before continuing. On Linux with systemd: `sudo systemctl start docker.socket docker.service`. On macOS/Windows: relaunch Docker Desktop or Rancher Desktop.

### 1.6 Write directory validation in settings

- **Setup:** Plugin enabled. Settings → General open.
- **Steps:** 1) Attempt to type a path outside the vault (e.g. `/root/forbidden` or `../../escape`) into **Vault write directory**. 2) Manually edit the vault's `data.json` (`.obsidian/plugins/obsidian-agent-sandbox/data.json`) to set `vaultWriteDir` to a path that escapes the vault, then reload the plugin (toggle off/on in Community Plugins).
- **Expected:** 1) Settings UI rejects the input — the field blocks paths containing `..` or a leading `/`. 2) On load the settings tab immediately shows the field in error state (red border / `sandbox-input-error` class). The stored value is **not** auto-corrected; attempting to start the container while the invalid value is stored emits a Notice and fails to start.
- **Notes:** P1. Validation runs on both keystroke and settings-tab load. An invalid stored value prevents container start rather than causing a mid-start failure.

### 1.7 Port conflict detection

The plugin has **two separate** conflict-detection mechanisms with different code paths, failure modes, and platform behaviour. Keep them separate when testing.

**Port-occupier reference** — pick the one-liner that matches your host OS and the bind address shown in settings. The occupier must run in the **same network namespace as the process doing the bind** (see per-scenario notes below).

| Host                       | `127.0.0.1` (loopback)                                                                                                          | `0.0.0.0` (all interfaces)                                                                    | Specific IP                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Windows (PowerShell)       | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, <PORT>); $l.Start()`                              | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, <PORT>); $l.Start()` | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('<IP>'), <PORT>); $l.Start()` |
| Linux / macOS / WSL shell  | `python3 -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',<PORT>)); s.listen(); print('bound'); sys.stdin.read()"` | same with `'0.0.0.0'`                                                                         | same with `'<IP>'`                                                                                      |
| Linux, netcat-openbsd only | `nc -l 127.0.0.1 <PORT>`                                                                                                        | `nc -l 0.0.0.0 <PORT>`                                                                        | `nc -l <IP> <PORT>`                                                                                     |

Release: PowerShell → `$l.Stop()`. Python / nc → Ctrl+C. (`nc -l <port>` without an IP is netcat-openbsd syntax only; netcat-traditional requires `-p <port>`. The Python one-liner works everywhere.)

To confirm your WSL2 networking mode: `wsl --status` (look for "Networking mode") or check `%USERPROFILE%\.wslconfig` for `networkingMode=mirrored`; absence means NAT (default).

---

**1.7a — ttyd port pre-flight (container start)**

- **What it exercises:** `checkStartupPortConflicts` (`main.ts:1010`) → `DockerManager.checkPortConflicts` (`docker.ts:699`) — probes `Settings → Terminal → Bind address` + `Port` inside the **plugin process (Obsidian host netns)** before invoking Docker.
- **Setup:** On the **Obsidian host**, occupy `<ttydBindAddress>:<ttydPort>` (default `127.0.0.1:7681`) using the table above. **On WSL2**: the plugin probes the Windows host netns; compose binds inside WSL2's netns. These are the same only in WSL2 mirrored mode — see expected outcomes below.
- **Steps:** Command palette → **Sandbox: Start Container**.
- **Expected:**
  - **Linux native Docker / macOS Docker Desktop / WSL2 mirrored mode:** Notice `Port conflict: 7681 already in use on 127.0.0.1. Stop the other process or change the port in settings.` Container does not start. *(Note: Notice always says `127.0.0.1` even if Bind address is set to something else — known cosmetic bug.)*
  - **WSL2 NAT mode (default):** Pre-flight probe is blind to the WSL netns. Container starts; terminal tab spins without connecting; no Notice. **Record this as a known gap**, not a pass. See `docs/proposals/port-conflict-detection-improvements.md` Task 1.
- **Cleanup:** Release the port. Restart container if it started in the NAT-mode gap case.
- **Notes:** P1 on platforms where pre-flight works. Known gap on WSL2 NAT.

---

**1.7b — MCP port reactive failure (server start)**

- **What it exercises:** `startMcpServer` catch path (`main.ts:783`) — `listen()` fails, plugin shows Notice and **persists `mcpEnabled = false`**.
- **MCP runs in the plugin process on the Obsidian host** (not inside Docker/WSL). Occupy the port on the **Windows host** (not inside a WSL shell) on WSL2 setups.
- **Setup:**
  1. Container running.
  2. MCP must be **stopped** before occupying the port. If "Enable MCP server" is currently on, toggle it off first via **Sandbox: Toggle MCP Server**.
  3. Occupy `<mcpBindAddress>:<mcpPort>` (default `127.0.0.1:28080`) using the table above — on the **Obsidian host**.
- **Steps:** Command palette → **Sandbox: Toggle MCP Server** (starts MCP because it is currently stopped).
- **Expected:**
  - Notice: `MCP server failed to start: …` (error will mention address in use).
  - Settings → MCP → **Enable MCP server** is now **OFF** (auto-disabled and persisted — reopen settings to confirm).
  - Container itself remains running.
- **Recovery sub-step (recommended):** Release the port → toggle MCP on again → should start cleanly. Confirms the half-state cleanup in the catch block.
- **Cleanup:** `$l.Stop()` / Ctrl+C.
- **Notes:** P0. Host-process path — must fire on all platforms.

### 1.8 URI handler without container

- **Setup:** Container stopped.
- **Steps:** Paste `obsidian://agent-sandbox/open-terminal` into a browser.
- **Expected:** Obsidian focuses; a Notice explains the container isn't running. No crash, no zombie terminal tab.
- **Notes:** P1.

### 1.9 Command palette entries present

- **Setup:** Plugin enabled.
- **Steps:** Open command palette and search "Sandbox". Confirm all 12 commands are listed by their display names: **Open Sandbox Terminal**, **Sandbox: Start Container**, **Sandbox: Stop Container**, **Sandbox: Container Status**, **Sandbox: Restart Container**, **Sandbox: Toggle Firewall**, **Sandbox: Open Session**, **Sandbox: Open Browser**, **Sandbox: Toggle MCP Server**, **Sandbox: Copy terminal connection log**, **Sandbox: Clean up detached sessions**, **Sandbox: Switch to Sandbox session…** (command IDs: `open-claude-terminal`, `sandbox-start-container`, `sandbox-stop-container`, `sandbox-container-status`, `sandbox-restart-container`, `sandbox-toggle-firewall`, `open-session`, `open-browser`, `sandbox-toggle-mcp`, `sandbox-copy-terminal-connection-log`, `sandbox-cleanup-sessions`, `sandbox-switch-session`).
- **Expected:** All 12 visible. Each runs without throwing when invoked in this state (most should no-op with a Notice).
- **Notes:** P2. Quick smoke check. Use `plugin/src/main.ts` as the canonical source if the count changes.

---

## Stage 2 — Container running, no Claude interaction yet

**Setup carried forward:** Stage 0–1, plus container running cleanly (status bar green/running).

This stage covers lifecycle, terminal, and status-bar behaviour without depending on an authenticated Claude.

### 2.1 Auto-start on Obsidian launch

- **Setup:** Auto-start enabled. Container stopped. Obsidian closed.
- **Steps:** Open Obsidian.
- **Expected:** Status bar transitions through Starting → Running within ~30 s. Tooltip detail cycles "Starting: checking Docker availability…" → "probing WSL…" → "probing container status…" → "docker compose up -d (auto-start)…". On Linux/macOS the WSL probe should still appear briefly but resolve to "not WSL".
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
- **Steps:** In settings, change Write directory. Close the settings tab. In the **Restart Container?** modal that appears (covered in 1.2), click Restart. (If you previously chose "Later", the modal won't reappear automatically — use **Sandbox: Restart Container** from the command palette instead.)
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
- **Expected:** Plugin loads cleanly — ribbon icon present, all 12 commands re-registered in command palette, settings tab renders, no red errors in console. No duplicate status bar pills or ribbon icons.
- **Notes:** P0.

### 2.6 Settings persist across full Obsidian restart

- **Setup:** Container running.
- **Steps:** Change Terminal font size to 18. Quit Obsidian fully (not reload). Reopen.
- **Expected:** Setting still shows 18. Open a terminal — font reflects it.
- **Notes:** P0. Not covered by e2e (ephemeral vaults).

### 2.7 Terminal opens, attaches, renders

- **Setup:** Container running.
- **Steps:** Ribbon icon (or `open-claude-terminal` command). Type `ls -la /workspace`.
- **Expected:** Tab opens, prompt appears, command runs and prints output. No flicker, no garbled escape sequences.
- **Notes:** P0.

### 2.7a Custom font family

- **Setup:** A non-default monospace font installed on the host (e.g. JetBrains Mono, Fira Code).
- **Steps:** Settings → Terminal → Font family → enter the installed family. Reopen the terminal.
- **Expected:** Glyphs render in the chosen font. Fallback chain works when the family is misspelled (renders default mono, no broken boxes).
- **Notes:** P2.

### 2.7b Status bar icon glyphs

- **Setup:** Container in various states.
- **Steps:** Cycle through stopped → starting → running → error states. Toggle firewall.
- **Expected:** All glyphs render as icons, not `?` or tofu boxes:
  - `Sandbox: ⏹ Stopped` — container stopped. Visible at plugin load when auto-start is off.
  - `Sandbox: ⏳ Starting` — during `docker compose up -d`. Start the container and watch the transition.
  - `Sandbox: ▶ Running` — healthy container.
  - `Sandbox: ⚠ Error` — stop the Docker daemon while the plugin polls; next poll surfaces this state.
  - `Sandbox: 🔍 Checking` — emitted only during `backgroundStartup()`. Re-observe by disabling then re-enabling the plugin, or restarting Obsidian with auto-start on.
  - `🛡 FW` — firewall pill; appears when firewall is enabled.
- **Notes:** P1. Font fallback issues here are platform-specific (esp. older Windows). Awaiting-input badge (trailing ` ⚠` on the sandbox pill) requires an authenticated Claude session — see 3.20.

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
- **Expected:** Clipboard unchanged after selection alone. With a selection active, Ctrl+C copies the selection (matches Terminal.app / iTerm2 convention) — confirm clipboard updated and no `^C` printed in the terminal. With no active selection, Ctrl+C sends SIGINT as normal (e.g. interrupts a running `sleep 30`). Right-click Copy also copies on explicit action.
- **Notes:** P1.

### 2.11 Connection retry / exponential backoff

- **Setup:** Container running, one Sandbox terminal tab open.
- **Steps:**
  1. Run **Sandbox: Stop Container** from the command palette.
  2. Observe the loading text in the open terminal tab.
  3. After ≥5 s, run **Sandbox: Start Container**.
- **Expected:** Loading text reads "Connecting to terminal… (attempt N/15, retry in Xs)" with X growing exponentially (500ms × 1.5^n), capped at 5s. When container comes up, terminal establishes.
- **Notes:** P1. Use the plugin commands (not `docker compose` directly) — bare Docker commands bypass the plugin's env vars (`OAS_VAULT_HOST_PATH`, `OAS_TTYD_PORT`, etc.) and produce a misconfigured container.

### 2.11a Startup progress indicator detail

- **Setup:** Obsidian closed, container stopped, auto-start on.
- **Steps:** Open Obsidian. During startup, hover the status bar pill repeatedly. Also open DevTools (Ctrl+Shift+I) → Console tab and filter by "Agent Sandbox" to catch debug-level log entries.
- **Expected:** Status bar pill tooltip cycles through all four phase strings in order: "Starting: checking Docker availability…" → "Starting: probing WSL (5s fast-fail)…" → "Starting: probing container status…" → "Starting: docker compose up -d (auto-start)…". On warm systems the transitions are sub-second, so you may catch only one or two phases via hover — the DevTools console is more reliable for confirming all four fired. Phase 4 fires only when `autoStartContainer` is on and the container is not already running.
- **Notes:** P2. On non-WSL platforms the WSL probe fires and resolves to "not WSL"; the phase still appears.

### 2.12 Out-of-band recreate detection

- **Setup:** Container running, no terminals open yet OR one terminal open.
- **Steps:** From host: `cd container && docker compose down && docker compose up -d`.
- **Expected:** Within 30 s, Notice: "Sandbox container was recreated outside the plugin. Terminal sessions may be disconnected; reopen to reconnect." Existing terminals detach gracefully.
- **Notes:** P1.

### 2.13 Status bar tooltip content

- **Setup:** Container running, MCP on, firewall on.
- **Steps:** Hover the sandbox status-bar pill.
- **Expected:** Tooltip lists container state, MCP state, firewall state. Each line is current (matches command-palette status check).
- **Notes:** P2. Toggle MCP/firewall and re-hover.

### 2.14 `Sandbox: Container Status` command

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

- **Setup:** Open and close one terminal tab.
- **Steps:** Run the copy log command.
- **Expected:** Clipboard contains a multi-line log of the connection lifecycle for **all** terminal sessions in this Obsidian instance — connect/disconnect/error/reconnect events, timestamps, session byte counts, and connection durations. The ttyd WebSocket URL (`ws://host:port/ws`) carries no auth token. Paste into a scratchpad to verify format and content.
- **Notes:** P2. Covers all terminals in this session, not just the most recent. The log is in-memory — it is lost when Obsidian closes.
### 2.17 Image rebuild triggers recreate

- **Setup:** Container running on `oas-sandbox:latest`.
- **Steps:** On host: `cd container && docker compose build`. Run **Sandbox: Restart Container**.
- **Expected:** `docker inspect oas-sandbox --format '{{.Image}}'` shows the new image id. Any baked-in change is visible in a new terminal.
- **Notes:** P1.

### 2.18 Workspace persistence

- **Setup:** Container running, terminal open.
- **Steps:** In the container: `echo "marker $(date +%s)" >> /workspace/.claude/persist-check.md`. Restart container. New terminal: `cat /workspace/.claude/persist-check.md`.
- **Expected:** File and marker line present after restart.
- **Notes:** P1. Cleanup: `rm /workspace/.claude/persist-check.md`.

### 2.19 Custom sudo password

- **Setup:** Container not running.
- **Steps:** Set Sudo password in Advanced. Restart container. In a terminal: `sudo -k && sudo apt-get update` (enter new password when prompted).
- **Expected:** Accepts new password; `apt-get update` runs. Setting password to empty then restarting disables sudo entirely (`sudo apt-get update` should refuse without the error mentioning `no-new-privileges`).
- **Notes:** P1. Reset to default afterwards. Sudoers is restricted to `apt-get`/`apt` only — other `sudo` commands will be rejected regardless of password. The password is stored on the host at `~/.config/obsidian-agent-sandbox/secrets.json` (mode 0600, directory mode 0700); this path is **not** mounted inside the container, so the agent cannot read it. Toggling the sudo password between empty and non-empty changes the container's `security_opt` set, so the next start/restart recreates the container (compose detects the config drift). New container ID expected.

---

## Stage 3 — Claude authenticated, MCP enabled

**Setup carried forward:** Stage 0–2, plus Claude logged in inside the container (`docker compose exec sandbox claude` once) and MCP enabled in plugin settings.

**How Stage 3 works.** This stage has two parts. The human configures the plugin into a permission cell (3.1–3.3) and runs the Claude-driven capability sweep against that configuration; then the human-only scenarios (3.4–3.11) catch what the sweep can't observe. The capability test validates schema shapes, error messages, and per-tier gating exhaustively; the scenarios below catch UI/UX and host-process behaviour that requires a human at the keyboard.

**Tier model (`src/permission-tiers.ts`):**
- Always-on when MCP is enabled: `read`, `writeScoped`, `agent`.
- Toggled per-tier: `navigate`, `manage`, `extensions`.
- Vault write mode (dropdown): `none` (default) / `reviewed` (`writeReviewed` tier, diff modal per change) / `full` (`writeVault` tier, unrestricted, no review).

### 3.1 Permission cells matrix

Each cell is a specific combination of plugin settings. Run [mcp-capability-test.md](./mcp-capability-test.md) under each relevant cell. For release validation run all six; for focused regression testing run only cells affected by the change.

| Cell | Nav | Mng | Ext | Write mode | Active tier tags                                       |
| ---- | --- | --- | --- | ---------- | ------------------------------------------------------ |
| A    | ON  | ON  | ON  | none       | read, writeScoped, agent, navigate, manage, extensions |
| B    | ON  | ON  | ON  | reviewed   | + writeReviewed                                        |
| C    | ON  | ON  | ON  | full       | + writeVault                                           |
| D    | OFF | ON  | ON  | none       | read, writeScoped, agent, manage, extensions           |
| E    | ON  | OFF | ON  | none       | read, writeScoped, agent, navigate, extensions         |
| F    | ON  | ON  | OFF | none       | read, writeScoped, agent, navigate, manage             |

> **Note:** `reviewed` and `full` are mutually exclusive vault write modes — only one of `writeReviewed` / `writeVault` is active at a time. See `vaultWriteTiers()` in `plugin/src/permission-tiers.ts`.

**Full-sweep cells (A, B, C):** run every capability-test scenario; skip those whose `Requires:` tag is not in the active set.

**Smoke cells (D, E, F):** only visit scenarios that *become* skipped in this cell — these confirm the tier gate is working. Always run S0.1 (capability discovery) and S9.5 (disabled-tier gate check).

**Run-file naming:** `workspace/mcp-testing/<YYYY-MM-DD>-cell-<letter>-<short-name>.md`. Examples: `2026-05-26-cell-A-baseline.md`, `2026-05-26-cell-D-nav-off.md`.

- **Notes:** P0. Gates the entire MCP tool surface.

### 3.2 Cell setup walkthrough

Repeat for each cell before handing the capability test to Claude:

1. **Settings → MCP** — confirm `Enable MCP server` is on.
2. In the **Permissions** section: set the Navigate / Manage / Extensions toggles and the Vault-wide writes dropdown to match the cell's row in the matrix above.
3. **Sandbox: Toggle MCP Server** (command palette) — off, then on — so the server re-publishes the tool list with the new settings.
4. Verify in a terminal: `claude -p "Call mcp_capabilities and tell me which tier tags are enabled."` Confirm the response matches the cell's "Active tier tags" column exactly.
5. Open `docs/mcp-capability-test.md` and hand it to the in-container Claude session. Save the run to `workspace/mcp-testing/<YYYY-MM-DD>-cell-<letter>-<short-name>.md`.

- **Notes:** P0. If step 4 doesn't match, toggle MCP off/on again before proceeding.

### 3.3 Sanity-diff run against code

After all cells are complete, skim the run files for any PASS scenario that relied on a tool name or tier tag that may have changed in `plugin/src/mcp-tools.ts` since the run was recorded. Most release cycles this is a no-op.

- **Notes:** P1.

### 3.4 Always-on tiers have no toggle

- **Setup:** Settings → MCP, with MCP enabled.
- **Steps:** Inspect the permissions section.
- **Expected:** Three toggles only (Navigate, Manage, Extensions) and one dropdown (Vault write mode: `none` / `reviewed` / `full (no review)`). No UI control for `read`, `writeScoped`, or `agent`; their tools always appear in `vault_*` listings while MCP is on.
- **Notes:** P2. Confirms `docs/reference/settings.md` matches reality.

### 3.5 Navigate tier — active tab changes (UI assertion)

- **Setup:** Cell A active (Navigate on). MCP toggled off then on.
- **Steps:** `claude -p "Open Welcome.md in the editor"` (use any real vault file).
- **Expected:** The active tab in Obsidian changes to that file. The `vault_open` call itself is covered by S6.1 in the capability test.
- **Notes:** P1.

### 3.6 MCP token rotation kicks live connections

- **Setup:** Active Claude session connected to MCP.
- **Steps:** Click Regenerate token in plugin settings. In the same terminal, try another tool call.
- **Expected:** The next call fails auth. Restarting the container per the regenerate-button description, then restarting Claude, restores tool access.
- **Notes:** P1.

### 3.7 MCP turn-off mid-session

- **Setup:** Active Claude session that recently used a vault tool.
- **Steps:** Toggle MCP off via command palette. In the same terminal, submit another tool-using prompt.
- **Expected:** The toggle force-closes all active HTTP connections (including SSE keepalives). The running `claude` process receives a connection error and cannot continue using vault tools. Re-enabling MCP alone is not enough — the user must run `/mcp` in the terminal to reconnect the Claude CLI session to the newly restarted server.
- **Notes:** P1. The force-close is intentional (prevents EADDRINUSE on next start). The `/mcp` reconnect step is the only user-visible consequence. See also the code comment at `mcp-server.ts:223`.

### 3.8 MCP cache invalidates on live edits

- **Setup:** `notes/cache.md` with first line `version A`. Vault open in Obsidian.
- **Steps:** 1) `claude -p "Read notes/cache.md and quote the first line"`. 2) In Obsidian, edit the note's first line to `version B` (Obsidian saves continuously — no explicit save needed). 3) Shortly after editing, re-read via Claude.
- **Expected:** Second read returns `version B`. The cache invalidates on Obsidian's `metadataCache.resolved` event, typically within a second or two of the file changing. If the second read still returns `version A`, wait 5 s and retry once; document any lag >5 s.
- **Notes:** P1. Stale reads after user edits are silent and confusing.

### 3.9 Concurrent MCP tool calls

- **Setup:** Vault with ≥10 notes containing "alpha" and ≥10 containing "beta".
- **Steps:** `claude -p "In parallel, search the vault for 'alpha' and for 'beta' and read the first three hits of each."`
- **Expected:** All calls complete without deadlock or `isError`. DevTools shows interleaved tool-call logs.
- **Notes:** P1. The capability test adds S9.6 for matrix completeness, but actual interleaving is only observable in a live conversation session — that's why this scenario stays here.

### 3.10 File ownership after Claude writes (Linux)

- **Setup:** Linux host, vault on host filesystem. Note host uid: `id -u`.
- **Steps:** `claude -p "Create agent-workspace/owner-test.md with content 'check uid'"`. Then: `ls -la <vault>/agent-workspace/owner-test.md` and edit in Obsidian.
- **Expected:** Obsidian edits the file without permission errors. Owner uid matches host uid, or mode is permissive enough that the host user can write.
- **Notes:** P1. Cleanup: delete the file.

### 3.11 Awaiting-input badge

- **Setup:** Active Claude session (terminal open, Claude running). `agent` tier enabled (always-on when MCP is on).
- **Steps:** Trigger a tool call that causes Claude to pause awaiting human input (e.g. a reviewed-write that opens the diff modal, or a direct `agent_status_set` call via MCP).
- **Expected:** Sandbox pill in the status bar gains a trailing ` 🔔` while the agent is awaiting input: `Sandbox: ▶ Running 🔔`. Badge clears when the session is no longer awaiting input.
- **Notes:** P2. Driven by `agent_status_set` tool in `mcp-tools.ts`; requires authenticated Claude. This is why it doesn't belong in Stage 2.

---

## Stage 4 — Human-in-the-loop review modals

**Setup carried forward:** Stage 0–3, plus Settings → MCP → **Vault write mode = Reviewed**.

Unit tests verify the gate fires; humans verify the modal renders right.

### 4.1 Content diff modal

- **Setup:** A note `notes/example.md` with ≥5 lines of stable content.
- **Steps:** `claude -p "Modify notes/example.md: change line 3 to 'EDITED'."`
- **Expected:** Modal "Review: Modify file" appears with unified diff: context lines `  `, removed lines `- ` (red), added lines `+ ` (green). Scrollable if tall. Approve → file changes. Reject → file untouched, Claude told "Change rejected by user."
- **Notes:** P0.

### 4.2 Frontmatter JSON diff

- **Setup:** `notes/fm.md` with frontmatter `status: draft`.
- **Steps:** `claude -p "Set frontmatter 'tags' to ['a', 'b'] on notes/fm.md"`.
- **Expected:** Modal "Review: Set frontmatter" shows JSON old vs new (FM block only, not body). Approve → FM set, body untouched.
- **Notes:** P1.

### 4.3 Rename/move affected-links list

- **Setup:** Manage + reviewed on. `notes/old.md` with two notes linking to it.
- **Steps:** `claude -p "Rename notes/old.md to notes/new.md"`.
- **Expected:** Modal "Review: Rename file"; description `Rename notes/old.md → notes/new.md`; below it `2 note(s) link here:` listing both. Approve → renamed and backlinks rewritten.
- **Notes:** P0.

### 4.4 Batch review checkboxes

- **Setup:** Three notes tagged `#test`.
- **Steps:** `claude -p "Use vault_batch_frontmatter to set property status=review on all files matching '#test' (dryRun false)."`
- **Expected:** `BatchReviewModal` lists all 3 with checkboxes (default checked). Uncheck one. Approve selected → only the 2 checked files updated.
- **Notes:** P1.

### 4.5 Reject persists in conversation

- **Setup:** Active Claude session.
- **Steps:** Modify a file via reviewed tier, reject.
- **Expected:** Claude's response acknowledges the rejection ("Change rejected by user") and doesn't retry silently. File untouched.
- **Notes:** P1.

### 4.6 Approve on big diff stays responsive

- **Setup:** A note ~500 lines long.
- **Steps:** Have Claude rewrite many lines. Open the review modal.
- **Expected:** Modal renders in <1 s, scrolls smoothly, syntax-highlighted diff still legible. No Obsidian UI freeze.
- **Notes:** P2.

---

## Stage 5 — Activity feedback, sessions, notices

**Setup carried forward:** Stage 0–3.

### 5.1 Tab title + badge on Claude state

- **Setup:** Open terminal, attach to named session `work`, run `claude` interactively.
- **Steps:** Submit a long-running prompt. Then submit one that triggers an approval question (or use `writeReviewed`).
- **Expected:** While working → tab title `⚙ Session: work`. Idle between prompts → `Session: work`. Awaiting input → `❓ Session: work` AND status bar pill grows a `⚠` badge with tooltip "1 session awaiting input: work".
- **Notes:** P0. Close+reopen Obsidian → badge clears (activity is ephemeral).

### 5.2 Multi-session independence

- **Setup:** Two sessions `work` and `research`, both running Claude.
- **Steps:** Prompt `work`, leave `research` idle.
- **Expected:** Only `work` shows `⚙` prefix. Badge count reflects only sessions awaiting input.
- **Notes:** P1.

### 5.3 Badge tooltip clears when session goes idle

- **Setup:** Session `a` in awaiting-input state.
- **Steps:** Answer the question; wait for transition to idle. Hover status bar pill.
- **Expected:** `⚠` badge gone; tooltip back to default running tooltip. No stale "1 session(s) awaiting input: a" string.
- **Notes:** P1.

### 5.4 Toggle MCP off clears awaiting-input state

- **Setup:** Session in awaiting-input state.
- **Steps:** Run **Sandbox: Toggle MCP Server**.
- **Expected:** Badge AND tooltip both clear.
- **Notes:** P1.

### 5.5 Hook script no-ops when MCP off

- **Setup:** MCP off. Terminal attached.
- **Steps:** `bash .claude/hooks/notify-status.sh awaiting_input`.
- **Expected:** Exits 0. No errors. No plugin crash.
- **Notes:** P2.

### 5.6 Agent output Notice — debounced bursts

- **Setup:** `Notify on agent output` = `new`.
- **Steps:** `claude -p "Create three files under agent-workspace/: a.md b.md c.md each with just 'x'."`
- **Expected:** A single Notice ~2 s after the last create: "Agent output: 3 created" (not three notices).
- **Notes:** P1.

### 5.7 Agent output Notice — rate-limit doesn't drop

- **Setup:** Same setting. First burst just fired.
- **Steps:** Within ~3 s, prompt another batch of 2 files.
- **Expected:** ~5 s after the first Notice, a second Notice appears for the batched remainder ("Agent output: 2 created"). Not silently dropped.
- **Notes:** P1.

### 5.8 `new_or_modified` mode includes modifies

- **Setup:** Switch setting to `new_or_modified`.
- **Steps:** Prompt Claude to modify two existing files.
- **Expected:** Notice fires for the modifies.
- **Notes:** P2.

### 5.9 `off` mode silent

- **Steps:** Switch setting to `off`. Trigger creates/modifies.
- **Expected:** No Notices.
- **Notes:** P2.

### 5.10 Session switcher

- **Setup:** Three terminal tabs: two named (`work`, `research`), one unnamed.
- **Steps:** Command palette → **Sandbox: Switch to Sandbox session…**. Type to filter. Enter on a result.
- **Expected:** Modal lists `Session: work`, `Session: research`, and `Sandbox Terminal <N>` for the unnamed one. Filter narrows. Selecting activates the matching tab.
- **Notes:** P1.

### 5.11 Session switcher handles closed tabs mid-modal

- **Setup:** Two named tabs.
- **Steps:** Open the switcher. Without dismissing, close one tab from another pane. Click the closed-tab row.
- **Expected:** Notice "That session has closed." Modal closes cleanly. No crash.
- **Notes:** P1.

### 5.12 Clean up detached sessions

- **Setup:** Two tmux sessions created, one attached in Obsidian, one detached.
- **Steps:** Command palette → **Sandbox: Clean up detached sessions**. Modal appears.
- **Expected:** Only the detached one listed. Uncheck to keep / check to kill. Kill selected → Notice "1/1 killed".
- **Notes:** P1.

### 5.13 Failed kill is logged, not swallowed

- **Setup:** Create two detached tmux sessions inside a container terminal — one with a valid name and one with an invalid name (space character, which `assertSafeSessionName` in `docker.ts` rejects against `[\w.-]+`):
  ```bash
  tmux new-session -d -s validname
  tmux new-session -d -s tempname
  tmux rename-session -t tempname "bad name"
  ```
- **Steps:** Command palette → **Sandbox: Clean up detached sessions**. Check both sessions in the modal → Kill selected.
- **Expected:** `validname` is killed. `bad name` fails name-validation; the failure is logged to DevTools console as `[Agent Sandbox] [sessions] failed to kill tmux session 'bad name': …`. Aggregate Notice reports `1/2 session(s) killed`.
- **Cleanup:** `tmux kill-session -t "bad name"` inside the container if it survived the failed kill.
- **Notes:** P2.

---

## Stage 6 — URI handlers + context menu

**Setup carried forward:** Stage 0–3.

### 6.1 obsidian:// open-terminal

- **Steps:** Paste `obsidian://agent-sandbox/open-terminal` into a browser URL bar.
- **Expected:** Obsidian focuses, opens a new terminal tab.
- **Notes:** P1.

### 6.2 obsidian:// analyse

- **Setup:** Vault note `notes/foo.md` exists. A `summarize.md` prompt template is in `<vault>/.oas/prompts/summarize.md` (copy from `workspace/.claude/prompts/summarize.md` if needed — that folder holds examples to copy from, not the live location).
- **Steps:** `obsidian://agent-sandbox/analyse?vault=<your-vault-name>&path=notes/foo.md&template=summarize`.
- **Expected:** New terminal opens; first command typed is the summarize template with `@notes/foo.md` substituted.
- **Notes:** P1. The `vault=` parameter is required when multiple vaults are open; omitting it causes Obsidian to show "Vault Not Found". Templates are loaded from `<vault>/.oas/prompts/*.md` — not from `workspace/.claude/prompts/`.

### 6.3 Context menu → Analyse in Sandbox

- **Setup:** `<vault>/.oas/prompts/` populated with the four shipped templates (copy from `workspace/.claude/prompts/` if needed).
- **Steps:** Right-click a vault note → **Analyse in Sandbox**.
- **Expected:** Submenu shows Summarize, Critique, Explain, Extract TODOs, plus "Custom prompt…". Picking one opens a new terminal and seeds the prompt.
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
- **Expected:** 1) No-op or validation hint; no terminal opens. 2) Modal closes; no terminal. 3) Terminal opens with full text seeded, no truncation. 4) Metacharacters passed to `claude` as a single argument — `id` / `whoami` must not execute on open.
- **Notes:** P1. Shell-escaping regressions here are a command-injection risk.

---

## Stage 7 — Symlink and path-traversal real-filesystem checks

**Setup carried forward:** Stage 0–3.

Unit tests cover `isRealPathWithinBase` with mocked realpath. These verify the OS round-trip.

### 7.1 Read of escaping symlink is denied

- **Setup:** From inside a container terminal, create a symlink in the write directory (which is rw) pointing outside the vault:
  ```bash
  ln -s /etc/hosts /workspace/vault/$OAS_VAULT_WRITE_DIR/evil.md
  ```
- **Steps:** `claude -p "Use vault_read to read agent-workspace/evil.md"` — explicitly instruct Claude to use MCP, not direct filesystem read.
- **Expected:** `vault_read` returns "File not found" or "Path resolves outside the vault." Real `/etc/hosts` is never returned.
- **Cleanup:** `rm /workspace/vault/$OAS_VAULT_WRITE_DIR/evil.md`.
- **Notes:** P0. The vault root is mounted `:ro` inside the container — create symlinks in `$OAS_VAULT_WRITE_DIR` (`:rw`) instead. Direct filesystem access by Claude is not under test here; the instruction must explicitly trigger an MCP `vault_read` call so `isRealPathWithinBase` is exercised.

### 7.2 Create into symlinked directory denied

- **Setup:** From inside a container terminal:
  ```bash
  ln -s /tmp /workspace/vault/$OAS_VAULT_WRITE_DIR/escape
  ```
- **Steps:** `claude -p "Use vault_create to create agent-workspace/escape/note.md with content 'hi'"`.
- **Expected:** `vault_create` returns "Path resolves outside the vault (symlink)." No file is created under `/tmp`.
- **Cleanup:** `rm /workspace/vault/$OAS_VAULT_WRITE_DIR/escape`.
- **Notes:** P0.

### 7.3 Nested symlinks resolve fully

- **Setup:** From inside a container terminal:
  ```bash
  mkdir /workspace/vault/$OAS_VAULT_WRITE_DIR/innocent
  ln -s /tmp /workspace/vault/$OAS_VAULT_WRITE_DIR/innocent/inner
  ```
- **Steps:** `claude -p "Use vault_read to read agent-workspace/innocent/inner/x.md"`.
- **Expected:** Denied — "Path resolves outside the vault (symlink)" or similar. The realpath check resolves through multi-level symlinks.
- **Cleanup:** `rm -r /workspace/vault/$OAS_VAULT_WRITE_DIR/innocent`.
- **Notes:** P1.

### 7.4 Symlink inside write directory but pointing into vault

- **Setup:** `ln -s <vault>/notes <vault>/agent-workspace/safe-link`.
- **Steps:** `claude -p "Read agent-workspace/safe-link/<some-file>.md"`.
- **Expected:** Read succeeds — the realpath check resolves the symlink to a vault-relative target inside the read-allowed area. Outcome is deterministic across repeated runs and matches `docs/reference/settings.md`.
- **Notes:** P2. Flag mismatches against documentation.

---

## Stage 8 — Firewall

**Setup carried forward:** Stage 0–3.

### 8.1 Firewall on/off toggle live

- **Steps:** Toggle firewall via command palette and via settings; observe status bar firewall icon (🛡️).
- **Expected:** State updates within ~2 s. Status bar pill tooltip reflects on/off.
- **Notes:** P1.

### 8.2 Plugin-setting domain reaches host

- **Setup:** Settings → Additional firewall domains = `example.com`. Restart container. Enable firewall.
- **Steps:** In a terminal: `curl -I https://example.com`. Then `curl -I https://example.org`.
- **Expected:** `example.com` → 200. `example.org` → timeout or blocked by iptables.
- **Notes:** P0.

### 8.3 firewall-extras.txt works AND isn't writable by Claude

- **Setup:** Add `example.com` (a real resolvable domain) to `container/firewall-extras.txt`. Restart container.
- **Steps:** 1) In a terminal: `curl -I https://example.com` — confirm the domain is reachable. 2) `ls -la /etc/oas/firewall-extras.txt` — note the permissions. 3) `echo "evil.com" >> /etc/oas/firewall-extras.txt` — expect permission denied.
- **Expected:** 1) `example.com` is reachable via curl. 2) The file is world-readable (Claude can read its contents — this is intentional: knowing the allowlist doesn't help Claude escape, and iptables rules are what actually enforce the firewall). 3) Write attempt is denied — the file is mounted read-only at `/etc/oas/`, so Claude cannot modify the allowlist.
- **Notes:** P0. The security property is **write protection**, not read restriction.

### 8.4 --list-sources tagging

- **Steps:** `docker compose exec sandbox /usr/local/bin/init-firewall.sh --list-sources` (or run as `claude` user — read-only path).
- **Expected:** Lines tagged `[baseline]`, `[plugin]`, `[file]`. Matches Settings → Firewall → Effective allowlist (Refresh).
- **Notes:** P1.

### 8.5 Effective allowlist refresh button

- **Setup:** Firewall on.
- **Steps:** Settings → Advanced → Security section → Refresh (the "Click Refresh to fetch the effective firewall allowlist from the container" control).
- **Expected:** UI updates to current allowlist including any extras added since last refresh.
- **Notes:** P2.

### 8.6 Firewall off restores full egress

- **Steps:** Disable firewall. `curl -I https://example.org`.
- **Expected:** Reaches host (no iptables block).
- **Notes:** P1.

---

## Stage 9 — Plugin API integrations (extensions tier)

**Setup carried forward:** Stage 0–3, plus the target Obsidian plugin installed and enabled in the vault, and Extensions tier enabled.

Most Stage 9 scenarios are covered exhaustively by [mcp-capability-test.md](./mcp-capability-test.md) S8 (Extensions tier) and S9.4 (malformed args). Run the capability test under cell A (or cell F to confirm extensions gating) instead of re-exercising these manually. The scenario below is unique to the human-driven QA flow because it validates plugin-specific recurrence semantics that the capability test's S8.4 toggle doesn't specifically check.

Retired to the capability test: 9.1 (Dataview DQL → S8.1), 9.2 (Dataview disabled → S8.0 + S9.5 disabled-tier probe), 9.4 (Templater → S8.5), 9.5 (Periodic Notes → S8.8), 9.6 (Canvas → S8.6/S8.7), 9.7 (extensions list → S8.0), 9.8 (malformed args → S9.3/S9.4).

### 9.3 Tasks toggle with recurring

- **Setup:** Tasks plugin enabled. A note with `- [ ] weekly thing 🔁 every week 📅 2026-04-19`.
- **Steps:** `claude -p "Toggle the task at notes/recurring.md line 5"`.
- **Expected:** File now contains both the completed original and a fresh next occurrence (Tasks' recurring semantics).
- **Notes:** P1. The capability test's S8.4 exercises `vault_tasks_toggle` but does not assert the recurring-task engine's next-occurrence behaviour — that's what this scenario uniquely covers.

---

## Stage 10 — Cross-platform edges

**Setup carried forward:** Stage 0–2.

These require specific host hardware/OS. Run on each supported platform before release.

### 10.1 Windows + WSL2: vault path conversion

- **Setup:** Windows host, WSL2 Docker mode, vault at `C:\vault`.
- **Steps:** Start container. Inside a terminal: 1) `echo $OAS_VAULT_WRITE_DIR` — should print the configured write directory (e.g. `agent-workspace`). 2) `ls /workspace/vault` — should list vault contents. Note: `OAS_VAULT_HOST_PATH` is a compose-time variable used only for volume mount expansion; it is **not** passed into the container environment and will print empty if echoed.
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

---

## Stage 11 — Release & distribution

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

## Stage 12 — Stress, edge cases, recovery

**Setup carried forward:** Stage 0–3.

Shell-verifiable scenarios (T12.1, T12.2, T12.3, T12.7a) run via `container/test-scripts/stress-checks.sh`. The scenarios below require Obsidian to be running or are otherwise UI-bound.

```bash
bash container/test-scripts/stress-checks.sh /path/to/test-vault
# Daemon-stop probe (host-disruptive — stops and restarts Docker):
bash container/test-scripts/stress-checks.sh /path/to/test-vault --with-daemon-stop
```

### 12.1 Docker daemon stops mid-session

Automated in `stress-checks.sh T12.1` (with `--with-daemon-stop`). The automated probe verifies MCP becomes unreachable and recovers. The human-observable aspect — status bar transitioning to errored, terminal showing a helpful disconnected message — requires Obsidian to be open.

- **Setup:** Container running, terminal open.
- **Steps:** Run `stress-checks.sh --with-daemon-stop`, then observe the status bar and terminal during the stop/restart cycle.
- **Expected:** Status bar transitions to errored. Terminal shows disconnected state with helpful message. No infinite spinner. After restart: auto-start or manual Start recovers cleanly.
- **Notes:** P0. Automated probe passes before observing the UI.

### 12.2 Vault path with unicode

Automated in `stress-checks.sh T12.2`. Passes when `vault_list` succeeds through a unicode-path symlink. The human-side check (terminal `ls /vault` showing filenames correctly) is optional confirmation.

- **Notes:** P1.

### 12.3 Very large note read

Automated in `stress-checks.sh T12.3` (creates a ~5 MB note and calls `vault_read`). The human-side check — no Obsidian UI freeze — is optional confirmation.

- **Notes:** P2.

### 12.4 Many concurrent terminals

- **Steps:** Open 5 terminal tabs simultaneously.
- **Expected:** All connect. No port conflicts (ttyd handles multiplexing). CPU/memory remains reasonable.
- **Notes:** P2.

### 12.5 Plugin disable while modal is open

- **Setup:** Trigger a reviewed-write that opens a diff modal (e.g. `claude -p "Create reviewed-write: <vault>/.oas/prompts/test-reviewed.md with content 'x'"` under `writeReviewed` mode) and do NOT approve or reject it.
- **Steps:** With the modal open, close Obsidian entirely (Cmd+Q on macOS, Alt+F4 on Windows). Opening Community Plugins while a modal is visible is not possible — app-close is the realistic trigger for plugin teardown with an open modal.
- **Expected:** Obsidian closes cleanly. The pending tool call times out or resolves as rejected. On next Obsidian open, no zombie modal, no red console errors.
- **Notes:** P1.

### 12.6 Obsidian close while Claude is mid-tool-call

- **Setup:** Active Claude session in the middle of a long vault_search.
- **Steps:** Close Obsidian.
- **Expected:** Pending MCP requests are cancelled. With auto-stop on, container stops. No orphan processes (`docker ps` empty after close).
- **Notes:** P1. What's under test: whether in-flight MCP requests terminate cleanly (no deadlock) and whether the container stops without orphan processes. The ephemeral nature of the container means there's no persistent state to recover.

### 12.7a Teardown leaves no `oas-*` debris

Automated in `stress-checks.sh T12.7a`. Runs `docker compose -p oas-test down -v` and greps for leftover `oas-test-*` resources. The production volumes (`oas-claude-config`, `oas-shell-history`) are checked separately.

- **Notes:** P1.

### 12.7 No remaining DevTools console errors after a full session

- **Setup:** Open DevTools before starting. Run a representative session: start container, open terminal, do a few Claude tool calls, toggle MCP/firewall, switch sessions, close terminal.
- **Expected:** Console clean — no red errors. Warnings should each have a known reason (note them in the QA report).
- **Notes:** P1. Catch-all check.

---

## Reporting template

When recording results, prefer this shape per scenario:

```
- 3.4 Write scoped — create: PASS / FAIL / SKIP — <one-line note or screenshot link>
```

For a release, summarise:

- All `P0` scenarios across stages 1–9 + the platforms in stage 10 you ship to + stage 11.
- Any `P1` failures with workaround documented.
- `P2` failures noted but non-blocking.
