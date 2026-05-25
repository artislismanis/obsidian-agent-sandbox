# Port-conflict detection: gaps and improvements

Surfaced while updating QA scenario 1.7. Three defects, ordered by user impact.

## Task 1 — WSL2 NAT mode breaks ttyd pre-flight (P0)

### Symptom
On Windows host → WSL2 NAT mode → Docker, `checkStartupPortConflicts` runs in
the Obsidian process on the Windows host and probes `127.0.0.1:<ttydPort>`.
Docker compose then binds inside the WSL2 network namespace. The two
namespaces are disjoint in NAT mode, so a conflict on the WSL side passes
pre-flight silently; the container starts, the terminal tab spins and never
connects, no friendly Notice fires.

### Root cause
`plugin/src/main.ts:1010–1017` and `plugin/src/docker.ts:699–739` use a
Node `net.createServer().listen(port, host)` probe inside the plugin
process — host-only, never crosses into WSL2.

### Fix sketch
Detect WSL mode early (already available via `getWslNetworkingMode()` in
`docker.ts`). On **NAT** mode, route the probe into WSL:

- `wsl -d <distro> -- ss -tlnH "sport = :<port>"` — non-empty stdout ⇒ conflict.
- Fallback if `ss` unavailable: `wsl -d <distro> -- bash -c 'echo > /dev/tcp/127.0.0.1/<port>' 2>/dev/null && echo conflict`.
- Keep the existing host-side `net.createServer` probe for non-WSL and WSL mirrored mode.

Wire both into `checkPortConflicts` (or a sibling taking a "where to probe"
parameter) and dispatch from `checkStartupPortConflicts` based on networking
mode. Surface the same friendly Notice on conflict.

### Tests
- Unit: stub `wsl -d ... ss -tln` output in a `checkPortConflicts` test variant;
  assert correct conflicts list returned. Add to `plugin/src/__tests__/docker.test.ts`.
- Manual: WSL2 NAT mode, occupy port inside a WSL shell
  (`python3 -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',7681)); s.listen(); print('bound'); sys.stdin.read()"`),
  start container → expect Notice `Port conflict: 7681 already in use…`.

### Files
- `plugin/src/docker.ts` — `checkPortConflicts` or new sibling with WSL-aware probe path.
- `plugin/src/main.ts` — `checkStartupPortConflicts` dispatches by WSL mode.
- `plugin/src/__tests__/docker.test.ts` — new test case for WSL NAT probe path.

---

## Task 2 — Notice text hard-codes `127.0.0.1` (P2)

### Symptom
`main.ts:574` emits `Port conflict: <port> already in use on 127.0.0.1. …`
even when `ttydBindAddress` is `0.0.0.0` or a specific IP, which misleads
users debugging multi-interface setups.

### Fix
Interpolate `this.settings.ttydBindAddress || "127.0.0.1"` into the Notice
string at `main.ts:574`. Check the same hard-coding in any MCP error path.

### Tests
- Manual: set Settings → Terminal → Bind address to `0.0.0.0`, occupy that
  port, start container → confirm Notice mentions `0.0.0.0`.

### Files
- `plugin/src/main.ts` — Notice template at line ~574. Bundle in whatever PR
  touches this area (e.g. Task 1).

---

## Task 3 — Terminal tab fails silently when ttyd never came up (P1)

### Symptom
When ttyd doesn't bind (Task 1 gap case, or any other compose-bind failure),
`docker compose up -d` still exits 0 (container is "running"), but the
terminal tab opens to a spinner and reports nothing useful to the user.

### Fix sketch
In `postStartTasks` (`main.ts:593`), add a short post-start ttyd reachability
probe (HTTP GET `/` on `<ttydBindAddress>:<ttydPort>`, ~3 s timeout, 1–2
retries). On failure:

- Show Notice: `Sandbox started but terminal isn't reachable on <bind>:<port>. Check for a port conflict or run 'docker compose logs' to investigate.`
- Optionally transition status bar to a "degraded" sub-state distinct from "running".

This is defence-in-depth: it catches the residual silent-failure case even
after Task 1 lands (e.g. future compose-level bind errors on other platforms).

### Tests
- Manual: set `OAS_TTYD_PORT` (via Settings → Terminal → Port) to a value that
  won't match the compose mapping (e.g. 7682 while compose still maps 7681)
  and restart container → confirm degraded Notice fires within a few seconds.

### Files
- `plugin/src/main.ts` — `postStartTasks`.
- `plugin/src/ttyd-client.ts` — expose a low-level reachability probe if one
  doesn't already exist (check `pollUntilReady` or similar functions first).

---

## Order of work
1. **Task 1** — biggest impact; unblocks meaningful QA 1.7a coverage on WSL2 NAT.
2. **Task 3** — defence-in-depth; catches the residual silent-failure case for any cause.
3. **Task 2** — cosmetic; bundle with whichever PR already touches `main.ts:574`.
