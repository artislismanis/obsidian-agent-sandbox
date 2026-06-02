# How to keep Claude sessions alive across Obsidian restarts

The container survives Obsidian restarts (unless **Auto-stop on exit** is on). Terminal tabs in Obsidian don't reattach on their own: they're WebSocket connections tied to the Obsidian process.

The workaround: **use named tmux sessions** so closing a tab doesn't kill your work.

## Named session workflow

1. **Sandbox: Open Session...** → enter a name (e.g. `work`, `research`, `debug`).
2. A terminal opens inside tmux session `work`. Inside it, run Claude Code or whatever you like.
3. Close the Obsidian tab. The tmux session keeps running.
4. Later, with Obsidian re-opened and the container still running, run **Sandbox: Open Session...** with the same name. You re-attach, Claude's context intact.

## Picking up multiple sessions

Click the status-bar sandbox pill to open its menu. Live tmux sessions are listed there: click one to attach. Or use **Sandbox: Switch to Sandbox session…** for a filterable picker.

## Cleanup

Unattached sessions pile up. **Sandbox: Clean up detached sessions** lists candidates with per-row checkboxes: kill the ones you don't want.

## Configuration

- Tmux sessions live in the container's runtime state (default socket under `/tmp/tmux-<uid>/`); the `oas-shell-history` volume keeps command history across container rebuilds.
- If the container restarts, tmux sessions are gone. That's the only way to lose them.
- No auto-GC is shipped: you decide when to clean up.

## Why not restore tabs automatically?

Obsidian persists view state across restarts, including terminal-tab session names. The plugin does not reattach for you. Reattach happens when you click, so you don't wake idle Claude Code instances after every restart. The "named session workflow" above is explicit by design.
