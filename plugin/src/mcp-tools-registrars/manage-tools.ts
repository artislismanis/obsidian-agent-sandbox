import type { TFile } from "obsidian";
import { prepareSimpleSearch } from "obsidian";
import { z } from "zod/v4";
import { isPathWithinDir, pathHasParentSegment } from "../validation";
import { isVaultPathSafe } from "../obsidian-internals";
import type { ToolBuildContext, ToolPusher, WriteOperation } from "./core";
import {
	defineTool,
	text,
	error,
	requireFileOrPath,
	gateVaultWrite,
	validateNewVaultPath,
	isSafeFrontmatterProperty,
	normalizeFrontmatterValue,
	isPathAllowedByFilter,
	coercedBoolean,
	resolveFile,
} from "./core";
import { createSharedHelpers } from "./shared-helpers";

/** Registers the `manage` tier (vault_rename, vault_move, vault_delete,
 *  vault_create_folder, vault_batch_frontmatter) - everything that routes
 *  through gateVaultWrite rather than the writeScoped/Reviewed/Vault factory. */
export function registerManageTools(ctx: ToolBuildContext, push: ToolPusher): void {
	const {
		app,
		getWriteDir,
		pathFilter,
		enabledTiers,
		review: reviewFn,
		reviewBatch: reviewBatchFn,
	} = ctx;
	const { forEachMarkdown, collectBacklinks, frontmatterSnapshot } = createSharedHelpers(ctx);

	// ── Manage tier ───────────────────────────────────

	push(
		defineTool({
			name: "vault_rename",
			tier: "manage",
			title: "Rename file",
			description: "Rename a file. Automatically updates all wikilinks across the vault.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				name: z.string().describe("New file name (extension preserved if omitted)"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path, name: newName }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const trimmed = newName.trim();
				if (
					trimmed.length === 0 ||
					trimmed === "." ||
					trimmed === ".." ||
					trimmed.startsWith(".") ||
					trimmed.includes("/") ||
					trimmed.includes("\\") ||
					pathHasParentSegment(trimmed)
				)
					return error(
						"'name' must be a non-empty, non-hidden bare filename (no slashes, no leading dot, no '..').",
					);
				// Treat as already-extensioned only when the trailing suffix matches
				// the file's current extension EXACTLY (case-sensitive). Names like
				// `v1.2`, `Mr.Smith`, or `notes.tech` keep `.${f.extension}`
				// appended; explicit `name: "foo.md"` round-trips unchanged. The
				// Case-sensitive comparison is load-bearing on Linux: `foo.MD`
				// and `foo.md` are different files, so case-folding would
				// either silently change the casing during rename or treat an
				// intentional `.MD` as already-extensioned and skip the append.
				const hasTrailingExt = f.extension !== "" && trimmed.endsWith(`.${f.extension}`);
				const ext = hasTrailingExt ? "" : f.extension ? `.${f.extension}` : "";
				const dir = f.parent?.path ?? "";
				const newPath = dir ? `${dir}/${trimmed}${ext}` : `${trimmed}${ext}`;
				if (!isVaultPathSafe(app, newPath))
					return error("Destination resolves outside the vault.");
				if (!isPathAllowedByFilter(newPath, pathFilter))
					return error("Destination path is blocked by allow/block list.");
				if (newPath !== f.path && app.vault.getFileByPath(newPath))
					return error(`Destination already exists: ${newPath}`);
				// Gate the manage op through the vault-write boundary. Without
				// this, `manage` tier with `mcpVaultWrites: "scoped"` could rename
				// ANY vault file - the runWrite call below only checks `review`,
				// and `reviewFn` is undefined when no vault-wide write mode is
				// on. gateVaultWrite enforces writeDir / writeVault / writeReviewed
				// semantics, then chains into runWrite for the rename + recheck.
				return gateVaultWrite({
					destPath: f.path,
					operation: "rename",
					description: `Rename ${f.path} → ${newPath}`,
					writeDir: getWriteDir(),
					enabledTiers,
					review: reviewFn,
					affectedLinks: collectBacklinks(f.path),
					apply: () => app.fileManager.renameFile(f, newPath),
					successMsg: `Renamed to ${newPath}`,
				});
			},
		}),
	);

	push(
		defineTool({
			name: "vault_move",
			tier: "manage",
			title: "Move file",
			description: "Move a file to a different folder. Automatically updates all wikilinks.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				to: z.string().describe("Destination folder path"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path, to: dest }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				if (pathHasParentSegment(dest) || dest.includes("\\"))
					return error("'to' may not contain a '..' segment or backslashes.");
				const cleanDest = dest.replace(/^\/+|\/+$/g, "");
				const newPath = cleanDest ? `${cleanDest}/${f.name}` : f.name;
				if (!isVaultPathSafe(app, newPath))
					return error("Destination resolves outside the vault.");
				if (!isPathAllowedByFilter(newPath, pathFilter))
					return error("Destination path is blocked by allow/block list.");
				// Pre-check destination collision so the failure surfaces as a
				// clean MCP error instead of the renameFile rejection bubbling
				// up as a generic 500 from the tool runner. No-op when the
				// destination is the same path as the source (no actual move).
				if (newPath !== f.path && app.vault.getFileByPath(newPath))
					return error(`Destination already exists: ${newPath}`);
				// vault_move writes at two locations: source becomes empty and
				// destination receives the file. vault_rename is structurally
				// safe because source and dest share the parent directory;
				// vault_move can lift a file out of writeDir or pull one in
				// from outside. Both halves need the same write-tier rules:
				// check source against the writeDir gate here, then route the
				// destination through gateVaultWrite so writeScoped-only
				// callers can only move files where both endpoints sit inside
				// writeDir.
				const sourceWithin = isPathWithinDir(f.path, getWriteDir());
				const writeVaultOk = enabledTiers.has("writeVault");
				const writeReviewedOk = enabledTiers.has("writeReviewed") && reviewFn !== undefined;
				if (!sourceWithin && !writeVaultOk && !writeReviewedOk) {
					return error(
						`Source '${f.path}' is outside the write directory '${getWriteDir()}'. Enable vault-wide writes (or reviewed writes) to move files from there.`,
					);
				}
				return gateVaultWrite({
					destPath: newPath,
					operation: "move",
					description: `Move ${f.path} → ${newPath}`,
					writeDir: getWriteDir(),
					enabledTiers,
					review: reviewFn,
					affectedLinks: collectBacklinks(f.path),
					apply: () => app.fileManager.renameFile(f, newPath),
					successMsg: `Moved to ${newPath}`,
				});
			},
		}),
	);

	push(
		defineTool({
			name: "vault_delete",
			tier: "manage",
			title: "Delete file or folder",
			description:
				"Move a file or folder to trash. Folder deletion is recursive - children are trashed with the parent.",
			inputSchema: {
				file: z.string().optional().describe("File name (files only)"),
				path: z.string().optional().describe("Exact path from vault root (file or folder)"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path }) => {
				// `path` resolves to a file or folder; `file` is wikilink-style
				// and so only resolves files.
				const target = path
					? app.vault.getAbstractFileByPath(path)
					: file
						? (app.metadataCache.getFirstLinkpathDest(file, "") ?? null)
						: null;
				if (!target) return error("Path not found.");
				if (!isPathAllowedByFilter(target.path, pathFilter))
					return error("Path not found.");
				if (!isVaultPathSafe(app, target.path)) return error("Path not found.");
				const isFolder = "children" in target;
				// gateVaultWrite enforces writeDir/writeReviewed/writeVault.
				// Without it, `manage` tier with `mcpVaultWrites: "scoped"` would
				// let any agent trash any file or folder.
				return gateVaultWrite({
					destPath: target.path,
					operation: "delete",
					description: isFolder
						? `Delete folder ${target.path} (recursive)`
						: `Delete ${target.path}`,
					writeDir: getWriteDir(),
					enabledTiers,
					review: reviewFn,
					// Folders carry no link metadata of their own.
					affectedLinks: isFolder ? undefined : collectBacklinks(target.path),
					apply: () => app.vault.trash(target, true),
					successMsg: isFolder
						? `Deleted folder ${target.path}`
						: `Deleted ${target.path}`,
				});
			},
		}),
	);

	push(
		defineTool({
			name: "vault_create_folder",
			tier: "manage",
			title: "Create folder",
			description:
				"Create a new folder in the vault. No-op if the folder already exists; errors if a file already occupies the path.",
			inputSchema: {
				path: z.string().describe("Folder path from vault root"),
			},

			handler: async ({ path }) => {
				// Shape + pathFilter + symlink-realpath checks live in the shared
				// helper. Without pathFilter, a `manage` agent with a blocklist
				// could materialise folders inside blocklisted regions (anchoring
				// future writes via `vault_create` once writeVault is granted).
				const pathError = validateNewVaultPath(app, path, pathFilter);
				if (pathError) return pathError;
				// `mkdir -p` semantics. File collisions still error to avoid
				// silently shadowing a same-named note.
				const existing = app.vault.getAbstractFileByPath(path);
				if (existing) {
					if ("children" in existing) return text(`Folder already exists at ${path}`);
					return error(`Path ${path} exists as a file; refusing to create folder.`);
				}
				return gateVaultWrite({
					destPath: path,
					operation: "create",
					description: `Create folder ${path}`,
					writeDir: getWriteDir(),
					enabledTiers,
					review: reviewFn,
					apply: () => app.vault.createFolder(path),
					successMsg: `Created folder ${path}`,
				});
			},
		}),
	);

	// ── Batch operations ──────────────────────────────

	push(
		defineTool({
			name: "vault_batch_frontmatter",
			tier: "manage",
			title: "Batch frontmatter update",
			description:
				"Set or delete a frontmatter property across files matching a folder prefix and/or a content search query. At least one of `folder` or `query` is required. Use dryRun to preview changes.",
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe(
						"Full-text content search to match files. Optional when `folder` is supplied.",
					),
				folder: z
					.string()
					.optional()
					.describe(
						"Vault path prefix to restrict matches. Optional when `query` is supplied.",
					),
				property: z.string().describe("Frontmatter property name"),
				value: z
					.unknown()
					.optional()
					.describe(
						"Value to set - string, number, boolean, array, or object. Omit to delete.",
					),
				dryRun: coercedBoolean()
					.optional()
					.describe("Preview only, no changes (default true)"),
			},
			refine: (args) =>
				!args.query && !args.folder ? "Provide at least one of 'query' or 'folder'." : null,
			handler: async ({ query, folder, property, value, dryRun = true }) => {
				// `hasValue` distinguishes set vs delete; the value itself can
				// legitimately be `null` or `false`.
				const hasValue = value !== undefined;
				const coercedValue = hasValue
					? normalizeFrontmatterValue(property, value)
					: undefined;
				if (!isSafeFrontmatterProperty(property))
					return error(
						`Property name '${property}' is not allowed (reserved or invalid).`,
					);
				const search = query ? prepareSimpleSearch(query) : null;
				// Cap matches so a broad query (`"the"`) doesn't load the entire
				// vault into memory. The dry-run preview prints the truncated
				// list with a "showing first N of M" tail.
				const BATCH_MATCH_CAP = 500;
				const matched: TFile[] = [];
				let totalMatched = 0;
				await forEachMarkdown((file, content) => {
					if (!isPathAllowedByFilter(file.path, pathFilter)) return;
					if (folder && !isPathWithinDir(file.path, folder)) return;
					if (search && !search(content)) return;
					totalMatched++;
					if (matched.length < BATCH_MATCH_CAP) matched.push(file);
				});

				if (matched.length === 0) return text("No files matched the query.");
				const truncationNote =
					totalMatched > BATCH_MATCH_CAP
						? `\n\n[showing first ${BATCH_MATCH_CAP} of ${totalMatched} matches - narrow the query to operate on more]`
						: "";

				if (dryRun) {
					const label = hasValue ? `set ${property}` : `delete ${property}`;
					return text(
						`Dry run - would ${label} on ${matched.length} file(s):\n${matched.map((f) => f.path).join("\n")}${truncationNote}`,
					);
				}

				// Gate writes outside the configured write directory the same
				// way vault_modify does: writeVault → apply; writeReviewed →
				// batch-review modal; otherwise reject if any target sits
				// outside. Without this gate, `manage` users with
				// `mcpVaultWrites: "scoped"` could mutate frontmatter anywhere
				// in the vault via a search query.
				const writeDir = getWriteDir();
				const outOfScope = matched.filter((f) => !isPathWithinDir(f.path, writeDir));
				if (outOfScope.length > 0) {
					if (!enabledTiers.has("writeVault") && !enabledTiers.has("writeReviewed")) {
						return error(
							`Refusing batch: ${outOfScope.length} of ${matched.length} matches are outside the write directory '${writeDir}'. Enable Vault-wide writes (or Reviewed writes) to operate here.`,
						);
					}
				}

				let targets: TFile[] = matched;
				// Snapshot the pre-review frontmatter per file as the CAS
				// comparison target in the apply phase, so a file that changed
				// between modal-show and modal-approve is skipped rather than
				// blindly overwritten. Keyed by file.path because TFile
				// identity isn't reliable - Obsidian recreates the wrapper
				// across rename/move events.
				const preReviewFm = new Map<string, Record<string, unknown>>();
				for (const file of matched) {
					preReviewFm.set(file.path, frontmatterSnapshot(file));
				}
				const reviewUsed = !!reviewBatchFn;
				if (reviewBatchFn) {
					const items = matched.map((file) => {
						const oldFm = preReviewFm.get(file.path) ?? {};
						let newFm: Record<string, unknown>;
						if (hasValue) {
							newFm = { ...oldFm, [property]: coercedValue };
						} else {
							const { [property]: _dropped, ...rest } = oldFm;
							newFm = rest;
						}
						return {
							filePath: file.path,
							oldContent: JSON.stringify(oldFm, null, 2),
							newContent: JSON.stringify(newFm, null, 2),
						};
					});
					const op: WriteOperation = hasValue ? "frontmatter_set" : "frontmatter_delete";
					const verb = hasValue ? `Set ${property}` : `Delete ${property}`;
					const scopeDesc = [
						folder ? `folder '${folder}'` : null,
						query ? `query "${query}"` : null,
					]
						.filter(Boolean)
						.join(" + ");
					const result = await reviewBatchFn({
						operation: op,
						description: `${verb} on ${matched.length} file(s) matching ${scopeDesc}`,
						items,
					});
					if (!result.approved) return error("Change rejected by user.");
					const approved = new Set(result.approvedPaths);
					targets = matched.filter((f) => approved.has(f.path));
					if (targets.length === 0)
						return text("Batch approved with no files selected; nothing to do.");
				}

				// Per-file CAS skip list: when the batch went through a review,
				// any file whose frontmatter changed during the review window is
				// dropped from the apply set rather than clobbered. Without a
				// review (writeVault direct-apply path), there's no race window
				// to guard against - the snapshot and the write are back-to-back.
				const skippedDueToConcurrentEdit: string[] = [];

				// Process in chunks. Obsidian serialises per-file internally; modest
				// concurrency across files cuts wall time for large batches without
				// triggering the per-file race window.
				const FRONTMATTER_CHUNK = 10;
				for (let i = 0; i < targets.length; i += FRONTMATTER_CHUNK) {
					const chunk = targets.slice(i, i + FRONTMATTER_CHUNK);
					await Promise.all(
						chunk.map(async (file) => {
							if (reviewUsed) {
								const preFm = preReviewFm.get(file.path);
								const nowFm = frontmatterSnapshot(file);
								if (
									preFm !== undefined &&
									JSON.stringify(preFm) !== JSON.stringify(nowFm)
								) {
									skippedDueToConcurrentEdit.push(file.path);
									return;
								}
							}
							await app.fileManager.processFrontMatter(file, (fm) => {
								if (hasValue) {
									fm[property] = coercedValue;
								} else {
									delete fm[property];
								}
							});
						}),
					);
				}
				if (skippedDueToConcurrentEdit.length > 0) {
					targets = targets.filter((f) => !skippedDueToConcurrentEdit.includes(f.path));
				}

				const label = hasValue ? `Set ${property}` : `Deleted ${property}`;
				const skipNote =
					skippedDueToConcurrentEdit.length > 0
						? `\n\nSkipped ${skippedDueToConcurrentEdit.length} file(s) that changed during review:\n${skippedDueToConcurrentEdit.join("\n")}`
						: "";
				return text(`${label} on ${targets.length} file(s).${truncationNote}${skipNote}`);
			},
		}),
	);
}
