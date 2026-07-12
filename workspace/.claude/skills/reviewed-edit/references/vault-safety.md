# Vault-write safety rules

Shared guardrails for every skill that writes to the vault outside `$OAS_VAULT_WRITE_DIR`: `reviewed-edit`, `note-refactor`, `link-hygiene`, `tag-audit`. Each of those skills states its own specific triggers and tool chain; this file is the one place the shared rules live, so they change in one place instead of drifting across four copies.

## The `writeReviewed` tier

Out-of-workspace writes require the `writeReviewed` tier. When it's on, each write pops a diff modal in Obsidian and won't apply until the user approves. When it's off:

- Content-write tools (`vault_create_reviewed`, `vault_modify_reviewed`, etc.) aren't registered at all - the skill can only suggest changes, not apply them, unless the target is inside `$OAS_VAULT_WRITE_DIR`.
- Manage-tier tools (`vault_rename`, `vault_move`, `vault_delete`, `vault_create_folder`, `vault_batch_frontmatter`) still work if the `manage` tier is on, but apply without a review modal.

Call `mcp__obsidian__mcp_capabilities` to confirm which tiers are actually on for this session - tier toggles are per-vault and per-user, so never assume from tool *name* presence alone.

See `../SKILL.md` for the full `_reviewed` tool-name mapping and the manage-tier table.

## Never delete without per-file confirmation

Deleting a file (or a tag/link that effectively orphans one) is the one operation that isn't cleanly reversible from inside a session. Get explicit per-file approval before any delete, even in a batch operation - a blanket "yes, delete all of these" up front doesn't count as per-file confirmation once you're three files into a batch the user hasn't seen yet.

## Print the plan before applying anything

Before the first write in a multi-step change, show the user the full plan (what will change, and why) and wait for approval. This applies whether or not `writeReviewed` is on: a review modal shows one diff at a time, not the overall shape of the change.

## One file at a time when reviewing

If `writeReviewed` is on and you have multiple files to change, apply them one at a time rather than queuing every write before the user has seen the first modal. Each modal needs the context of "this is change N of M, here's why" - batching hides that context and turns review into a rubber-stamp exercise. Warn the user up front how many modals to expect.
