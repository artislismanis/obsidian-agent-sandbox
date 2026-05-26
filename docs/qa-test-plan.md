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
- **Notes:** P0. Restart Docker before continuing.

### 1.6 Write directory validation in settings

- **Setup:** Plugin enabled. Settings → General open.
- **Steps:** 1) Attempt to type a path outside the vault (e.g. `/root/forbidden` or `../../escape`) into **Vault write directory**. 2) Manually edit the vault's `data.json` (`.obsidian/plugins/obsidian-agent-sandbox/data.json`) to set `vaultWriteDir` to a path that escapes the vault, then reload the plugin.
- **Expected:** 1) Settings UI rejects or sanitises the input — the field does not accept paths outside the vault root. 2) On load the plugin normalises the stored value back to a vault-relative path; no container crash or half-up state results. No clear failure Notice for the invalid-path case is expected because the invalid state cannot be reached at startup.
- **Notes:** P1. The protection is in the settings layer, not the startup path. The original "startup failure" scenario is not reachable because the UI and settings-load sanitisation prevent it.

### 1.7 Port conflict detection

The plugin has **two separate** conflict-detection mechanisms with different code paths, failure modes, and platform behaviour. Keep them separate when testing.

**Port-occupier reference** — pick the one-liner that matches your host OS and the bind address shown in settings. The occupier must run in the **same network namespace as the process doing the bind** (see per-scenario notes below).

| Host | `127.0.0.1` (loopback) | `0.0.0.0` (all interfaces) | Specific IP |
|---|---|---|---|
| Windows (PowerShell) | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, <PORT>); $l.Start()` | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, <PORT>); $l.Start()` | `$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('<IP>'), <PORT>); $l.Start()` |
| Linux / macOS / WSL shell | `python3 -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',<PORT>)); s.listen(); print('bound'); sys.stdin.read()"` | same with `'0.0.0.0'` | same with `'<IP>'` |
| Linux, netcat-openbsd only | `nc -l 127.0.0.1 <PORT>` | `nc -l 0.0.0.0 <PORT>` | `nc -l <IP> <PORT>` |

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
- **Steps:** Open command palette and search "Sandbox". Confirm all 12 commands are listed (see `plugin/src/main.ts` for the canonical list — `open-claude-terminal`, `sandbox-start-container`, `sandbox-stop-container`, `sandbox-container-status`, `sandbox-restart-container`, `sandbox-toggle-firewall`, `open-session`, `open-browser`, `sandbox-toggle-mcp`, `sandbox-copy-terminal-connection-log`, `sandbox-cleanup-sessions`, `sandbox-switch-session`).
- **Expected:** All visible, each runs without throwing when invoked in this state (most should no-op with a Notice).
- **Notes:** P2. Quick smoke check.

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
- **Notes:** P1. Use the plugin commands (not `docker compose` directly) — bare Docker commands bypass the plugin's env vars (`OAS_VAULT_PATH`, `OAS_TTYD_PORT`, etc.) and produce a misconfigured container.

### 2.11a Startup progress indicator detail

- **Setup:** Obsidian closed, container stopped, auto-start on.
- **Steps:** Open Obsidian. Open DevTools (Ctrl+Shift+I) → Console tab. Filter by "Sandbox:".
- **Expected:** All four phase strings appear in the console in order: "Starting: checking Docker availability…" → "Starting: probing WSL (5s fast-fail)…" → "Starting: probing container status…" → "Starting: docker compose up -d (auto-start)…". Visual hover of the status bar tooltip is best-effort — on warm systems the transitions can be sub-second and hard to observe.
- **Notes:** P2. On non-WSL platforms the WSL probe should still appear and resolve to "not WSL".

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
- **Expected:** Clipboard contains a multi-line log of the connection lifecycle (attempts, URLs sans token, timestamps). Paste into a scratchpad to verify.
- **Notes:** P2. Useful for support; verify it doesn't leak the MCP token.

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
- **Notes:** P1. Reset to default afterwards. Sudoers is restricted to `apt-get`/`apt` only — other `sudo` commands will be rejected regardless of password.
- **Note:** Toggling the sudo password between empty and non-empty changes the container's `security_opt` set, so the next start/restart recreates the container (compose detects the config drift). New container ID expected.

