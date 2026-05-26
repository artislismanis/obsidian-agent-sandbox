# Vault-wide write notifications

**Status:** proposed
**Affects:** `plugin/src/settings.ts`, `plugin/src/activity.ts`, `plugin/src/main.ts`
**New files:** none

---

## Problem

The "Notify on agent output" setting (`agentOutputNotify`, `plugin/src/settings.ts:60`) fires an in-app `Notice` when files are created or modified. Today it is gated to `vaultWriteDir` (`plugin/src/activity.ts:172,179`) — writes anywhere else in the vault are silently ignored. This misses writes made via MCP tools running in the `writeReviewed`/`writeVault` tiers, and any time the agent reorganises files across folders.

Two additional coverage gaps surfaced:
- `vault.on('delete')` and `vault.on('rename')` are not subscribed (`plugin/src/main.ts:352-360`), so destructive operations produce no notification at all.
- `vault_move` (`plugin/src/mcp-tools.ts:2027`) emits a `rename` event, not `create`+`modify`, so moves are invisible end-to-end even within the write dir.

The current `"new" | "new_or_modified" | "off"` enum also bakes in which combinations of event kinds are valid; there is no way to get "create + delete but not modify".

### Non-problem: "basic writes vs MCP writes"

The three write paths (shell Write/Edit, MCP `obsidian`, MCP `memory`) all surface as the same `app.vault.on(...)` events. There is one observer and one filter; the filter is the lever.

## Proposed changes

### `plugin/src/settings.ts`

Replace `agentOutputNotify: "new" | "new_or_modified" | "off"` with an object of four independent boolean toggles:

```ts
agentOutputNotify: {
    create: boolean;   // default true
    modify: boolean;   // default false  (avoids modify-spam; matches today's "new" default)
    delete: boolean;   // default true
    rename: boolean;   // default true
};
agentOutputNotifyScope: "writeDir" | "vaultWide";  // default "writeDir"
```

**Migration in `loadSettings`** when the stored value is the legacy string enum — map and write back so the key disappears on next save:

| Legacy value | Migrated to |
|---|---|
| `"off"` | `{ create: false, modify: false, delete: false, rename: false }` |
| `"new"` | `{ create: true, modify: false, delete: true, rename: true }` |
| `"new_or_modified"` | `{ create: true, modify: true, delete: true, rename: true }` |

**UI in `renderGeneral`**: replace the single dropdown with four `addToggle` rows under a "Notify on agent output" heading ("On file creation", "On file modification", "On file deletion", "On file rename"), then the scope dropdown immediately below:
- "Write directory only (default)"
- "Vault-wide"

Scope description: *"Whether notifications fire only for writes inside the configured vault write directory, or for any vault file. Use 'Vault-wide' if you want visibility into MCP writes outside the workspace (e.g. via reviewed/anywhere tiers)."*

### `plugin/src/activity.ts`

- `AgentOutputNotifier` constructor adds getters for the events object and the scope alongside the existing `vaultWriteDir` getter.
- Rename `pathInsideWriteDir` → `shouldNotifyForPath`. Returns `true` unconditionally when scope is `"vaultWide"`; otherwise delegates to `isPathWithinDir(path, this.getWriteDir())` — preserving the fail-closed behaviour for empty `writeDir`.
- Extend the buffer entry kind union to `"created" | "modified" | "deleted" | "renamed"`.
- Per-event gating — each handler checks its own bool. Drop the mode-enum dispatch.
  - `onCreate(path)` — `if (!this.getEvents().create) return;`
  - `onModify(path)` — `if (!this.getEvents().modify) return;`
  - `onDelete(path)` — `if (!this.getEvents().delete) return;`
  - `onRename(newPath, oldPath)` — `if (!this.getEvents().rename) return;` (use `newPath` for `shouldNotifyForPath`)
- Relabel notices: `"Vault write: created foo.md"` (single event) and `"Vault writes: 2 created, 1 deleted"` (aggregate). Drop the "Agent ..." prefix — in `vaultWide` mode the same events fire for human edits made directly in the Obsidian UI, so the label would be wrong.

### `plugin/src/main.ts`

Wire the new getters into the `AgentOutputNotifier` constructor (line ~123). After the existing `create`/`modify` subscriptions (line ~360), register:

```ts
this.registerEvent(
    this.app.vault.on("delete", (file) => this.agentOutput.onDelete(file.path)),
);
this.registerEvent(
    this.app.vault.on("rename", (file, oldPath) =>
        this.agentOutput.onRename(file.path, oldPath),
    ),
);
```

### What is NOT changing

`vaultWriteDir` continues to be the FS bind-mount sandbox boundary (the container's read-only overlay of the rest of the vault is unaffected). This change only decouples its role as a notification-gating predicate.

## Tests

Unit (Vitest) — extend `plugin/test/activity.test.ts` (or equivalent, verify location during impl):

- `vaultWide` scope fires for paths outside `vaultWriteDir`; `writeDir` scope still suppresses them.
- Each event toggle is independently honored — e.g. `{ create: true, modify: false, delete: true, rename: true }` fires for create/delete/rename, not modify.
- All four flags false → notifier is silent.
- `onDelete` and `onRename` flow through the debounce + rate-limit pipeline.
- Migration from each of the three legacy enum values maps to the correct object.

## Verification

1. Set scope to `vaultWide`, all four event toggles on. From inside the vault (e.g. Obsidian UI), create, modify, delete, and rename a file outside the write dir. Observe four notices with "Vault write: ..." text.
2. Turn the "modify" toggle off. Edit a file. No notice; the other three kinds still fire.
3. Set scope to `writeDir` with all toggles on. Repeat step 1 outside the write dir — zero notices. Repeat inside the write dir — four notices.
4. Trigger `vault_move` via the MCP server (e.g. `vault_move_anywhere`) to move a file across folders. With scope `vaultWide` and the rename toggle on, observe "Vault write: renamed ..." notice.
5. Load a vault with a legacy `agentOutputNotify: "new"` value in `data.json`. Open Settings. Confirm the four toggles match the migrated state `{create: true, modify: false, delete: true, rename: true}`.

## Sequencing

Single PR. Relabel, new event subscriptions, and scope setting are all bundled — they are a coherent UX change and share the same test surface. No companion follow-up issues.

Standalone follow-ups explicitly out of scope:
- Provenance tracking (distinguishing agent vs human writes)
- Per-folder allow/deny rules
- Status-bar variant of notifications
