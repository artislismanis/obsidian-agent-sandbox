# How to customise the workspace

`workspace/` on the host is mounted rw at `/workspace/` inside the container. It's Claude's configurable domain. Several directories inside are meant for customisation.

## `.claude/skills/`: project skills

Markdown files Claude reads when the invocation pattern matches. Shipped skills:

- `research-topic`: discovery chain
- `link-hygiene`: periodic link cleanup
- `reviewed-edit`: safe out-of-workspace writes
- `tag-audit`: consolidate tag variants
- `daily-review`: recent-activity digest
- `note-refactor`: safe rename/move/delete

Each skill is `workspace/.claude/skills/<name>/SKILL.md` with frontmatter `name` + `description`. Add your own:

```markdown
---
name: my-skill
description: One-sentence trigger phrasing. When the user asks X, do Y.
---

# my-skill

Explain what Claude should do and which tools to chain.
```

Restart Claude (or the whole container) to pick up new skills.

## `.claude/prompts/`: Analyse-in-Sandbox templates

Populated via `Right-click a note → Analyse in Sandbox → <template-name>`. Each template is:

```
Template Title
---
Prompt body with the @{{file}} placeholder.
```

The first non-empty line before `---` is the menu label. The body is passed to `claude` as its initial argument, with `{{file}}` replaced by the clicked note's path.

Shipped: `summarize`, `extract-todos`, `critique`, `explain`. Add your own; no restart needed. They're cached with a 30s background refresh, so new templates appear on the next right-click after that window.

## `.claude/hooks/`: Claude Code lifecycle hooks

Shell scripts called on events. Ships `notify-status.sh` (activity signalling). Hooks are wired in `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bash .claude/hooks/my-hook.sh" }] }]
  }
}
```

Events include `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `SessionStart`, `SessionEnd`. See Claude Code docs for the full list.

## `.claude/settings.json`: Claude Code config

Permission mode, env vars, status line, hooks. Changes apply on the next `claude` invocation.

## `.claude/agents/`, `.claude/commands/`

Subagent and slash-command definitions respectively. **Not shipped in this repo**: neither directory exists in `workspace/.claude/` by default. Create them yourself to define your own subagents or slash commands. Claude Code picks them up on next invocation.

## `.mcp.json`: MCP servers

Lists MCP servers Claude Code connects to. The Obsidian plugin's MCP server is pre-configured here.

## Promotion path

Changes here live in git (under `workspace/`), so they ship with the repo. Personal tweaks you don't want to commit: use `.claude/settings.local.json` (gitignored) or `git update-index --skip-worktree <file>`.

## Tiers recap

- **Tier 1, `workspace/`** (git): shared with everyone who clones.
- **Tier 2, `/home/claude/.claude/`** (named volume): personal config that survives container rebuilds; NOT in git.
- **Tier 3, `.claude/settings.local.json`** (gitignored): per-machine overrides of Tier 1 without polluting shared config.

Put new things in the right tier. See `workspace/CLAUDE.md` for the full rationale.
