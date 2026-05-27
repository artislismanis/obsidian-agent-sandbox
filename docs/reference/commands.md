# Reference: commands

Every command registered by the plugin. Access via Obsidian's command palette (`Ctrl`/`Cmd` + `P`).

| Command | ID | What it does |
|---|---|---|
| Open Sandbox Terminal | `open-claude-terminal` | Opens a new terminal tab, or activates an existing one. Prompts to start the container if it's stopped. |
| Open Sandbox Session… | `open-session` | Prompts for a tmux session name, then opens a terminal attached to that session (creates it if new). |
| Open Sandbox in Browser | `open-browser` | Opens the ttyd URL in the system default browser. |
| Sandbox: Start Container | `sandbox-start-container` | `docker compose up -d`. Runs port-conflict pre-flight first. |
| Sandbox: Stop Container | `sandbox-stop-container` | `docker compose down`. |
| Sandbox: Restart Container | `sandbox-restart-container` | Explicit clean `down` + `up -d`. |
| Sandbox: Container Status | `sandbox-container-status` | Probe + show status notice. |
| Sandbox: Toggle Firewall | `sandbox-toggle-firewall` | Enable / disable the container's outbound firewall. |
| Sandbox: Toggle MCP Server | `sandbox-toggle-mcp` | Start / stop the in-plugin MCP HTTP server. |
| Sandbox: Clean up empty sessions | `sandbox-cleanup-sessions` | Lists unattached tmux sessions, confirmation modal, kills selected. |
| Sandbox: Switch to Sandbox session… | `sandbox-switch-session` | Modal picker over currently open terminal tabs. |
| Sandbox: Copy terminal connection log | `sandbox-copy-terminal-connection-log` | Copies the in-memory ring buffer of recent WS open/close/reconnect events to the clipboard. See [Troubleshoot terminal disconnects](../how-to/troubleshoot-terminal-disconnects.md). |

## Ribbon icon

The plugin registers a single ribbon icon (terminal glyph, left sidebar) labelled **Open Sandbox Terminal** that triggers the same action as the `open-claude-terminal` command.

## URI handlers

| URI | What it does |
|---|---|
| `obsidian://agent-sandbox/open-terminal` | Activate or open a terminal tab. |
| `obsidian://agent-sandbox/analyse?vault=<name>&path=<path>&template=<name>` | Open a terminal, start Claude Code, inject a templated prompt. `template` name matches a `.md` filename (without extension) in `<vault>/.oas/prompts/`. |

The `vault=` parameter is required when more than one vault is open — Obsidian uses it to route the URI to the correct vault's plugin. Use the exact vault name as shown in **Vault switcher** (or `Preferences → About`). Omitting `vault=` causes a "Vault Not Found" error if Obsidian cannot determine the target vault unambiguously.

Example:
```
obsidian://agent-sandbox/analyse?vault=My+Notes&path=projects/report.md&template=summarize
```

## Context-menu action

Right-click any vault file → **Analyse in Sandbox** → submenu listing prompt templates from `<vault>/.oas/prompts/`. Picks load the template, substitute `{{file}}` with the clicked note's path, open a terminal, and type `claude '<prompt>'`. When the templates directory is empty or absent, a single **Custom prompt…** modal fallback appears.

### Adding prompt templates

Create `.md` files in `<vault>/.oas/prompts/`. Each file must start with a label line followed by `---`, then the prompt body:

```
Summarize
---
Summarize @{{file}} in 3 concise bullet points.
```

The `{{file}}` placeholder is replaced with the vault-relative path of the right-clicked note. Template files ship as examples under `workspace/.claude/prompts/` — copy any you want into `<vault>/.oas/prompts/` to activate them.