---

## Stage 3 — Claude authenticated, MCP enabled

**Setup carried forward:** Stage 0–2, plus Claude logged in inside the container (`docker compose exec sandbox claude` once) and MCP enabled in plugin settings.

This is where the bulk of the value lives — interactive Claude against the plugin's own Obsidian MCP server.

For an exhaustive per-tool sweep that runs itself (Claude drives, this plan stays human-driven), see [mcp-capability-test.md](./mcp-capability-test.md). The two are complementary: this stage validates the happy paths and the tier-toggle UX from a human's perspective; the capability test plan validates schema shapes, error messages, and per-tier gating exhaustively.

**Tier model (`src/permission-tiers.ts`):**
- Always-on when MCP is enabled: `read`, `writeScoped`, `agent`.
- Toggled per-tier: `navigate`, `manage`, `extensions`.
- Vault write mode (dropdown): `none` (default) / `reviewed` (`writeReviewed` tier, diff modal per change) / `full` (`writeVault` tier, unrestricted, no review).
- Tool naming: scoped writes are `vault_create` / `vault_modify` / `vault_append` / `vault_frontmatter_set`; reviewed mode adds `_reviewed` suffix; full mode adds `_anywhere` suffix.

### 3.1 MCP tool announcement

- **Steps:** In a terminal: `claude -p "What MCP tools do you have? List them."`
- **Expected:** With defaults (gated tiers off, vault write mode `none`), the response lists the always-on set: reads (`vault_read`, `vault_list`, `vault_search`, `vault_search_fuzzy`, `vault_file_info`, `vault_tags`, `vault_frontmatter`, `vault_links`, `vault_backlinks`, `vault_headings`, `vault_orphans`, `vault_unresolved`, `vault_recent`, `vault_properties`, `vault_graph_neighborhood`, `vault_graph_path`, `vault_graph_clusters`, `vault_context`, `vault_suggest_links`) and scoped writes (`vault_create`, `vault_modify`, `vault_append`, `vault_frontmatter_set`). All prefixed `mcp__obsidian__`.
- **Notes:** P0. If absent, the plugin's MCP server isn't reachable from the container — check token, port, bind address, firewall.

### 3.2 Vault search

- **Setup:** A note in your vault containing a unique distinctive word, e.g. "zorblax".
- **Steps:** `claude -p "Search my vault for zorblax"`.
- **Expected:** `vault_search` call returns the file path and snippet.
- **Notes:** P0.

### 3.3 Vault read

- **Steps:** `claude -p "Read the file Welcome.md and summarise it in one sentence"` (use any real vault file).
- **Expected:** Calls `vault_read`, returns content, summarises.
- **Notes:** P0.

### 3.4 Write scoped — create

- **Setup:** Default Write directory `agent-workspace/`.
- **Steps:** `claude -p "Create a file agent-workspace/hello.md with content 'Hello world'"`.
- **Expected:** File appears in vault file explorer. Content matches.
- **Notes:** P0. Cleanup: delete the file.

### 3.5 Write scoped — denied outside scope

- **Steps:** `claude -p "Create a file notes/intrusion.md with 'should fail'"` (path outside Write directory).
- **Expected:** Tool returns a clear "outside write directory" error; file is NOT created.
- **Notes:** P0.

### 3.6 Navigate tier — open file

- **Setup:** Navigate tier enabled. Toggle MCP off then on so the server picks up the change.
- **Steps:** `claude -p "Open Welcome.md in the editor"`.
- **Expected:** File becomes the active tab in Obsidian.
- **Notes:** P1.

### 3.7 Navigate tier — disabled removes tool

- **Setup:** Disable Navigate, restart MCP.
- **Steps:** `claude -p "What MCP tools do you have?"` then attempt `Open ... in the editor`.
- **Expected:** `vault_open` absent from the list. Attempting to open returns a graceful "not available" rather than a crash.
- **Notes:** P1. Re-enable Navigate before continuing.

### 3.8 Manage tier — rename with backlinks

- **Setup:** Manage tier on. Two notes A.md and B.md both linking to `notes/old.md`.
- **Steps:** `claude -p "Rename notes/old.md to notes/new.md"`.
- **Expected:** File renamed; A.md and B.md wikilinks updated automatically.
- **Notes:** P0.

