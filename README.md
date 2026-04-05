# PKM Claude Terminal

An Obsidian plugin and Docker container for working with Obsidian vaults using Claude Code. Start/stop containers, monitor status, and open multiple independent embedded terminals — all without leaving your vault.

## How it works

```
Obsidian (Windows)
  └── Plugin
        ├── Shell commands → wsl -d <distro> → docker compose up/down
        ├── xterm.js → ttyd WebSocket (port 7681) inside container
        └── Status bar showing container state

Docker Container (WSL2)
  ├── ttyd (web terminal on port 7681)
  ├── tmux (independent session per connection)
  ├── Claude Code CLI
  └── /workspace/vault (bind-mounted Obsidian vault)
```

Each terminal tab in Obsidian gets its own independent tmux session — run multiple Claude Code instances in parallel.

## Features

**Plugin:**
- **Container management** — Start, stop, restart, and check status via the command palette
- **Status bar** — Shows container state (stopped/starting/running/error)
- **Multiple terminals** — Each tab gets an independent session, docked at the bottom
- **Terminal theming** — Follow Obsidian theme, or force dark/light
- **Clipboard** — Auto-copy on select, `Ctrl+Shift+V` to paste
- **Auto-lifecycle** — Optionally start/stop the container with plugin load/unload
- **Vault path injection** — Auto-detects vault path and passes it to Docker

**Container:**
- **Web terminal** — ttyd with tmux, accessible at `http://localhost:7681`
- **Claude Code CLI** — Pre-installed and ready to use
- **Dev tools** — Node 22, Python 3.12, ripgrep, fd, git-delta, atuin, fzf, jq, gh
- **Network sandboxing** — Optional allowlist-based firewall

## Prerequisites

- **Windows** with WSL2 installed
- **Docker Engine** installed inside WSL2 (not Docker Desktop on Windows)
- **WSL2 mirrored networking** — add to `%USERPROFILE%\.wslconfig`:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  Then restart WSL: `wsl --shutdown`
- **Claude Code subscription** authenticated

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/artislismanis/obsidian-claude-sandbox.git
cd obsidian-claude-sandbox/docker
cp .env.example .env
# Edit .env — set PKM_VAULT_PATH to your vault's WSL path
```

### 2. Build and start the container

```bash
cd docker
docker compose build
docker compose up -d
```

Verify: `docker compose ps` should show `pkm-sandbox` as healthy.

### 3. Build and install the plugin

```bash
cd plugin
npm install
npm run build
```

Copy the contents of `plugin/dist/` to your vault's `.obsidian/plugins/pkm-claude-terminal/` directory:
```bash
mkdir -p /path/to/vault/.obsidian/plugins/pkm-claude-terminal
cp dist/* /path/to/vault/.obsidian/plugins/pkm-claude-terminal/
```

### 4. Configure and use

1. Restart Obsidian and enable **PKM Claude Terminal** in Settings > Community Plugins
2. Set **Docker Compose file path** to the WSL path of the `docker/` directory
3. Set **WSL distro name** (default: `Ubuntu`)
4. Open the command palette (`Ctrl+P`) and run **PKM: Start Container**
5. Click the terminal icon in the ribbon or run **Open Claude Terminal**

## Terminal keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| **Copy** | Select text with mouse — auto-copied to clipboard |
| **Copy word** | Right-click a word |
| **Paste** | `Ctrl+Shift+V` |
| **Interrupt (SIGINT)** | `Ctrl+C` |

tmux keybindings work normally (e.g., `Ctrl+B` then `C` for new window).

> **Tip:** The container ships with `set -g mouse off` in tmux so text selection works with a simple click-drag — no need to hold Shift.

## Commands

| Command | Description |
|---------|-------------|
| **Open Claude Terminal** | Open a new terminal tab at the bottom |
| **PKM: Start Container** | Run `docker compose up -d` |
| **PKM: Stop Container** | Run `docker compose down` |
| **PKM: Container Status** | Show `docker compose ps` output |
| **PKM: Restart Container** | Run `docker compose restart` |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Docker Compose file path | *(empty)* | Absolute WSL path to the `docker/` directory |
| WSL distro name | `Ubuntu` | WSL distribution for Docker commands |
| ttyd port | `7681` | Port where ttyd listens |
| ttyd username | `user` | Username for ttyd basic auth |
| ttyd password | *(empty)* | Password for ttyd basic auth |
| Terminal theme | Follow Obsidian | Follow Obsidian theme, Dark, or Light |
| Auto-start on load | `off` | Start container when plugin loads |
| Auto-stop on unload | `off` | Stop container when plugin is disabled |

## Project structure

```
plugin/                      Obsidian plugin source
├── src/
│   ├── main.ts              Plugin entry point, lifecycle, commands
│   ├── settings.ts          Settings interface and UI tab
│   ├── docker.ts            Container management via WSL → Docker Compose
│   ├── status-bar.ts        Status bar indicator
│   ├── terminal-view.ts     xterm.js terminal with ttyd WebSocket
│   ├── ttyd-client.ts       ttyd polling, auth, URL construction
│   └── __tests__/           Vitest unit tests
├── dist/                    Build output (main.js, manifest.json, styles.css)
└── package.json

docker/                      Docker container configuration
├── Dockerfile               Container image (Ubuntu 24.04)
├── docker-compose.yml       Service configuration
├── entrypoint.sh            Creates unique tmux session per connection
├── .tmux.conf               tmux defaults (mouse off, 256color)
├── .env.example             Environment template
└── scripts/
    ├── verify.sh            Environment validation
    └── init-firewall.sh     Network sandboxing setup

docs/
└── TESTING.md               Manual testing checklist
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
