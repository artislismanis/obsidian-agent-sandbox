# Vault-write safety rules

Shared guardrails for every skill that writes to the vault outside `$OAS_VAULT_WRITE_DIR`: `reviewed-edit`, `note-refactor`, `link-hygiene`, `tag-audit`. Each of those skills states its own specific triggers and tool chain; this file is the one place the shared rules live, so they change in one place instead of drifting across four copies.

## Three write modes, one at a time

A single dropdown in the plugin's settings picks one of three write modes: `scoped`, `reviewed`, or `full`. They are mutually exclusive, so `reviewed` and `full` never both apply.

Writes to a path inside `$OAS_VAULT_WRITE_DIR` apply straight away in all three modes, with no modal. The mode decides what happens outside that directory:

| Mode | Extra content-write tools | Write outside `$OAS_VAULT_WRITE_DIR` |
|---|---|---|
| `scoped` | none | Blocked. The tool returns "Path '...' is outside the write directory". |
| `reviewed` | `_reviewed` variants | Diff modal per write. Nothing applies until the user approves. |
| `full` | `_anywhere` variants | Applies with no modal. |

The `manage` tier toggles on its own, independent of the write mode. Manage tools (`vault_rename`, `vault_move`, `vault_delete`, `vault_create_folder`, `vault_batch_frontmatter`) keep their plain names in every mode and obey the same table: blocked under `scoped`, modal under `reviewed`, silent apply under `full`.

`vault_batch_frontmatter` reviews at batch grain, not per call. Under `scoped` it refuses the whole batch when any match sits outside the write dir, naming the count. Under `reviewed` it shows one modal listing every match, the user picks which to keep, and a partial apply is the expected outcome. Run it with `dryRun` first, which is the default.

Call `mcp__obsidian__mcp_capabilities` to read the mode and the enabled tiers for this session. Toggles are per-vault and per-user, so never infer them from tool *name* presence alone.

See `../SKILL.md` for the full `_reviewed` tool-name mapping and the manage-tier table.

## Never delete without per-file confirmation

`vault_delete` sends the file to trash via `app.vault.trash`, so the user can restore the file itself. The link graph is what doesn't come back: every note that pointed at the target keeps a wikilink that no longer resolves, and you can't undo that from inside the session.

Get explicit per-file approval before any delete, even in a batch. A blanket "yes, delete all of these" up front stops counting as confirmation once you're three files into a batch the user hasn't seen.

## Print the plan before applying anything

Before the first write in a multi-step change, show the user the full plan (what will change, and why) and wait for approval. This applies in all three write modes: a review modal shows one diff at a time, not the overall shape of the change.

## One unit at a time when reviewing

In `reviewed` mode, apply a multi-file change one unit at a time rather than queuing every write before the user has seen the first modal. Each modal needs the context of "this is change N of M, here's why". Batching hides that context and turns review into a rubber-stamp exercise. Warn the user up front how many modals to expect.

A unit is one file by default. A skill can define a larger unit when the user reviews at that grain: `tag-audit` applies one variant cluster at a time, so each merge reads as one coherent diff set.