### 3.9 Manage tier — move

- **Steps:** `claude -p "Move notes/new.md into folder archive/"`.
- **Expected:** File moves; links update.
- **Notes:** P1.

### 3.10 Manage tier — delete + create folder

- **Steps:** `claude -p "Delete archive/new.md"` then `claude -p "Create a folder called scratch/2026"`.
- **Expected:** Deletion succeeds (file gone from vault). Folder appears.
- **Notes:** P1. Cleanup: remove the scratch folder.

### 3.11 Always-on tiers have no toggle

- **Setup:** Settings → MCP, with MCP enabled.
- **Steps:** Inspect the permissions section.
- **Expected:** Three toggles only (Navigate, Manage, Extensions) and one dropdown (Vault write mode: `none` / `reviewed` / `full`). No UI control for `read`, `writeScoped`, or `agent`; their tools always appear in `vault_*` listings while MCP is on.
- **Notes:** P2. Confirms `docs/reference/settings.md` matches reality.

### 3.12 MCP token rotation kicks live connections

- **Setup:** Active Claude session connected to MCP.
- **Steps:** Click Regenerate token in plugin settings. In the same terminal, try another tool call.
- **Expected:** The next call fails auth. Restarting the container per the regenerate-button description, then restarting Claude, restores tool access.
- **Notes:** P1.

### 3.13 MCP turn-off mid-session

- **Setup:** Active Claude session that recently used a vault tool.
- **Steps:** Toggle MCP off via command palette. Submit another tool-using prompt.
- **Expected:** Tools fail cleanly (404 / connection refused). Re-enabling MCP lets a new Claude invocation pick them back up.
- **Notes:** P1.

### 3.14 Read-toolbelt spot-check against a real vault

- **Setup:** A vault with: ≥1 note with frontmatter (incl. an array property and a number), 2-3 notes with `#tags`, a note with `[[wikilinks]]` to another note, ≥1 orphan, ≥1 unresolved wikilink target.
- **Steps:** Drive each with `claude -p`:
  - `vault_list` on root.
  - `vault_search_fuzzy` for a near-miss term (one typo).
  - `vault_tags`.
  - `vault_frontmatter` on the frontmatter note.
  - `vault_links` and `vault_backlinks` on the linker/linked notes.
  - `vault_headings` on a note with ≥3 headings.
  - `vault_orphans`, `vault_unresolved`, `vault_recent`, `vault_properties`.
  - `vault_graph_neighborhood` and `vault_graph_path` on two connected notes.
  - `vault_context` and `vault_suggest_links` on a note.
- **Expected:** Each returns plausible data without `isError: true`. Metadata-cache-backed tools (`vault_backlinks`, `vault_tags`, `vault_orphans`) reflect actual vault state.
- **Notes:** P1. Real-cache smoke for the read surface.

### 3.15 `vault_append` adds without rewriting

- **Setup:** `notes/log.md` with 3 stable lines.
- **Steps:** `claude -p "Append 'new entry' to notes/log.md"`.
- **Expected:** File has 4 lines; original 3 untouched. Under reviewed mode (Stage 4), diff modal shows only the addition.
- **Notes:** P1.

### 3.16 MCP cache invalidates on live edits

- **Setup:** `notes/cache.md` with first line `version A`. Vault open in Obsidian.
- **Steps:** 1) `claude -p "Read notes/cache.md and quote the first line"`. 2) Edit in Obsidian so first line becomes `version B`; save. 3) Within ~2 s: re-read via Claude.
- **Expected:** Second read returns `version B`. Document observed window if >5 s.
- **Notes:** P1. Stale reads after user edits are silent and confusing.

### 3.17 Concurrent MCP tool calls

- **Setup:** Vault with ≥10 notes containing "alpha" and ≥10 containing "beta".
- **Steps:** `claude -p "In parallel, search the vault for 'alpha' and for 'beta' and read the first three hits of each."`
- **Expected:** All calls complete without deadlock or `isError`. DevTools shows interleaved tool-call logs.
- **Notes:** P1. No automated coverage of parallel tool calls against the live app.

### 3.18 File ownership after Claude writes (Linux)

