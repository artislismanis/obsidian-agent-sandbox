# Agent Sandbox

An Obsidian plugin and containerized sandbox for working with Obsidian vaults using AI coding agents. Start/stop the sandbox, monitor status, and open multiple independent embedded terminals — all without leaving your vault.

## How it works

```
Obsidian (Windows / Linux / Mac)
  └── Plugin
        ├── Shell commands → docker compose up/down (via WSL or local)
        ├── xterm.js → ttyd WebSocket (port 7681) inside container
        └── Status bar showing container state

Sandbox Container
  ├── ttyd (web terminal on port 7681)
  ├── bash login shell per connection
  ├── Claude Code CLI + MCP servers (memory)
  └── /workspace/vault (read-only mount, writable subfolder)
```

Each terminal tab in Obsidian gets its own independent bash session — run multiple agent instances in parallel.

## Features

**Plugin:**
- **Container management** — Start, stop, restart, and check status via the command palette
- **Status bar** — Shows container state (stopped/starting/running/error)
- **Multiple terminals** — Each tab gets an independent session in the main editor area
- **Terminal theming** — Follow Obsidian theme, or force dark/light
- **Clipboard** — Auto-copy on select, `Ctrl+Shift+V` to paste
- **Auto-lifecycle** — Optionally start/stop the container with plugin load/unload
- **Vault path injection** — Auto-detects vault path and passes it to Docker
- **Docker mode** — WSL (Windows) or Local (Linux/Mac/native Docker)

**Container:**
- **Web terminal** — ttyd accessible at `http://localhost:7681`
- **Read-only vault** — Vault mounted read-only; agents can only write to a designated folder (`agent-workspace/` by default)
- **Claude Code CLI** — Pre-installed and ready to use
- **Memory MCP** — `@modelcontextprotocol/server-memory` preinstalled, memory file stored in the vault write directory
- **Dev tools** — Node 22, Python 3.12, ripgrep, fd, git-delta, fzf, jq, gh
- **Network sandboxing** — Optional allowlist-based firewall

## Security

- **Read-only vault** — mounted read-only; only the write directory is writable
- **Read-only source** — container tooling at /workspace is read-only
- **Localhost-only terminal** — ttyd binds to 127.0.0.1 by default
- **Firewall toggle** — enable/disable allowlist-based outbound firewall from the status bar (shield icon) or command palette. Auto-enable on start via Advanced settings. Restricts traffic to: Anthropic, npm, GitHub, PyPI, CDNs. Configure `ALLOWED_PRIVATE_HOSTS` for local services (NAS, etc.)
- **No remote access by default** — ttyd only accepts local connections
- **Resource limits** — memory and CPU capped by default (configurable)

> **WSL2 note:** Docker inside WSL2 is also limited by `.wslconfig` memory settings.
> Ensure WSL2 allocation >= container memory limit.

## Prerequisites

- **Docker Engine** installed (inside WSL2 on Windows, or natively on Linux/Mac)
- On Windows: **WSL2 mirrored networking** — add to `%USERPROFILE%\.wslconfig`:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  Then restart WSL: `wsl --shutdown`
- **Claude Code subscription** authenticated

## Quick start

### 1. Clone the repo

```bash
git clone https://github.com/artislismanis/obsidian-agent-sandbox.git
cd obsidian-agent-sandbox/sandbox
```

### 2. Build the container

```bash
docker compose build
```

> **Important:** Start the container from the Obsidian plugin (step 4), not from the command line. The plugin passes required environment variables (`PKM_VAULT_PATH`, `PKM_WRITE_DIR`, etc.) automatically. Running `docker compose up -d` manually without a configured `.env` file will result in missing vault mounts and unexpected behaviour.

### 3. Build and install the plugin

```bash
cd ../plugin
npm install
npm run build
```

Copy the contents of `plugin/dist/` to your vault's `.obsidian/plugins/obsidian-agent-sandbox/` directory:
```bash
mkdir -p /path/to/vault/.obsidian/plugins/obsidian-agent-sandbox
cp dist/* /path/to/vault/.obsidian/plugins/obsidian-agent-sandbox/
```

### 4. Configure and use

1. Restart Obsidian and enable **Agent Sandbox** in Settings > Community Plugins
2. Set **Docker mode** (WSL or Local)
3. Set **Docker Compose path** to the path of the `sandbox/` directory
4. Open the command palette (`Ctrl+P`) and run **Sandbox: Start Container**
5. Click the terminal icon in the ribbon or run **Open Sandbox Terminal**

