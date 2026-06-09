# Architecture

This document explains **why** the repository splits into `container/` (infra) and `workspace/` (Claude's domain), and the extensibility tier model that falls out of that split. It is the host-facing rationale. Claude running inside the sandbox does not see this file. All rules Claude needs to follow live in `workspace/CLAUDE.md`.

## Core insight

The container is the security boundary. Inside it, Claude runs with `bypassPermissions` and does whatever it wants on the filesystem and network (minus the firewall allowlist). The useful restriction is not *what* Claude can do inside the container. It is *where* changes live and how they flow back.

So the repo is structured to make that distinction mechanical, not conventional:

- `container/` is infra. It builds the image. It is not mounted into Claude's visible filesystem, with two read-only exceptions bind-mounted at `/etc/oas/`, outside `/workspace/`, so Claude cannot modify them: `firewall-baseline.txt` (the project-curated allowlist; the mount overrides the image-baked copy so baseline updates take effect without a rebuild) and `firewall-extras.txt` (host-managed additions). A third allowlist source, the `OAS_ALLOWED_DOMAINS` env var, carries plugin-supplied entries at container start. The three sources are additive, with no override semantics; `init-firewall.sh --list-sources` reports each entry's origin as `[baseline]`, `[plugin]`, or `[file]` (extras).
- `workspace/` is Claude's domain. It is mounted rw at `/workspace/`. Claude edits files. Changes appear as unstaged modifications on the host. The human reviews and commits via normal git on a feature branch.
- `plugin/` is the Obsidian plugin. It's how you invoke the sandbox from inside Obsidian. Changes here are unrelated to sandbox state. Plugin-internal architecture and conventions live in [`plugin/CLAUDE.md`](../../plugin/CLAUDE.md).

## The three tiers

Capabilities, settings, and agents live in one of three tiers. Choose the tier based on who benefits and how the change should propagate.

**Tier 1, repo-managed (`workspace/`)**
Shared capabilities. Lives in git. Changes flow via PR like any other code. Examples: project skills you want every user of the sandbox to inherit, MCP server declarations, permission defaults, vault-specific methodology (CLAUDE.md conventions).

**Tier 2, user-persistent (named volumes mounted under `/home/claude/`)**
Personal session state that survives container rebuilds but is not committed. Three named volumes back this tier:

- `oas-claude-config` at `/home/claude/.claude/`: Claude Code authentication, per-user preferences, drafts, session history, personal skills you haven't decided to share yet.
- `oas-user-config` at `/home/claude/.config/`: auth and config for other CLI tools. `gh` OAuth token (`~/.config/gh/hosts.yml`), git global config (via `GIT_CONFIG_GLOBAL=~/.config/git/config`, which `gh auth setup-git` honours), npm user config (via `NPM_CONFIG_USERCONFIG=~/.config/npm/npmrc`), atuin config seed, and any future XDG-compliant tool. Narrow on purpose: mounting `/home/claude/` wholesale would shadow image-baked binaries (nvm, native `claude`, python) and trap users on the initial image versions forever.
- `oas-shell-history` at `/home/claude/.shell-history/`: atuin's local-only history database. Separate from the atuin config above so backing up history doesn't drag in OAuth tokens.

Writes to any of these are safe: they don't affect other users or the image. Caveat: `gh` on Linux without `dbus`/`gnome-keyring` stores its OAuth token plaintext in `~/.config/gh/hosts.yml`. Same risk profile as Claude Code's creds in `oas-claude-config`; treat the host-side volume backups accordingly, and `gh auth logout` revokes if the volume is compromised.

**Tier 3, local overrides (`workspace/.claude/settings.local.json`)**
Per-machine tweaks that override Tier 1 without polluting the shared config. Gitignored. Examples: a developer-specific API key, a local-only MCP server URL that points to your own machine.

**Promotion path**: something useful starts in Tier 2 or Tier 3. When you want to share it, promote it to Tier 1 by committing the corresponding file under `workspace/` and opening a PR.

## Where do common things go?

| Thing | Tier | Path |
|-------|------|------|
| Default permission mode (e.g. `bypassPermissions`) | 1 | `workspace/.claude/settings.json` |
| MCP server declaration | 1 | `workspace/.mcp.json` |
| Claude Code authentication | 2 | `/home/claude/.claude/` (named volume `oas-claude-config`) |
| `gh` / `git` / `npm` auth state | 2 | `/home/claude/.config/` (named volume `oas-user-config`) |
| Project skill (shared across users) | 1 | `workspace/.claude/skills/<name>/SKILL.md` |
| Personal-only skill draft | 2 | `/home/claude/.claude/skills/<name>/` |
| API key override (per-machine) | 3 | `workspace/.claude/settings.local.json` |
| Private MCP server URL (per-machine) | 3 | `workspace/.claude/settings.local.json` |
| Obsidian-vault methodology / conventions | 1 | `workspace/CLAUDE.md` or vault's own `CLAUDE.md` |

## Obsidian-specific clarifications

- **Claude skills for vaults** live in `workspace/.claude/skills/`. Claude running inside the sandbox invokes them, and they can read the mounted vault. They are NOT Obsidian plugins.
- **Obsidian plugins** are the `.obsidian/plugins/` kind: JavaScript code running inside Obsidian itself. This repo contains one (the Agent Sandbox plugin under `plugin/`). Obsidian plugins are out of scope for Tier 1/2/3: they live in the vault's `.obsidian/plugins/` folder.
- **Skills that depend on specific Obsidian plugins** (e.g. a skill that reads Dataview query output) are still Tier 1 workspace content, but they should gracefully fall back when the plugin isn't installed.

## Why `container/` is not mounted inside

Three reasons:

1. **Stricter isolation.** If Claude cannot see the Dockerfile, it cannot propose changes that would require a rebuild mid-session. It cannot hide issues by editing the build context.
2. **Simpler mental model.** "workspace/ = safe to modify, container/ = requires rebuild and PR" is a single rule. Mixing them in one mount forces per-file reasoning.
3. **`verify.sh` is sufficient for runtime introspection.** Claude can discover everything it needs about the environment (tool versions, mount points, privilege state, env vars) by running `verify.sh`. The script is baked into the image at `/usr/local/bin/verify.sh`, so it is available regardless of mount state.

## Git workflow

Claude running inside the container **cannot run git**: no `.git` is visible at or above `/workspace/`. All commits to the monorepo happen on the host. The human edits or asks Claude to edit files, reviews with `git diff workspace/`, and commits on a feature branch. See the "Development" section in `README.md` for the trust model and the branch-protection rule for infra changes.

This is intentional: it means "don't commit directly to main" is enforced by construction rather than by hook configuration. Branch protection on the GitHub side is recommended as belt-and-braces.