- **Setup:** Linux host, vault on host filesystem. Note host uid: `id -u`.
- **Steps:** `claude -p "Create agent-workspace/owner-test.md with content 'check uid'"`. Then: `ls -la <vault>/agent-workspace/owner-test.md` and edit in Obsidian.
- **Expected:** Obsidian edits the file without permission errors. Owner uid matches host uid, or mode is permissive enough that the host user can write.
- **Notes:** P1. Cleanup: delete the file.

### 3.19 Vault write mode = `full` (`_anywhere` tier)

- **Setup:** Settings → MCP → Vault write mode = `full`. Toggle MCP off then on to refresh the tool list.
- **Steps:** 1) `claude -p "What MCP tools do you have?"` — confirm `vault_create_anywhere`, `vault_modify_anywhere`, `vault_append_anywhere`, `vault_frontmatter_set_anywhere` are present. 2) `claude -p "Create a file notes/anywhere-test.md with 'ok'"` (outside write directory). 3) Set mode to `none`, toggle MCP. 4) Repeat step 2.
- **Expected:** Step 2 succeeds, file in `notes/`. Step 4 fails: no `_anywhere` tools; scoped `vault_create` rejects with "outside write directory". No diff modal in full mode.
- **Notes:** P0. Cleanup: delete `notes/anywhere-test.md`, confirm mode back to default.

### 3.20 Awaiting-input badge

- **Setup:** Active Claude session (terminal open, Claude running). `agent` tier enabled (always-on when MCP is on).
- **Steps:** Trigger a tool call that causes Claude to pause awaiting human input (e.g. a reviewed-write that opens the diff modal, or a direct `agent_status_set` call via MCP).
- **Expected:** Sandbox pill in the status bar gains a trailing ` ⚠` while the agent is awaiting input: `Sandbox: ▶ Running ⚠`. Badge clears when the session is no longer awaiting input.
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

### 5.12 Clean up empty sessions

- **Setup:** Two tmux sessions created, one attached in Obsidian, one detached.
- **Steps:** Command palette → **Sandbox: Clean up empty sessions**. Modal appears.
- **Expected:** Only the detached one listed. Uncheck to keep / check to kill. Kill selected → Notice "1/1 killed".
- **Notes:** P1.

### 5.13 Failed kill is logged, not swallowed

- **Setup:** Two empty tmux sessions, one with a name tmux will choke on (manually inject via `tmux rename-session`).
- **Steps:** Clean up empty sessions → check both → Kill.
- **Expected:** Valid one killed. Failure for the other logged to DevTools console (`[Agent Sandbox] failed to kill tmux session …`). Aggregate Notice reports `1/2 session(s) killed`.
- **Notes:** P2.

---

## Stage 6 — URI handlers + context menu

**Setup carried forward:** Stage 0–3.

### 6.1 obsidian:// open-terminal

- **Steps:** Paste `obsidian://agent-sandbox/open-terminal` into a browser URL bar.
- **Expected:** Obsidian focuses, opens a new terminal tab.
- **Notes:** P1.

### 6.2 obsidian:// analyze

- **Setup:** Vault note `notes/foo.md` exists. `workspace/.claude/prompts/summarize.md` exists.
- **Steps:** `obsidian://agent-sandbox/analyze?path=notes/foo.md&template=summarize`.
- **Expected:** New terminal opens; first command typed is the summarize template with `@notes/foo.md` substituted.
- **Notes:** P1.

### 6.3 Context menu → Analyze in Sandbox

- **Setup:** `workspace/.claude/prompts/` populated with the four shipped templates.
- **Steps:** Right-click a vault note → **Analyze in Sandbox**.
- **Expected:** Submenu shows Summarize, Critique, Explain, Extract TODOs, plus "Custom prompt…". Picking one opens a new terminal and seeds the prompt.
- **Notes:** P1.

### 6.4 Templates render on first right-click after reload

- **Setup:** Templates as above. Fully reload Obsidian.
- **Steps:** **Immediately** after Obsidian finishes loading, right-click a vault note → **Analyze in Sandbox**.
- **Expected:** Submenu already populated, not collapsed to "Custom prompt…" only.
- **Notes:** P1.

### 6.5 Empty prompts dir collapses submenu

