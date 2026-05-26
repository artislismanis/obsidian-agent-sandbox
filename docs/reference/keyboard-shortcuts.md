# Reference: keyboard shortcuts

The plugin doesn't ship with hotkey bindings — Obsidian's own hotkey system handles them. Assign your preferred keys via **Obsidian → Settings → Hotkeys** and filter for "Agent Sandbox" or "Sandbox:".

## Inside the terminal

| Shortcut | Action |
|---|---|
| `Ctrl` + `Shift` + `V` | Paste clipboard into terminal |
| Mouse-select text | Auto-copies to clipboard (if `clipboardAutoCopy` is on) |
| `Escape` | Sent to the shell as the ESC byte (intercepted from Obsidian's navigate-back) |
| `Ctrl` + `C` | If text is selected and `clipboardAutoCopy` is off: copies selection and clears it. Otherwise sent to the shell as SIGINT. |
| `Ctrl` + `D` | Sent through to the shell |

## Common suggested Obsidian bindings

Not shipped — set these yourself if you use them often:

- **Open Sandbox Terminal** — e.g. `Ctrl` + `` ` ``
- **Sandbox: Switch to Sandbox session…** — e.g. `Ctrl` + `Shift` + `S`
- **Sandbox: Toggle Firewall** — e.g. `Ctrl` + `Alt` + `F`
