# CLAUDE.md — Agent Sandbox

Monorepo containing an Obsidian plugin and its paired containerized sandbox for working with Obsidian vaults using AI coding agents.

## Quick reference

| Component | Path | Build/Check |
|-----------|------|-------------|
| Obsidian plugin | `plugin/` | `cd plugin && npm install && npm run check` |
| Sandbox container | `sandbox/` | `cd sandbox && docker compose build` |

## Structure

```
plugin/     Obsidian plugin (TypeScript, xterm.js, esbuild)
sandbox/    Containerized agent sandbox (Ubuntu 24.04, ttyd, Claude Code CLI, MCP servers)
docs/       Manual testing checklist
```

See `plugin/CLAUDE.md` for plugin architecture, patterns, and conventions.
See `sandbox/CLAUDE.md` for container environment and safety constraints.
See `docs/TESTING.md` for the full manual testing checklist.