- **Setup:** Move `workspace/.claude/prompts/*` aside.
- **Steps:** Right-click a note → Analyze in Sandbox.
- **Expected:** Submenu shows only "Custom prompt…", which opens a modal. Typing text and clicking Run → new terminal with the one-off prompt.
- **Notes:** P2. Restore prompts after.

### 6.6 Custom prompt modal edge inputs

- **Setup:** Templates present.
- **Steps:** Right-click → Analyze in Sandbox → Custom prompt. In turn: 1) empty + Run, 2) Cancel, 3) ~2000-character prompt, 4) prompt with shell metacharacters: `` echo `id`; $(whoami) && rm -rf /tmp/nope ``.
- **Expected:** 1) No-op or validation hint; no terminal opens. 2) Modal closes; no terminal. 3) Terminal opens with full text seeded, no truncation. 4) Metacharacters passed to `claude` as a single argument — `id` / `whoami` must not execute on open.
- **Notes:** P1. Shell-escaping regressions here are a command-injection risk.

---

## Stage 7 — Symlink and path-traversal real-filesystem checks

**Setup carried forward:** Stage 0–3.

Unit tests cover `isRealPathWithinBase` with mocked realpath. These verify the OS round-trip.

### 7.1 Read of escaping symlink is denied

- **Setup:** From host shell: `cd <vault-root> && ln -s /etc/hosts evil.md`.
- **Steps:** `claude -p "Read the file evil.md"`.
- **Expected:** `vault_read` returns "File not found." Real `/etc/hosts` never returned.
- **Cleanup:** `rm <vault-root>/evil.md`.
- **Notes:** P0.

### 7.2 Create into symlinked directory denied

- **Setup:** `cd <vault-root> && ln -s /tmp escape`.
- **Steps:** `claude -p "Create a file escape/note.md with 'hi'"`.
- **Expected:** `vault_create` returns "Path resolves outside the vault (symlink)."
- **Cleanup:** `rm <vault-root>/escape`.
- **Notes:** P0.

### 7.3 Nested symlinks resolve fully

- **Setup:** `mkdir <vault>/innocent && ln -s /tmp <vault>/innocent/inner`.
- **Steps:** Attempt to read/write `innocent/inner/x.md`.
- **Expected:** Denied. The realpath check resolves through multi-level symlinks.
- **Cleanup:** Remove both.
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

### 8.3 firewall-extras.txt works AND isn't readable by Claude

- **Setup:** Add `internal.corp.example` to `container/firewall-extras.txt`. Restart container.
- **Steps:** 1) `curl -I https://internal.corp.example` from terminal. 2) `claude -p "Read /etc/oas/firewall-extras.txt"`.
- **Expected:** 1) Reaches host. 2) Fails — path outside `/workspace`, MCP read denies.
- **Notes:** P0.

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

Real-plugin scenarios. Unit tests use stubs; these prove the real API plumbing.

### 9.1 Dataview DQL

- **Setup:** Dataview installed. Vault has a few notes with frontmatter `rating`.
- **Steps:** `claude -p 'Run DQL: TABLE rating FROM "" SORT rating DESC LIMIT 5'`.
- **Expected:** `vault_dataview_query` returns `{headers, values}` matching what a Dataview block would render.
- **Notes:** P1.

### 9.2 Dataview disabled → tool absent

- **Setup:** Disable Dataview (keep Extensions tier on).
- **Steps:** `claude -p "What MCP tools do you have?"`.
- **Expected:** No `vault_dataview_query`. Subsequent attempt to use it returns a clear "not available".
- **Notes:** P1. Re-enable Dataview after.

### 9.3 Tasks toggle with recurring

- **Setup:** Tasks plugin enabled. A note with `- [ ] weekly thing 🔁 every week 📅 2026-04-19`.
- **Steps:** `claude -p "Toggle the task at notes/recurring.md line 5"`.
- **Expected:** File now contains both the completed original and a fresh next occurrence (Tasks' recurring semantics).
- **Notes:** P1.

### 9.4 Templater create

- **Setup:** Templater enabled. Template `Templates/daily.md` with at least one Templater tag (e.g. `<% tp.date.now() %>`).
- **Steps:** `claude -p "Create a note from Templater template Templates/daily.md named 2026-04-19 in folder Daily"`.
- **Expected:** `Daily/2026-04-19.md` exists with tags expanded.
- **Notes:** P1.

### 9.5 Periodic Notes resolve + create

- **Setup:** Periodic Notes installed, daily notes folder = `Daily/`, format `YYYY-MM-DD`.
- **Steps:** 1) `claude -p "What's the path of today's daily note?"`. 2) `claude -p "Create today's daily note if missing"`.
- **Expected:** 1) Existing or "Not found". 2) Creates correctly with configured template seeded.
- **Notes:** P1.

