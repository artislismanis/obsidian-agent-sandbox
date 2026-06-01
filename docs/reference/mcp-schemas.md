# MCP Tool Schema Reference

> Generated from `buildTools()` in `plugin/src/mcp-tools.ts`. Do not edit by hand - run `npm run docs:gen` (or `UPDATE_SCHEMAS=1 npm run test`) to regenerate.

Canonical reference for every MCP tool the plugin exposes: parameter names, types, and descriptions. Test scripts, skills, and docs that mention a tool's params should copy from here rather than from memory.

## Tools by tier

- [read](#read) - `vault_backlinks`, `vault_context`, `vault_file_info`, `vault_frontmatter`, `vault_graph_clusters`, `vault_graph_neighborhood`, `vault_graph_path`, `vault_headings`, `vault_links`, `vault_list`, `vault_orphans`, `vault_properties`, `vault_read`, `vault_recent`, `vault_search`, `vault_search_fuzzy`, `vault_suggest_links`, `vault_tags`, `vault_unresolved`
- [writeScoped](#writescoped) - `vault_append`, `vault_create`, `vault_frontmatter_delete`, `vault_frontmatter_set`, `vault_modify`, `vault_patch`, `vault_prepend`, `vault_search_replace`
- [writeReviewed](#writereviewed) - `vault_append_reviewed`, `vault_create_reviewed`, `vault_frontmatter_delete_reviewed`, `vault_frontmatter_set_reviewed`, `vault_modify_reviewed`, `vault_patch_reviewed`, `vault_prepend_reviewed`, `vault_search_replace_reviewed`
- [writeVault](#writevault) - `vault_append_anywhere`, `vault_create_anywhere`, `vault_frontmatter_delete_anywhere`, `vault_frontmatter_set_anywhere`, `vault_modify_anywhere`, `vault_patch_anywhere`, `vault_prepend_anywhere`, `vault_search_replace_anywhere`
- [navigate](#navigate) - `vault_open`
- [manage](#manage) - `vault_batch_frontmatter`, `vault_create_folder`, `vault_delete`, `vault_move`, `vault_rename`
- [extensions](#extensions) - `plugin_extensions_list`, `vault_canvas_modify`, `vault_canvas_read`, `vault_dataview_query`, `vault_periodic_note`, `vault_tasks_query`, `vault_tasks_toggle`, `vault_templater_create`
- [agent](#agent) - `agent_status_set`, `agent_time`

## read

### `vault_backlinks`

**Title:** Backlinks

List files that link to a given file.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |

### `vault_context`

**Title:** File context

Get a file's full context in one call: content, frontmatter, tags, headings, outgoing links, and backlinks.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |

### `vault_file_info`

**Title:** File info

Get metadata about a file (path, name, size, dates).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |

### `vault_frontmatter`

**Title:** Read frontmatter

Read YAML frontmatter properties from a file.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `property` | `string` | no | Specific property to read |

### `vault_graph_clusters`

**Title:** Graph clusters

Find groups of densely connected notes.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `minSize` | `number` | no | Min cluster size (default 3) |
| `maxClusters` | `number` | no | Max clusters to return (default 10) |

### `vault_graph_neighborhood`

**Title:** Graph neighborhood

Find all notes within N link-hops of a file.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `depth` | `number` | no | Max hops (1-5, default 1) |

### `vault_graph_path`

**Title:** Graph path

Find the shortest link path between two notes.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | `string` | yes | Source file path |
| `target` | `string` | yes | Target file path |

### `vault_headings`

**Title:** Headings

List headings from a file as an outline.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |

### `vault_links`

**Title:** Outgoing links

List outgoing links from a file.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |

### `vault_list`

**Title:** List files

List files in the vault. Optionally filter by folder or extension.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `folder` | `string` | no | Filter by folder path (alias: path) |
| `path` | `string` | no | Alias for folder |
| `extension` | `string` | no | Filter by extension (e.g. md, json) |

### `vault_orphans`

**Title:** Orphan notes

List markdown files with no incoming links from other files.

_No parameters._

### `vault_properties`

**Title:** Vault properties

List all frontmatter property names across the vault with usage counts, or distinct values for a specific property.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `property` | `string` | no | Property name to get distinct values for |

### `vault_read`

**Title:** Read file

Read the contents of a file in the vault.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name (wikilink-style resolution) |
| `path` | `string` | no | Exact path from vault root |

### `vault_recent`

**Title:** Recently modified files

List recently modified files sorted by modification time.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `limit` | `number` | no | Max results (default 20) |
| `folder` | `string` | no | Filter by folder path |
| `extension` | `string` | no | Filter by extension |

### `vault_search`

**Title:** Search vault

Search for text across all markdown files in the vault. Returns matching file paths with context.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | yes | Search query text |
| `limit` | `number` | no | Max results (default 20) |

### `vault_search_fuzzy`

**Title:** Fuzzy search vault

Fuzzy full-text search across all markdown files - matches note content, not file names. Tolerates typos and approximate matches. Results are score-sorted.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | yes | Search query text (fuzzy matched) |
| `limit` | `number` | no | Max results (default 20) |

### `vault_suggest_links`

**Title:** Suggest links

Find notes that could be linked from a file based on content overlap. Excludes already-linked notes.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `limit` | `number` | no | Max suggestions (default 10) |

### `vault_tags`

**Title:** List tags

List all tags in the vault with occurrence counts, or tags for a specific file when `file` or `path` is supplied.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name (wikilink-style). Omit (together with `path`) for vault-wide listing. |
| `path` | `string` | no | Exact path from vault root. Omit (together with `file`) for vault-wide listing. |

### `vault_unresolved`

**Title:** Unresolved links

List broken wikilinks that don't resolve to any file.

_No parameters._

## writeScoped

### `vault_append`

**Title:** Append to file (within write directory)

Append content to the end of a file (within write directory). Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to append |

### `vault_create`

**Title:** Create file (within write directory)

Create a new file (within write directory). Intermediate parent folders are created automatically. Paths whose final component starts with '.' (dotfiles) are rejected. Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | Path from vault root |
| `content` | `string` | no | Initial content (default empty) |

### `vault_frontmatter_delete`

**Title:** Delete frontmatter property (within write directory)

Remove a YAML frontmatter property from a file (within write directory). Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `property` | `string` | yes | Property name to delete |

### `vault_frontmatter_set`

**Title:** Set frontmatter (within write directory)

Set a YAML frontmatter property on a file (within write directory). Pass `append: true` to merge elements into an existing array rather than replacing it; if the current value is not an array it is wrapped in one first. Leading `#` is stripped from tag values automatically - pass `"tag"` or `"#tag"` interchangeably. JSON-encoded string arrays (e.g. `'["a","b"]'`) are coerced to real arrays. Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `property` | `string` | yes | Property name |
| `value` | `any` | yes | Property value - string, number, boolean, array, or object |
| `append` | `boolean` | no | Add to existing array instead of replacing it (default false). When the current value is not an array it is wrapped in one first. |

### `vault_modify`

**Title:** Modify file (within write directory)

Replace the full contents of a file (within write directory). Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | New file content |

### `vault_patch`

**Title:** Patch file (within write directory)

Insert or replace content at a specific location in a file (within write directory). Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to insert |
| `heading` | `string` | no | Target heading text (e.g. '## Details') |
| `line` | `number` | no | Target line number (1-based) |
| `position` | `"before" \| "after" \| "replace" \| "start_of_block" \| "end_of_block"` | no | Where to insert relative to target (default 'after'). With a heading target: 'before' inserts before the heading line; 'start_of_block' inserts immediately after the heading line (before the section body); 'end_of_block' inserts at the end of the section; 'after' is an alias for 'end_of_block'. With a line target: 'before', 'after', 'replace' are supported; 'start_of_block' and 'end_of_block' are not valid for line targets. |

### `vault_prepend`

**Title:** Prepend to file (within write directory)

Insert content at the top of a file (within write directory), after frontmatter if present. Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to prepend |

### `vault_search_replace`

**Title:** Search and replace (within write directory)

Find and replace text within a file (within write directory). Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `search` | `string` | yes | Text or regex pattern to find |
| `replace` | `string` | yes | Replacement text |
| `regex` | `boolean` | no | Treat search as regex (default false) |
| `caseSensitive` | `boolean` | no | Case-sensitive match (default true) |

## writeReviewed

### `vault_append_reviewed`

**Title:** Append to file (reviewed)

Append content to the end of a file (reviewed). Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to append |

### `vault_create_reviewed`

**Title:** Create file (reviewed)

Create a new file (reviewed). Intermediate parent folders are created automatically. Paths whose final component starts with '.' (dotfiles) are rejected. Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | Path from vault root |
| `content` | `string` | no | Initial content (default empty) |

### `vault_frontmatter_delete_reviewed`

**Title:** Delete frontmatter property (reviewed)

Remove a YAML frontmatter property from a file (reviewed). Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `property` | `string` | yes | Property name to delete |

### `vault_frontmatter_set_reviewed`

**Title:** Set frontmatter (reviewed)

Set a YAML frontmatter property on a file (reviewed). Pass `append: true` to merge elements into an existing array rather than replacing it; if the current value is not an array it is wrapped in one first. Leading `#` is stripped from tag values automatically - pass `"tag"` or `"#tag"` interchangeably. JSON-encoded string arrays (e.g. `'["a","b"]'`) are coerced to real arrays. Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `property` | `string` | yes | Property name |
| `value` | `any` | yes | Property value - string, number, boolean, array, or object |
| `append` | `boolean` | no | Add to existing array instead of replacing it (default false). When the current value is not an array it is wrapped in one first. |

### `vault_modify_reviewed`

**Title:** Modify file (reviewed)

Replace the full contents of a file (reviewed). Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | New file content |

### `vault_patch_reviewed`

**Title:** Patch file (reviewed)

Insert or replace content at a specific location in a file (reviewed). Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to insert |
| `heading` | `string` | no | Target heading text (e.g. '## Details') |
| `line` | `number` | no | Target line number (1-based) |
| `position` | `"before" \| "after" \| "replace" \| "start_of_block" \| "end_of_block"` | no | Where to insert relative to target (default 'after'). With a heading target: 'before' inserts before the heading line; 'start_of_block' inserts immediately after the heading line (before the section body); 'end_of_block' inserts at the end of the section; 'after' is an alias for 'end_of_block'. With a line target: 'before', 'after', 'replace' are supported; 'start_of_block' and 'end_of_block' are not valid for line targets. |

### `vault_prepend_reviewed`

**Title:** Prepend to file (reviewed)

Insert content at the top of a file (reviewed), after frontmatter if present. Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to prepend |

### `vault_search_replace_reviewed`

**Title:** Search and replace (reviewed)

Find and replace text within a file (reviewed). Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `search` | `string` | yes | Text or regex pattern to find |
| `replace` | `string` | yes | Replacement text |
| `regex` | `boolean` | no | Treat search as regex (default false) |
| `caseSensitive` | `boolean` | no | Case-sensitive match (default true) |

## writeVault

### `vault_append_anywhere`

**Title:** Append to file (vault-wide)

Append content to the end of a file (vault-wide). Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to append |

### `vault_create_anywhere`

**Title:** Create file (vault-wide)

Create a new file (vault-wide). Intermediate parent folders are created automatically. Paths whose final component starts with '.' (dotfiles) are rejected. Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | Path from vault root |
| `content` | `string` | no | Initial content (default empty) |

### `vault_frontmatter_delete_anywhere`

**Title:** Delete frontmatter property (vault-wide)

Remove a YAML frontmatter property from a file (vault-wide). Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `property` | `string` | yes | Property name to delete |

### `vault_frontmatter_set_anywhere`

**Title:** Set frontmatter (vault-wide)

Set a YAML frontmatter property on a file (vault-wide). Pass `append: true` to merge elements into an existing array rather than replacing it; if the current value is not an array it is wrapped in one first. Leading `#` is stripped from tag values automatically - pass `"tag"` or `"#tag"` interchangeably. JSON-encoded string arrays (e.g. `'["a","b"]'`) are coerced to real arrays. Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `property` | `string` | yes | Property name |
| `value` | `any` | yes | Property value - string, number, boolean, array, or object |
| `append` | `boolean` | no | Add to existing array instead of replacing it (default false). When the current value is not an array it is wrapped in one first. |

### `vault_modify_anywhere`

**Title:** Modify file (vault-wide)

Replace the full contents of a file (vault-wide). Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | New file content |

### `vault_patch_anywhere`

**Title:** Patch file (vault-wide)

Insert or replace content at a specific location in a file (vault-wide). Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to insert |
| `heading` | `string` | no | Target heading text (e.g. '## Details') |
| `line` | `number` | no | Target line number (1-based) |
| `position` | `"before" \| "after" \| "replace" \| "start_of_block" \| "end_of_block"` | no | Where to insert relative to target (default 'after'). With a heading target: 'before' inserts before the heading line; 'start_of_block' inserts immediately after the heading line (before the section body); 'end_of_block' inserts at the end of the section; 'after' is an alias for 'end_of_block'. With a line target: 'before', 'after', 'replace' are supported; 'start_of_block' and 'end_of_block' are not valid for line targets. |

### `vault_prepend_anywhere`

**Title:** Prepend to file (vault-wide)

Insert content at the top of a file (vault-wide), after frontmatter if present. Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `content` | `string` | yes | Content to prepend |

### `vault_search_replace_anywhere`

**Title:** Search and replace (vault-wide)

Find and replace text within a file (vault-wide). Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `search` | `string` | yes | Text or regex pattern to find |
| `replace` | `string` | yes | Replacement text |
| `regex` | `boolean` | no | Treat search as regex (default false) |
| `caseSensitive` | `boolean` | no | Case-sensitive match (default true) |

## navigate

### `vault_open`

**Title:** Open file

Open a file in the Obsidian editor. Affects the user's UI.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `newTab` | `boolean` | no | Open in a new tab |

## manage

### `vault_batch_frontmatter`

**Title:** Batch frontmatter update

Set or delete a frontmatter property across files matching a folder prefix and/or a content search query. At least one of `folder` or `query` is required. Use dryRun to preview changes.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | no | Full-text content search to match files. Optional when `folder` is supplied. |
| `folder` | `string` | no | Vault path prefix to restrict matches. Optional when `query` is supplied. |
| `property` | `string` | yes | Frontmatter property name |
| `value` | `any` | no | Value to set - string, number, boolean, array, or object. Omit to delete. |
| `dryRun` | `boolean` | no | Preview only, no changes (default true) |

### `vault_create_folder`

**Title:** Create folder

Create a new folder in the vault. No-op if the folder already exists; errors if a file already occupies the path.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | Folder path from vault root |

### `vault_delete`

**Title:** Delete file or folder

Move a file or folder to trash. Folder deletion is recursive - children are trashed with the parent.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name (files only) |
| `path` | `string` | no | Exact path from vault root (file or folder) |

### `vault_move`

**Title:** Move file

Move a file to a different folder. Automatically updates all wikilinks.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `to` | `string` | yes | Destination folder path |

### `vault_rename`

**Title:** Rename file

Rename a file. Automatically updates all wikilinks across the vault.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | `string` | no | File name |
| `path` | `string` | no | Exact path from vault root |
| `name` | `string` | yes | New file name (extension preserved if omitted) |

## extensions

### `plugin_extensions_list`

**Title:** List enabled extensions

Report which plugin integrations the MCP server has registered tools for (Canvas, Dataview, Tasks, Templater, Periodic Notes). Useful when an agent is unsure whether a target plugin is available.

_No parameters._

### `vault_canvas_modify`

**Title:** Modify canvas

Apply changes to a .canvas file. Supports adding or removing nodes and edges. The `changes` parameter must be a JSON-encoded STRING (not a plain object) - e.g. `{"addNodes":[{"id":"1","type":"text","x":0,"y":0}]}`. Set `create: true` to materialise the canvas (with the requested nodes/edges) when it doesn't yet exist.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | Canvas file path from vault root |
| `changes` | `string` | yes | JSON-encoded string: { addNodes?: CanvasNode[]; removeNodeIds?: string[]; addEdges?: CanvasEdge[]; removeEdgeIds?: string[] }. Must be a string, not an object. |
| `create` | `boolean` | no | Create the canvas if it doesn't exist, seeded with the requested changes (default false). |

### `vault_canvas_read`

**Title:** Read canvas

Read a .canvas file and return its JSON structure: nodes (text/file/link/group) and edges. Works without any target plugin - `.canvas` is Obsidian's native format.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | Canvas file path from vault root (.canvas extension) |

### `vault_dataview_query`

**Title:** Dataview query

Run a Dataview Query Language (DQL) query against the vault. Requires the Dataview plugin to be installed and enabled. Returns the serialized result.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | `string` | yes | Full DQL source (e.g. 'TABLE rating FROM #book SORT rating DESC') |

### `vault_periodic_note`

**Title:** Periodic note access

Locate (and optionally create) a periodic note - daily/weekly/monthly/quarterly/yearly. Requires the Periodic Notes plugin. Returns the file path; if `create` is true and the note doesn't exist, an empty file is created in the plugin-configured folder.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `periodicity` | `"daily" \| "weekly" \| "monthly" \| "quarterly" \| "yearly"` | no | Which periodic note to resolve (default: daily) |
| `date` | `string` | no | ISO date (YYYY-MM-DD). Defaults to today. |
| `create` | `boolean` | no | Create if missing (default false) |

### `vault_tasks_query`

**Title:** Query tasks

Scan markdown files for Tasks-format checklist items and filter by status / due date / priority / tag. Requires the Tasks plugin to be installed and enabled.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `"open" \| "done" \| "any"` | no | Filter by status (default: open) |
| `tag` | `string` | no | Filter by a #tag (case-sensitive) |
| `dueOnOrBefore` | `string` | no | ISO date (YYYY-MM-DD). Keep only tasks due on or before this date. |
| `priorityAtLeast` | `"lowest" \| "low" \| "medium" \| "high" \| "highest"` | no | Keep only tasks with this priority or higher |
| `folder` | `string` | no | Restrict scan to a folder prefix |
| `limit` | `number` | no | Max results (default 100) |

### `vault_tasks_toggle`

**Title:** Toggle task

Toggle a checklist item between done and open at a specific file:line. Delegates to the Tasks plugin's apiV1.executeToggleTaskDoneCommand so it applies the plugin's full done-handling (recurring tasks, done-date, etc).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | File path from vault root |
| `line` | `number` | yes | 1-based line number of the task |

### `vault_templater_create`

**Title:** Create from Templater template

Create a new note from a Templater template. Requires the Templater plugin. The template path is resolved by Templater itself (it respects the plugin's configured templates folder).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `template` | `string` | yes | Template path (e.g. 'Templates/daily.md') |
| `folder` | `string` | no | Destination folder (default: vault root) |
| `filename` | `string` | no | Output filename without extension |

## agent

### `agent_status_set`

**Title:** Set agent activity status

Report the current agent lifecycle state so the plugin can show which sessions are working, awaiting input, or idle. Call on transitions (e.g. at the start of a long tool call, when a user prompt is needed, when you're done).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `"idle" \| "working" \| "awaiting_input"` | yes | Current agent state |
| `sessionName` | `string` | no | Session routing key. When running inside the Obsidian Agent Sandbox, omit this — the proxy stamps the correct key automatically. Max 128 chars. |
| `detail` | `string` | no | Short human-readable context (e.g. tool name, question). Max 1024 chars. |

### `agent_time`

**Title:** Host clock

Return the current date/time as seen by the Obsidian host process (not the container). Date-sensitive tools (e.g. vault_periodic_note) resolve relative dates using this host clock. Call this when you need to know the host date or detect the UTC offset between container and host - if they differ, pass an explicit `date` param derived from `localIso` rather than relying on your own clock.

_No parameters._