## Terminal keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| **Copy** | Select text with mouse — auto-copied to clipboard |
| **Copy word** | Right-click a word |
| **Paste** | `Ctrl+Shift+V` |
| **Interrupt (SIGINT)** | `Ctrl+C` |
| **Scroll** | Mouse wheel (10000 lines of scrollback) |

## Commands

| Command | Description |
|---------|-------------|
| **Open Sandbox Terminal** | Open a new terminal tab in the main editor area |
| **Sandbox: Start Container** | Run `docker compose up -d` |
| **Sandbox: Stop Container** | Run `docker compose down` |
| **Sandbox: Container Status** | Show `docker compose ps` output |
| **Sandbox: Restart Container** | Run `docker compose restart` |
| **Sandbox: Toggle Firewall** | Enable or disable the outbound firewall |

## Settings

Settings are organized into three tabs:

**General:**
| Setting | Default | Description |
|---------|---------|-------------|
| Docker mode | `WSL` | WSL (Windows) or Local (Linux/Mac/native Docker) |
| Docker Compose path | *(empty)* | Path to the directory containing docker-compose.yml |
| WSL distribution | `Ubuntu` | WSL distribution for Docker commands (WSL mode only) |
| Vault write directory | `agent-workspace` | Folder inside vault where the container can write files |
| Memory file name | `memory.json` | Filename for the memory MCP, stored in the write directory |
| Auto-start on load | `off` | Start container when plugin loads |
| Auto-stop on unload | `off` | Stop container when plugin is disabled |

**Terminal:**
| Setting | Default | Description |
|---------|---------|-------------|
| Port | `7681` | Host port mapped to ttyd |
| Bind address | `127.0.0.1` | IP address ttyd binds to (set 0.0.0.0 for network access) |
| Terminal theme | Follow Obsidian | Follow Obsidian theme, Dark, or Light |
| Terminal font | *(auto)* | Custom font family (falls back through common monospace fonts) |

**Advanced:**
| Setting | Default | Description |
|---------|---------|-------------|
| Memory limit | `8G` | Maximum container memory |
| CPU limit | `4` | Maximum container CPU cores |
| Auto-enable firewall | `off` | Enable outbound firewall on container start |
| Allowed private hosts | *(empty)* | Comma-separated IPs/CIDRs for firewall allowlist |

## Project structure

```
obsidian-agent-sandbox/
├── plugin/                          Obsidian plugin (TypeScript, xterm.js, esbuild)
│   ├── src/
│   │   ├── main.ts                  Plugin entry point, lifecycle, commands
│   │   ├── settings.ts              Settings interface and UI tab
│   │   ├── docker.ts                Container management via WSL or local Docker
│   │   ├── status-bar.ts            Status bar indicator
│   │   ├── terminal-view.ts         xterm.js terminal with ttyd WebSocket
│   │   ├── ttyd-client.ts           ttyd polling and URL construction
│   │   └── __tests__/               Vitest unit tests
│   ├── styles.css                   Plugin and xterm.js styles
│   ├── manifest.json                Obsidian plugin manifest
│   ├── esbuild.config.mjs           Bundle config (produces dist/)
│   ├── tsconfig.json                TypeScript config (strict mode)
│   ├── vitest.config.ts             Test runner config
│   ├── eslint.config.mjs            Linter config
│   └── package.json
│
├── sandbox/                         Agent sandbox container (Ubuntu 24.04, ttyd, Claude Code)
│   ├── Dockerfile                   Container image
│   ├── docker-compose.yml           Service, ports, volumes
│   ├── entrypoint.sh                Starts ttyd
│   ├── session.sh                   Starts a login bash per connection
│   ├── .env.example                 Environment template (optional with plugin)
│   ├── .claude/settings.json        Claude Code project settings
│   ├── .mcp.json                    MCP server configuration (memory)
│   └── scripts/
│       ├── verify.sh                Environment validation
│       └── init-firewall.sh         Network sandboxing setup
│
└── docs/
    └── TESTING.md                   Manual testing checklist
```

## Development

```bash
cd plugin
npm install
npm run dev          # Watch mode
npm run check        # Lint + format + typecheck + tests
npm run test         # Tests only
```

See `plugin/CLAUDE.md` for architecture details and conventions.

## License

MIT