### 9.6 Canvas read/modify

- **Setup:** Create `board.canvas` via Obsidian UI with 2 nodes + 1 edge.
- **Steps:** 1) `claude -p "Show me the JSON structure of board.canvas"`. 2) `claude -p "Add a text node id 'n3' to board.canvas"`.
- **Expected:** 1) Returns canvas JSON. 2) File rewritten, new node visible in Obsidian.
- **Notes:** P2.

### 9.7 plugin_extensions_list reports state

- **Steps:** `claude -p "List the plugin_extensions available"`.
- **Expected:** One line per integration with `enabled` / `not available` / `always (native format)` matching reality.
- **Notes:** P2.

### 9.8 Malformed args return validation error

- **Setup:** Any MCP-using client.
- **Steps:** Invoke `vault_search` with `{ "query": 123 }`, or `vault_read` with `{}`.
- **Expected:** `isError: true` with message `Invalid arguments: …` (zod detail).
- **Notes:** P1.

---

## Stage 10 — Cross-platform edges

**Setup carried forward:** Stage 0–2.

These require specific host hardware/OS. Run on each supported platform before release.

### 10.1 Windows + WSL2: vault path conversion

- **Setup:** Windows host, WSL2 Docker mode, vault at `C:\vault`.
- **Steps:** Start container. Inside: `echo $OAS_VAULT_PATH`.
- **Expected:** Resolves to `/mnt/c/vault`. No `wsl.exe` console flashes during start/stop.
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

### 12.1 Docker daemon stops mid-session

- **Setup:** Container running, terminal open.
- **Steps:** From host: stop Docker.
- **Expected:** Status bar transitions to errored. Terminal shows disconnected state with helpful message. No infinite spinner. Restarting Docker → plugin recovers (auto-start or manual Start succeeds).
- **Notes:** P0.

### 12.2 Vault path with unicode

- **Setup:** Vault path includes non-ASCII (e.g. `~/Документы/vault`).
- **Steps:** Start container. Open terminal. `ls /vault`.
- **Expected:** Mount works. Filenames with unicode list correctly.
- **Notes:** P1.

### 12.3 Very large note read

- **Setup:** Note ~5 MB.
- **Steps:** `claude -p "Read the file big.md and tell me its first line"`.
- **Expected:** Returns the first line. No timeout, no Obsidian UI freeze. Document any hard cap.
- **Notes:** P2.

### 12.4 Many concurrent terminals

- **Steps:** Open 5 terminal tabs simultaneously.
- **Expected:** All connect. No port conflicts (ttyd handles multiplexing). CPU/memory remains reasonable.
- **Notes:** P2.

### 12.5 Plugin disable while modal is open

- **Setup:** Trigger a review modal but don't approve/reject.
- **Steps:** Disable the plugin from Community Plugins.
- **Expected:** Modal closes cleanly. Pending tool call resolves as rejected/error to Claude. No console errors.
- **Notes:** P1.

### 12.6 Obsidian close while Claude is mid-tool-call

- **Setup:** Active Claude session in the middle of a long vault_search.
- **Steps:** Close Obsidian.
- **Expected:** Pending MCP requests are cancelled. With auto-stop on, container stops. No orphan processes.
- **Notes:** P1.

### 12.7a Teardown leaves no `oas-*` debris

- **Setup:** Production container running; integration tests have been run at least once.
- **Steps:** `cd container && docker compose down`. Then: `docker ps -a | grep oas-`, `docker volume ls | grep oas-`, `docker network ls | grep oas-`.
- **Expected:** No `oas-sandbox` container. `oas-claude-config` and `oas-shell-history` volumes remain. No `oas-test-*` resources. `docker compose down -v` then removes the production volumes.
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
