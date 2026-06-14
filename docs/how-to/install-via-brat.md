# How to install via BRAT

The plugin is distributed via tagged GitHub Releases. You can install it through Obsidian's [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) without cloning the repo.

## One-time BRAT setup

1. Obsidian → **Settings → Community plugins** → **Browse** → install **BRAT**.
2. Enable BRAT.

## Install this plugin via BRAT

1. Command palette → **BRAT: Add a beta plugin for testing**.
2. Paste: `https://github.com/artislismanis/obsidian-agent-sandbox` (or whatever the repo URL is).
3. BRAT downloads the latest GitHub Release assets (`main.js`, `manifest.json`, `styles.css`) into `<vault>/.obsidian/plugins/agent-sandbox/`.
4. **Settings → Community plugins** → enable **Agent Sandbox**.

## Updates

BRAT checks for new releases on Obsidian start. To force an immediate check: **BRAT: Check for updates to beta plugins**.

To pin to a specific version: **BRAT: Switch a beta plugin to a different version**.

## The plugin drives the container — you need both

This plugin is not a standalone tool. It exists to run the containerised agent
workflow inside Obsidian: starting/stopping the sandbox, wiring terminals to it,
and exposing the vault to the agent over MCP. Installing the plugin via BRAT
gives you the Obsidian-side controls; the agent itself runs in the container,
which you build once from this repo. You need both halves:
- Docker running on the host.
- This repo cloned, so `cd container && docker compose build` can produce `oas-sandbox:latest`.
- The **Docker Compose path** setting in the plugin pointed at the cloned `container/` directory.

See `tutorials/getting-started.md` for the full first-run flow.
