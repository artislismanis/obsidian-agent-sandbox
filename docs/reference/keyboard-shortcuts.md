# Reference: keyboard shortcuts

The plugin ships without hotkey bindings. Obsidian's own hotkey system handles them. Assign your preferred keys via **Obsidian → Settings → Hotkeys** and filter for "Agent Sandbox" or "Sandbox:".

## Inside the terminal

| Shortcut | Action |
|---|---|
| `Ctrl` + `Shift` + `V` | Paste clipboard into terminal |
| Mouse-select text | Auto-copies to clipboard (if `clipboardAutoCopy` is on) |
| `Escape` | Sent to the shell as the ESC byte (intercepted from Obsidian's navigate-back) |
| `Ctrl` + `C` | If text is selected and `clipboardAutoCopy` is off: copies selection and clears it. Otherwise sent to the shell as SIGINT. |
| `Ctrl` + `D` | Sent through to the shell |
| Mouse-drag | Selects the on-screen text; auto-copies (if `clipboardAutoCopy` is on) |
| Mouse wheel | Scrolls the terminal scrollback in classic mode; in a full-screen TUI it scrolls that app |

## Mouse selection and full-screen TUIs

The terminal always keeps **native mouse selection of what's on screen**: drag to
select, and the selection auto-copies to your host clipboard (if
`clipboardAutoCopy` is on). This holds even when a full-screen TUI such as Claude
Code runs inside the terminal — which normally breaks it, because such apps
capture the mouse. The plugin **strips application mouse-tracking** here to keep
selection working.

The practical consequences:

- **Claude Code's own in-TUI mouse features** (clicking options, mouse-scrolling
  within its viewport) are inactive here — use the keyboard for those. Claude's
  flicker-free rendering and keyboard navigation are unaffected.
- **Scrolling and off-screen selection depend on the renderer.** A full-screen
  TUI draws on the terminal's *alternate screen*, which has no scrollback of its
  own: the mouse wheel scrolls *within the app* (Claude), and you can only
  select the text currently visible. Content Claude has scrolled past lives in
  Claude's own history — scroll it back into view (keyboard, or the wheel) before
  selecting. In classic mode (below), the wheel scrolls the terminal's scrollback
  and you can select the full history. Running a full-screen app inside a
  `session` (tmux) keeps it on the main screen, so terminal scrollback works there
  too.

If you would rather have Claude Code's native mouse behaviour back (at the cost of
this on-screen selection/copy), set `"tui": "default"` in
`workspace/.claude/settings.json` — see
[Troubleshooting terminal disconnects](../how-to/troubleshoot-terminal-disconnects.md#copy-paste-and-selection).

## Common suggested Obsidian bindings

Not shipped. Set these yourself if you use them often:

- **Sandbox: Open Terminal**: e.g. `Ctrl` + `` ` ``
- **Sandbox: Switch to Sandbox session…**: e.g. `Ctrl` + `Shift` + `S`
- **Sandbox: Toggle Firewall**: e.g. `Ctrl` + `Alt` + `F`
