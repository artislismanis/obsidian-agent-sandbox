import type { App, TFile } from "obsidian";
import { z } from "zod/v4";
import { isPathWithinDir } from "../validation";
import {
	applyTemplaterFolderTemplate,
	assertTemplateDidNotRelocate,
	previewTemplaterFolderTemplate,
	withTemplaterHookSuppressed,
} from "../templater-adapter";
import { errMsg } from "../logger";
import type {
	ToolBuildContext,
	ToolPusher,
	McpToolDef,
	McpToolResult,
	PermissionTier,
	ReviewFn,
	WriteOperation,
} from "./core";
import {
	defineTool,
	text,
	error,
	coercedBoolean,
	requireFileOrPath,
	assertUnchangedDuringReview,
	validateNewVaultPath,
	isSafeFrontmatterProperty,
	normalizeFrontmatterValue,
	resolveFile,
} from "./core";
import { createSharedHelpers } from "./shared-helpers";

// vault.createFolder throws if any ancestor is absent - walk the tree so
// agents can write into brand-new nested paths in one shot.
async function ensureParentFolder(app: App, filePath: string): Promise<void> {
	const parentPath = filePath.split("/").slice(0, -1).join("/");
	if (!parentPath) return;
	if (app.vault.getAbstractFileByPath(parentPath)) return;
	await ensureParentFolder(app, parentPath);
	await app.vault.createFolder(parentPath);
}

/** Registers the writeScoped / writeReviewed / writeVault tool triplet
 *  (vault_create, vault_modify, vault_append, vault_frontmatter_set,
 *  vault_frontmatter_delete, vault_search_replace, vault_prepend,
 *  vault_patch × 3 tiers = 24 tools, 8 fewer when writeReviewed is absent). */
