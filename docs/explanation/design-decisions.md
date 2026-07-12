# Design decisions

Notable choices in the plugin's design, with their reasoning. The rest of the architecture is in `architecture.md`.

## Why a three-way split (plugin / container / workspace)?

The alternative is one folder with everything. The split enforces a property via structure:

- **`container/`** is NOT mounted inside the running container. Claude running as an agent cannot read or modify the Dockerfile, compose config, or firewall script. Anyone editing `container/` is doing infra work, by choice.
- **`workspace/`** IS mounted rw. Claude writes to `.claude/settings.json`, `skills/`, `prompts/`, and so on.
- **`plugin/`** runs on the host; the container never sees it.

This is enforced by what docker-compose mounts, not by convention. Breaking it requires editing `docker-compose.yml`, which is itself outside the container.

## Why MCP over a file-based protocol for activity signalling?

MCP won over file-based signalling (agent writes state to a well-known path; plugin watches) because:

- **Standardised.** Any MCP-capable agent can discover the tool via `tools/list`: no ad-hoc path convention.
- **Reuses infrastructure.** Auth, rate limiting, audit log already exist for vault tools. No new file watcher, no cross-platform `fs.watch` quirks.
- **Schema-validated.** Zod handles input validation on the same footing as every other tool.

The tradeoff: when MCP is disabled, the activity indicator is dead. Acceptable: if MCP is off, you don't have any of the vault integration either.

## Why two firewall-extension routes (setting + file)?

A single setting is discoverable but Claude can see it; a single host-side file is secure but invisible. Shipping both:

- **Setting** (`additionalFirewallDomains`) for domains you're happy to see in the UI: Atlassian, Slack, etc.
- **File** (`container/firewall-extras.txt`, mounted read-only outside `/workspace`) for corporate domains, internal services, or anything you'd rather the agent not know about.

Additive union; no precedence; `--list-sources` tags every entry with its origin so troubleshooting is straightforward.

## Why no separate permission toggle for read / writeScoped?

Every MCP tier (read, writeScoped, agent, navigate, manage, extensions, writeReviewed, writeVault) as a separate settings toggle would mislead users: "turning off `read` denies Claude access to vault content" is false, Claude can always read the vault via filesystem. The toggles control whether the Obsidian-metadata-aware *tools* are registered, which is an ergonomics switch, not a permission gate.

The split: `read` and `writeScoped` (capability tiers, always on) vs the five escalation tiers (real permissions, user toggles). **Toggles exist for capabilities that go beyond filesystem access.**

## Why structural review-gate instead of per-handler calls?

Every write handler routes through `runWrite`, which calls `requireReview` unconditionally. Forgetting review on a new handler is a compile-time error (missing field) or a failing test, not a silent bypass.

## Why file-based audit log on top of the in-memory ring buffer?

The ring buffer (last 200 entries) is for the live `/mcp/audit` endpoint: cheap, always-current. Plugin restarts clear it.

The JSONL file at `vault/.oas/mcp-audit.jsonl` is the long-horizon record. Size-capped at 1 MB with single-generation rotation (`.1.jsonl`). Sink errors never block tool execution: audit is best-effort by design.

## Why chunked Promise.all over `vault.getMarkdownFiles()`?

`vault_search`, `vault_suggest_links`, and `vault_batch_frontmatter` all iterate the full markdown set. Loading everything at once spikes memory. Iterating one at a time leaves RTT on the table. The `forEachMarkdownChunked` helper batches reads in groups of 20: most of the parallelism win without the memory blowup.

## Why eager client-side ttyd probe before WebSocket?

`pollUntilReady` hits `/` on the ttyd port via `requestUrl` (which bypasses CORS) before opening the WebSocket. A WebSocket open failure is less debuggable than an HTTP 404: knowing "ttyd isn't up yet" vs "ttyd is up but rejecting" is useful. Exponential backoff (500 ms × 1.5ⁿ, capped at 5s) keeps the initial probe fast without hammering on slow cold starts.

## Why strip application mouse-tracking in the terminal?

Claude Code's full-screen ("non-flicker") TUI enables terminal mouse-tracking.
Once an application turns that on, xterm.js forwards mouse events to the
application and stops doing native text selection — so drag-to-select and the
plugin's auto-copy-on-selection stop working, and copy falls back to escape
sequences that don't reach the host clipboard through this delivery path.

The plugin swallows the mouse-tracking DECSET modes (`CSI ? Pm h/l` for modes
9/1000–1003/1005/1006/1015/1016) in `terminal-view.ts` via a parser handler, so
xterm never enables mouse reporting and native selection/copy always work.

Three alternatives were rejected:

- **`"tui": "default"`** (revert Claude to the classic renderer) depends on a
  Claude Code setting we don't control and gives up the flicker-free rendering.
- **OSC 52 clipboard + Shift-drag selection** keeps mouse capture, which leaves a
  plain-drag-doesn't-select asymmetry.
- **A user toggle** would be speculative; the tradeoff is clear and reversible.

The chosen approach keeps the new renderer, gives reliable native selection/copy
of on-screen text in the Obsidian pane, and — because it lives in the plugin
rather than a Claude setting — stays robust across Claude Code TUI changes. The
accepted cost is that Claude's in-TUI mouse features (clicking options,
mouse-scroll within its viewport) are inactive in the sandbox terminal; it stays
keyboard-driven. Because a full-screen TUI renders on the alternate screen (no
xterm scrollback of its own), the wheel scrolls within the app and selection
covers the visible viewport; classic mode (`tui: "default"`) or running inside a
`session` keeps the main screen, where terminal scrollback and full-history
selection apply.

## Why use Obsidian's bundled moment for Periodic Notes formatting?

Periodic Notes stores its format strings in moment.js syntax. We import `moment` from `obsidian` (already bundled and externalised by esbuild) rather than adding a moment/dayjs dependency or shipping our own minimal formatter. Reusing Obsidian's bundle costs nothing in plugin size, and matches the format semantics Periodic Notes itself uses. There's no risk of a subtle divergence between our formatter and the one the rest of Obsidian relies on.
