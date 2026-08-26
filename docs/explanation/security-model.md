# Security model

The sandbox balances "let Claude do useful things" against "don't let Claude damage the user's vault or escape to the host". Five layers work together.

## Layer 1: filesystem isolation

- The vault is mounted **read-only** at `/workspace/vault/` inside the container.
- Exactly one subdirectory, `$OAS_VAULT_WRITE_DIR` (default `agent-workspace/`), is mounted **read-write**. `.oas/` is also rw (memory + audit).
- Writes to any other vault path fail with `EROFS` at the kernel level, regardless of what Claude or any agent running inside the container tries to do.
- Everything under `workspace/` on the host is rw inside the container; it's explicitly Claude's domain.

This is the ground-truth invariant. The tiers and review flows layer additional controls on top, but kernel-level `ro` is the reason the vault is fundamentally safe.

## Layer 2: outbound firewall

`init-firewall.sh` restricts outbound traffic to a curated allowlist. Default-deny; only traffic to Anthropic/GitHub/npm/PyPI/CDNs/apt mirrors is permitted. The firewall lives inside the container (iptables + ipset) and must be re-applied on container start.

Extension is user-driven via two additive sources:

- **Plugin setting** `additionalFirewallDomains` → env var `OAS_ALLOWED_DOMAINS` → tagged `[plugin]`. Discoverable via settings UI. Visible to Claude via `env`.
- **Host-managed file** `container/firewall-extras.txt` mounted read-only at `/etc/oas/firewall-extras.txt` → tagged `[file]`. Not inside `/workspace`, not writable by Claude.

See `how-to/configure-firewall.md` for adding entries and `--list-sources` for auditing.

## Layer 3: MCP permission tiers

**Reconnect after toggle.** When MCP is toggled off, the server calls `closeAllConnections()` to ensure the OS port is fully released before the next start. As a side effect, any Claude CLI session using the server sees a connection error and must run `/mcp` to reconnect after MCP is re-enabled.

The MCP server's tools are split into two kinds of tier:

**Always-on (capabilities)**, enabled whenever MCP is on:
- `read`: search, read, metadata, tags, links, backlinks, frontmatter.
- `writeScoped`: create/modify within `$OAS_VAULT_WRITE_DIR`.
- `agent`: activity signal (exposes one tool, `agent_status_set`, not file access, UI only). Always-on tier rather than a separate gate because no escalation is involved.

**Gated (escalations)**, off by default. Each opt-in grants access beyond filesystem:
- **Vault-wide writes** (dropdown: `None` / `Reviewed` / `Full`). Mutually exclusive so the agent never has to choose between review-and-no-review paths:
  - `None`: scoped write directory only (default).
  - `Reviewed`: registers the `writeReviewed` tier. Vault-wide writes pop a human-in-the-loop diff modal before applying.
  - `Full`: registers the `writeVault` tier. Vault-wide writes with no review. Highest risk.
- `navigate`: open files and affect the Obsidian UI.
- `manage`: rename/move/delete (with auto link-updates).
- `extensions`: access third-party plugin APIs (Dataview, Templater, Tasks, Periodic Notes, Canvas).

`read` / `writeScoped` are "always on" because they don't grant anything Claude doesn't already have via the filesystem. They offer an ergonomic Obsidian-metadata-aware interface.

## Layer 4: human-in-the-loop review

When `writeReviewed` is enabled, every reviewed-tier write op AND every manage-tier op (when manage is also on) routes through a review modal. The reviewed-tier provides eight `_reviewed`-suffixed ops (`create`, `modify`, `append`, `prepend`, `patch`, `search_replace`, `frontmatter_set`, `frontmatter_delete`). Manage adds five more when enabled (`rename`, `move`, `delete`, `create_folder`, `batch_frontmatter`). Extensions adds three more (canvas modify, templater create, periodic note create). Manage/extensions ops go through `gateVaultWrite`, which routes to review only when the destination is outside the configured write directory. The single-file modal shows:

- For content edits: a unified diff of old vs new.
- For frontmatter edits: JSON-stringified old vs new FM.
- For rename/move/delete: the operation description plus a list of notes whose wikilinks reference the target (from `resolvedLinks`).

The gate is **structural**: every write handler in `mcp-tools-registrars/write-factory.ts` constructs a `runWrite` call, so there's no path that mutates without passing through the review step. Adding a new write op requires opting out of review, not the default.

`vault_batch_frontmatter` uses the per-item checkbox `BatchReviewModal` so the user can approve a subset of matched files in one pass.

## Layer 5: rate limiting and audit

- **Rate limit** per tool: token-bucket. 60/min for `read` and `navigate`; 20/min for every other tier (`writeScoped`, `writeReviewed`, `writeVault`, `manage`, `extensions`, `agent`). The "write" budget covers read-shaped extensions tools (Dataview/Tasks queries, Canvas read) too. They get the lower budget by virtue of the tier they belong to, not the operation they perform.
- **Audit log**: in-memory ring buffer of 200 entries, plus append-only JSONL at `vault/.oas/mcp-audit.jsonl` with 1 MB single-generation rotation. `GET /mcp/audit` returns the ring buffer.

Neither layer prevents malicious use. They make it visible after the fact.

## Threat model notes

**Trusted**:
- You (the user) running Obsidian on your machine.
- Claude as an agent, under the observation of a human in the loop.

**Sudo password isolation.** The optional sudo password (used to gate `apt-get` inside the container) is stored via Obsidian's secret storage (`app.secretStorage`), which keeps the value in app-level local storage keyed to the vault — outside the vault tree the container mounts. The agent therefore cannot read or modify the password. Note that, as of Obsidian 1.11.4, secret storage holds the value as plaintext at rest (OS-keychain encryption is planned but not yet shipped); isolation from the container, not at-rest encryption, is the property relied on here.

**Not trusted**:
- Arbitrary code the agent might execute or download.
- Outbound connections to hosts other than the baseline allowlist.
- Symlinks or paths that escape the vault (Layer 1 is complemented by `isRealPathWithinBase` inside resolveFile so symlinked escapes from the agent get caught before filesystem ops).

**Out of scope**:
- Side-channel attacks (timing, power).
- Hostile Obsidian plugins running in the user's vault. Those are outside the sandbox's control.
- Compromise of the host system by Docker / WSL2 bugs. Keep your container runtime patched.