export function registerWriteTools(ctx: ToolBuildContext, push: ToolPusher): void {
	const { app, getWriteDir, pathFilter, review: reviewFn } = ctx;
	const { frontmatterSnapshot } = createSharedHelpers(ctx);
	const tools: McpToolDef[] = [];

	/**
	 * Review-gate + apply + success wrapper shared by all 8 write handlers.
	 * Handler code is reduced to: resolve the file, compute the change, pass
	 * the diff preview here.
	 */
	async function runWrite(op: {
		operation: WriteOperation;
		filePath: string;
		oldContent?: string;
		newContent?: string;
		description: string;
		review: ReviewFn | undefined;
		/** Optional context to splice into successMsg via the `{result}` placeholder. */
		apply: () => Promise<string | void>;
		/** `{result}` is replaced by the apply()'s returned string when present. */
		successMsg: string;
		affectedLinks?: string[];
		/** When set together with `oldContent` and a review, after approval the
		 *  file is re-read and the write is aborted if the contents changed
		 *  out from under the modal. Compare-and-swap against editor edits that
		 *  raced the review. Without this, the user could approve a stale diff
		 *  and the apply would clobber the change. */
		recheckFile?: TFile;
		/** Override the CAS comparison target when `oldContent` is a derived
		 *  representation (e.g. JSON-stringified frontmatter) rather than the
		 *  raw file contents. When omitted, recheck falls back to `oldContent`. */
		recheckExpected?: string;
	}): Promise<McpToolResult> {
		if (op.review) {
			const result = await op.review({
				operation: op.operation,
				filePath: op.filePath,
				oldContent: op.oldContent,
				newContent: op.newContent,
				description: op.description,
				affectedLinks: op.affectedLinks,
			});
			if (!result.approved) return error("Change rejected by user.");
			const expected = op.recheckExpected ?? op.oldContent;
			if (op.recheckFile && expected !== undefined) {
				const conflict = await assertUnchangedDuringReview(
					app,
					op.recheckFile,
					expected,
					op.filePath,
				);
				if (conflict) return error(conflict);
			}
		}
		// Catch apply errors and return them as clean tool errors. Propagating
		// throws bubbles apply() rejections (e.g. template-application-failed
		// from vault_create) out of runWrite, so tests calling handlers
		// directly see an exception instead of a result with isError. The MCP
		// server runtime also wraps throws, but mirroring gateVaultWrite's
		// structure keeps both paths returning well-formed McpToolResult.
		try {
			const applyResult = await op.apply();
			const msg = op.successMsg.replace("{result}", applyResult ?? "");
			return text(msg);
		} catch (e) {
			return error(errMsg(e));
		}
	}

	interface WriteToolConfig {
		tier: PermissionTier;
		suffix: string;
		scopeLabel: string;
		/** Sentence appended to every write-tool description. Gives the model an upfront signal
		 * about where the tool can operate, so it does not discover scope failures only by trial. */
		scopeNote: string;
		guardPath: (path: string) => McpToolResult | null;
		resolveForWrite: (
			args: Record<string, unknown>,
		) => { ok: true; file: TFile } | { ok: false; error: McpToolResult };
		review?: ReviewFn;
	}

	function addWriteTools(cfg: WriteToolConfig): void {
		const { tier, suffix, scopeLabel, scopeNote, guardPath, resolveForWrite, review } = cfg;
		const note = ` ${scopeNote}`;
		tools.push(
			defineTool({
				name: `vault_create${suffix}`,
				tier,
				title: `Create file${scopeLabel}`,
				description: `Create a new file${scopeLabel}. Intermediate parent folders are created automatically. Paths whose final component starts with '.' (dotfiles) are rejected.${note}`,
				inputSchema: {
					path: z.string().describe("Path from vault root"),
					content: z.string().optional().describe("Initial content (default empty)"),
				},

				handler: async ({ path, content: contentArg }) => {
					// Order matters and is integration-test-locked: shape +
					// pathFilter + symlink checks come first so `../escape.md`
					// surfaces the precise "may not contain a '..'" error rather
					// than the broader writeDir-gate error (an early shape
					// rejection is more actionable for agents). The writeDir
					// gate then fires as a second layer for shape-valid paths
					// outside the scoped write directory. See
					// test/integration/mcp-integration.test.ts "first layer" /
					// "second layer" cases.
					const pathError = validateNewVaultPath(app, path, pathFilter);
					if (pathError) return pathError;
					const guard = guardPath(path);
					if (guard) return guard;
					if (app.vault.getFileByPath(path))
						return error("File already exists. Use vault_modify to update it.");
					const content = contentArg ?? "";
					// Only auto-apply the folder template when the caller
					// didn't supply content; otherwise it would silently
					// clobber the agent's intended payload.
					const tryTemplate = content === "" && path.endsWith(".md");
					// Render the template body for the review modal so shown ==
					// written. The raw template (placeholders intact) is shown
					// because rendering them requires the file to exist, and the
					// review gate must happen before file creation.
					let previewContent = content;
					if (review && tryTemplate) {
						const tmplBody = await previewTemplaterFolderTemplate(app, path);
						if (tmplBody !== null) previewContent = tmplBody;
					}
					return runWrite({
						operation: "create",
						filePath: path,
						newContent: previewContent,
						description: `Create new file: ${path}`,
						review,
						apply: () =>
							withTemplaterHookSuppressed(app, async () => {
								await ensureParentFolder(app, path);
								const created = await app.vault.create(path, content);
								// Capture the path before Templater runs - when a
								// template calls `tp.file.move(...)`, Obsidian mutates
								// `created.path` in place. Comparing against the
								// snapshot detects the escape.
								const expectedPath = created.path;
								if (!tryTemplate) return "";
								const result = await applyTemplaterFolderTemplate(app, created);
								// Folder-template tp.file.move escape: a malicious
								// template in Templater's templates folder can relocate
								// the file outside the gated destPath. vault_create
								// reviewed/approved the body on the assumption it lands
								// at `path`; if it landed elsewhere, trash and surface.
								// Mirrors the post-validate in vault_templater_create.
								await assertTemplateDidNotRelocate(
									app,
									created,
									expectedPath,
									"file",
								);
								if (result.ok) return ` (applied template ${result.template})`;
								if (result.reason === "failed") {
									// File was created but the reviewed template body
									// failed to land. Surface as a hard error so the
									// agent and user know the on-disk state doesn't
									// match what was approved.
									throw new Error(
										`File created but template application failed: ${result.error}. The file is empty; the reviewed template body did NOT land.`,
									);
								}
								return "";
							}),
						successMsg: `Created ${path}{result}`,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_modify${suffix}`,
				tier,
				title: `Modify file${scopeLabel}`,
				description: `Replace the full contents of a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("New file content"),
				},
				refine: requireFileOrPath,
				handler: async ({ file, path, content }) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					return runWrite({
						operation: "modify",
						filePath: f.path,
						oldContent: review ? await app.vault.read(f) : undefined,
						newContent: content,
						description: `Modify file: ${f.path}`,
						review,
						apply: () => app.vault.modify(f, content),
						successMsg: `Modified ${f.path}`,
						recheckFile: f,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_append${suffix}`,
				tier,
				title: `Append to file${scopeLabel}`,
				description: `Append content to the end of a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("Content to append"),
				},
				refine: requireFileOrPath,
				handler: async ({ file, path, content: addition }) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const oldContent = review ? await app.vault.read(f) : undefined;
					return runWrite({
						operation: "append",
						filePath: f.path,
						oldContent,
						newContent:
							oldContent === undefined ? undefined : oldContent + "\n" + addition,
						description: `Append to ${f.path}`,
						review,
						apply: () => app.vault.append(f, "\n" + addition),
						successMsg: `Appended to ${f.path}`,
						recheckFile: f,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_frontmatter_set${suffix}`,
				tier,
				title: `Set frontmatter${scopeLabel}`,
				description: `Set a YAML frontmatter property on a file${scopeLabel}. Pass \`append: true\` to merge elements into an existing array rather than replacing it; if the current value is not an array it is wrapped in one first. Leading \`#\` is stripped from tag values automatically - pass \`"tag"\` or \`"#tag"\` interchangeably. JSON-encoded string arrays (e.g. \`'["a","b"]'\`) are coerced to real arrays.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					property: z.string().describe("Property name"),
					value: z
						.unknown()
						.describe("Property value - string, number, boolean, array, or object"),
					append: coercedBoolean()
						.optional()
						.describe(
							"Add to existing array instead of replacing it (default false). When the current value is not an array it is wrapped in one first.",
						),
				},
				refine: requireFileOrPath,
				handler: async ({ file, path, property, value, append = false }) => {
					if (!isSafeFrontmatterProperty(property))
						return error(
							`Property name '${property}' is not allowed (reserved or invalid).`,
						);
					const normalizedValue = normalizeFrontmatterValue(property, value);
					// Merges `normalizedValue` into `existing` when append mode is on.
					// null/undefined existing → just set; scalar existing → wrap in array first.
					const mergeAppend = (existing: unknown): unknown => {
						if (!append || existing == null) return normalizedValue;
						const base = Array.isArray(existing) ? existing : [existing];
						const additions = Array.isArray(normalizedValue)
							? normalizedValue
							: [normalizedValue];
						return [...base, ...additions.filter((v) => !base.includes(v))];
					};
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const oldFm = frontmatterSnapshot(f);
					// Capture full file content for CAS recheck - frontmatter alone
					// isn't enough because editor edits could change body content
					// between the review and apply, and processFrontMatter only
					// touches the YAML block, but the user reviewed the whole file
					// implicitly. Use full-content CAS for symmetry with modify/
					// append/etc.
					const oldFullContent = review ? await app.vault.read(f) : undefined;
					return runWrite({
						operation: "frontmatter_set",
						filePath: f.path,
						oldContent: JSON.stringify(oldFm, null, 2),
						newContent: JSON.stringify(
							{ ...oldFm, [property]: mergeAppend(oldFm[property]) },
							null,
							2,
						),
						description: `Set frontmatter '${property}' on ${f.path}`,
						review,
						apply: () =>
							app.fileManager.processFrontMatter(f, (fm) => {
								fm[property] = mergeAppend(fm[property]);
							}),
						successMsg: `Set ${property} on ${f.path}`,
						// Recheck full content so external edits during a long
						// review abort the FM mutation cleanly instead of racing.
						// recheckExpected overrides the comparison target since
						// oldContent above is the FM-only JSON snapshot.
						recheckFile: oldFullContent !== undefined ? f : undefined,
						recheckExpected: oldFullContent,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_frontmatter_delete${suffix}`,
				tier,
				title: `Delete frontmatter property${scopeLabel}`,
				description: `Remove a YAML frontmatter property from a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					property: z.string().describe("Property name to delete"),
				},
				refine: requireFileOrPath,
				handler: async ({ file, path, property }) => {
					if (!isSafeFrontmatterProperty(property))
						return error(
							`Property name '${property}' is not allowed (reserved or invalid).`,
						);
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const oldFm = frontmatterSnapshot(f);
					if (!Object.prototype.hasOwnProperty.call(oldFm, property))
						return error(`Property '${property}' not found in frontmatter.`);
					const { [property]: _dropped, ...newFm } = oldFm;
					// CAS recheck against editor edits during long reviews -
					// mirrors vault_frontmatter_set above. Otherwise an
					// approved delete races silently against the user's
					// concurrent FM edits.
					const oldFullContent = review ? await app.vault.read(f) : undefined;
					return runWrite({
						operation: "frontmatter_delete",
						filePath: f.path,
						oldContent: JSON.stringify(oldFm, null, 2),
						newContent: JSON.stringify(newFm, null, 2),
						description: `Delete frontmatter '${property}' from ${f.path}`,
						review,
						apply: () =>
							app.fileManager.processFrontMatter(f, (fm) => {
								delete fm[property];
							}),
						successMsg: `Deleted ${property} from ${f.path}`,
						recheckFile: oldFullContent !== undefined ? f : undefined,
						recheckExpected: oldFullContent,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_search_replace${suffix}`,
				tier,
				title: `Search and replace${scopeLabel}`,
				description: `Find and replace text within a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					search: z.string().describe("Text or regex pattern to find"),
					replace: z.string().describe("Replacement text"),
					regex: coercedBoolean()
						.optional()
						.describe("Treat search as regex (default false)"),
					caseSensitive: coercedBoolean()
						.optional()
						.describe("Case-sensitive match (default true)"),
				},
				refine: requireFileOrPath,
				handler: async ({
					file,
					path,
					search,
					replace: replacement,
					regex: useRegex = false,
					caseSensitive = true,
				}) => {
					// Reject empty / whitespace-only search. An empty literal
					// search escapes to "" → `new RegExp("", "g")` matches the
					// zero-width position between every character. With a 5 MiB
					// content cap, a 1 KiB `replacement` would amplify to
					// ~5 GiB on disk via app.vault.modify. Reject up-front.
					if (search.length === 0)
						return error(
							"'search' must be a non-empty pattern. Use vault_modify to replace whole file contents.",
						);
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const content = await app.vault.read(f);

					// Hard length budget: even without nested quantifiers, a
					// linear-but-large regex on multi-MB content blocks the
					// event loop for seconds - past the MCP tool timeout (which
					// only fires after replace returns), freezing Obsidian's UI
					// thread. 5 MiB is generous for any sane vault note (the
					// largest markdown file in a typical vault is well under
					// 1 MiB) and bounds replace() time to ~100ms even under
					// adversarial regex shapes that don't trip the nested-
					// quantifier guard below.
					const REPLACE_MAX_CONTENT_BYTES = 5 * 1024 * 1024;
					if (content.length > REPLACE_MAX_CONTENT_BYTES) {
						return error(
							`File too large for search/replace (${content.length} chars > ${REPLACE_MAX_CONTENT_BYTES}). Edit a smaller portion or split the file.`,
						);
					}

					let pattern: RegExp;
					if (useRegex) {
						// Reject patterns with nested quantifiers - classic ReDoS
						// shape (e.g. `(a+)+`, `(a*)*`). String.replace runs
						// synchronously and blocks the event loop past the MCP
						// tool timeout (which only fires after replace returns),
						// freezing Obsidian's UI thread.
						if (/(\([^)]*[+*][^)]*\))[+*]/.test(search)) {
							return error(
								"Refusing regex with nested quantifiers (ReDoS risk). Rewrite without `(…+)+` or `(…*)*`.",
							);
						}
						try {
							pattern = new RegExp(search, caseSensitive ? "g" : "gi");
						} catch (e) {
							return error(`Invalid regex: ${errMsg(e)}`);
						}
					} else {
						const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
						pattern = new RegExp(escaped, caseSensitive ? "g" : "gi");
					}

					let count = 0;
					const updated = content.replace(pattern, (...matchArgs) => {
						count++;
						// Honour `$$` (literal `$`) and `$N` only in regex mode. In literal
						// mode the user's pattern has no groups, so `$N` should pass
						// through unchanged.
						if (!useRegex) return replacement;
						const groups = matchArgs.slice(0, -2); // strip offset + full string
						const wholeMatch = String(groups[0] ?? "");
						const groupCount = groups.length - 1;
						return replacement.replace(
							// Match $$ | $& | $` | $' | $1..$99. Mirrors String.replace's
							// own grammar so authors don't get surprised by `$10` being
							// silently treated as group 10 when only one capture exists.
							/\$(\$|&|`|'|\d{1,2})/g,
							(token, sym) => {
								if (sym === "$") return "$";
								if (sym === "&") return wholeMatch;
								const matchOffset = matchArgs[matchArgs.length - 2] as number;
								if (sym === "`") return content.slice(0, matchOffset);
								if (sym === "'")
									return content.slice(matchOffset + wholeMatch.length);
								// Numeric backref. If $NN exceeds the group count and a
								// single-digit prefix would be a valid backref, fall back
								// to the single-digit form + literal next digit (matches
								// String.replace behaviour).
								const idx = parseInt(sym, 10);
								if (idx > groupCount && sym.length === 2) {
									const singleIdx = parseInt(sym[0], 10);
									if (singleIdx >= 1 && singleIdx <= groupCount) {
										const grp = groups[singleIdx];
										return (typeof grp === "string" ? grp : "") + sym[1];
									}
									// No valid group at either length - pass through.
									return token;
								}
								if (idx < 1 || idx > groupCount) return token;
								const grp = groups[idx];
								return typeof grp === "string" ? grp : "";
							},
						);
					});
					if (count === 0) return error("No matches found.");
					return runWrite({
						operation: "search_replace",
						filePath: f.path,
						oldContent: content,
						newContent: updated,
						description: `Replace ${count} occurrence(s) in ${f.path}`,
						review,
						apply: () => app.vault.modify(f, updated),
						successMsg: `Replaced ${count} occurrence(s) in ${f.path}`,
						recheckFile: f,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_prepend${suffix}`,
				tier,
				title: `Prepend to file${scopeLabel}`,
				description: `Insert content at the top of a file${scopeLabel}, after frontmatter if present.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("Content to prepend"),
				},
				refine: requireFileOrPath,
				handler: async ({ file, path, content }) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const existing = await app.vault.read(f);
					const cache = app.metadataCache.getFileCache(f);
					const fmEnd = cache?.frontmatterPosition?.end;
					// Use Obsidian's authoritative byte offset, then advance past any
					// trailing newline so the inserted content starts on its own line.
					// The line-sum approach this replaces overcounted by 1 when the
					// file had no trailing newline after frontmatter.
					let insertPos = 0;
					if (fmEnd) {
						insertPos = Math.min(fmEnd.offset, existing.length);
						// Skip past any trailing newline (handles `\n` and CRLF `\r\n`).
						while (existing[insertPos] === "\r" || existing[insertPos] === "\n")
							insertPos++;
					}
					const before = existing.slice(0, insertPos);
					const after = existing.slice(insertPos);
					const sep = insertPos > 0 && !before.endsWith("\n") ? "\n" : "";
					const updated = before + sep + content + "\n" + after;
					return runWrite({
						operation: "prepend",
						filePath: f.path,
						oldContent: existing,
						newContent: updated,
						description: `Prepend to ${f.path}`,
						review,
						apply: () => app.vault.modify(f, updated),
						successMsg: `Prepended to ${f.path}`,
						recheckFile: f,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_patch${suffix}`,
				tier,
				title: `Patch file${scopeLabel}`,
				description: `Insert or replace content at a specific location in a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("Content to insert"),
					heading: z
						.string()
						.optional()
						.describe("Target heading text (e.g. '## Details')"),
					line: z.coerce.number().optional().describe("Target line number (1-based)"),
					position: z
						.enum(["before", "after", "replace", "start_of_block", "end_of_block"])
						.optional()
						.describe(
							"Where to insert relative to target (default 'after').\n" +
								"With a heading target: 'before' inserts before the heading line; " +
								"'start_of_block' inserts immediately after the heading line (before the section body); " +
								"'end_of_block' inserts at the end of the section; " +
								"'after' is an alias for 'end_of_block'.\n" +
								"With a line target: 'before', 'after', 'replace' are supported; " +
								"'start_of_block' and 'end_of_block' are not valid for line targets.",
						),
				},
				refine: requireFileOrPath,
				handler: async ({
					file,
					path,
					content: insertContent,
					heading: headingArg,
					line: lineArg,
					position = "after",
				}) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const existing = await app.vault.read(f);
					const lines = existing.split("\n");

					if (!headingArg && lineArg === undefined)
						return error("Provide either 'heading' or 'line' target.");
					if (headingArg && position === "replace")
						return error(
							"position='replace' is not valid for heading targets. Use a line target for replace.",
						);

					if (headingArg) {
						const cache = app.metadataCache.getFileCache(f);
						const headings = cache?.headings ?? [];
						const match = headings.find(
							(h) => h.heading === headingArg.replace(/^#+\s*/, ""),
						);
						if (!match) return error(`Heading '${headingArg}' not found.`);
						const headingLine = match.position.start.line;
						const matchLevel = match.level;
						const matchIdx = headings.indexOf(match);
						const next = headings
							.slice(matchIdx + 1)
							.find((h) => h.level <= matchLevel);
						const endLine = next ? next.position.start.line : lines.length;

						let insertAt: number;
						let posLabel: string;
						if (position === "before") {
							insertAt = headingLine;
							posLabel = "before";
						} else if (position === "start_of_block") {
							insertAt = headingLine + 1;
							posLabel = "start of block after";
						} else {
							// 'after' | 'end_of_block' | default
							insertAt = endLine;
							posLabel = "end of block after";
						}
						const updated = [
							...lines.slice(0, insertAt),
							insertContent,
							...lines.slice(insertAt),
						].join("\n");
						return runWrite({
							operation: "patch",
							filePath: f.path,
							oldContent: existing,
							newContent: updated,
							description: `Patch ${f.path} at ${posLabel} heading '${headingArg}'`,
							review,
							apply: () => app.vault.modify(f, updated),
							successMsg: `Patched ${f.path} at ${posLabel} heading '${headingArg}'`,
							recheckFile: f,
						});
					}

					if (position === "start_of_block" || position === "end_of_block")
						return error(
							`position='${position}' is only valid with a heading target. Use a line target with 'before', 'after', or 'replace'.`,
						);

					const targetLine = lineArg! - 1;
					// `replace` requires the line to actually exist; before/after
					// can target the position past the last line for appending.
					const upper = position === "replace" ? lines.length - 1 : lines.length;
					if (targetLine < 0 || targetLine > upper)
						return error(`Line ${lineArg} is out of range (1-${upper + 1}).`);

					if (position === "before") {
						lines.splice(targetLine, 0, insertContent);
					} else if (position === "replace") {
						lines.splice(targetLine, 1, insertContent);
					} else {
						lines.splice(targetLine + 1, 0, insertContent);
					}
					const updated = lines.join("\n");
					return runWrite({
						operation: "patch",
						filePath: f.path,
						oldContent: existing,
						newContent: updated,
						description: `Patch ${f.path} at line ${targetLine + 1}`,
						review,
						apply: () => app.vault.modify(f, updated),
						successMsg: `Patched ${f.path} at line ${targetLine + 1}`,
						recheckFile: f,
					});
				},
			}),
		);
	}

	const resolveAnywhere = (
		args: Record<string, unknown>,
	): { ok: true; file: TFile } | { ok: false; error: McpToolResult } => {
		const f = resolveFile(app, args, pathFilter);
		return f ? { ok: true, file: f } : { ok: false, error: error("File not found.") };
	};

	const guardWithinWriteDir = (path: string): McpToolResult | null => {
		const writeDir = getWriteDir();
		return isPathWithinDir(path, writeDir)
			? null
			: error(`Path must be within the write directory '${writeDir}'.`);
	};
	addWriteTools({
		tier: "writeScoped",
		suffix: "",
		scopeLabel: " (within write directory)",
		scopeNote: `Restricted to the configured write directory - paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.`,
		guardPath: guardWithinWriteDir,
		resolveForWrite: (args) => {
			// Gate on the resolved TFile.path, not the caller-supplied args.
			// When the caller passes `file:` (wikilink-style basename) without
			// `path:`, resolveFile walks the whole vault to find a match - so
			// gating on `args.path` alone left a writeScoped tool free to write
			// any file in the vault by basename. Check the resolved path here.
			const f = resolveFile(app, args, pathFilter);
			if (!f) return { ok: false, error: error("File not found.") };
			const guard = guardWithinWriteDir(f.path);
			if (guard) return { ok: false, error: guard };
			return { ok: true, file: f };
		},
	});

	if (reviewFn) {
		addWriteTools({
			tier: "writeReviewed",
			suffix: "_reviewed",
			scopeLabel: " (reviewed)",
			scopeNote:
				"Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.",
			guardPath: () => null,
			resolveForWrite: resolveAnywhere,
			review: reviewFn,
		});
	}

	addWriteTools({
		tier: "writeVault",
		suffix: "_anywhere",
		scopeLabel: " (vault-wide)",
		scopeNote:
			"Unrestricted - writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.",
		guardPath: () => null,
		resolveForWrite: resolveAnywhere,
	});

	for (const tool of tools) push(tool);
}
