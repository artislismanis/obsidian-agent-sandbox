import type { App, TFile, CachedMetadata } from "obsidian";
import { prepareSimpleSearch, prepareFuzzySearch } from "obsidian";
import { z } from "zod/v4";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isPathWithinDir, isPathAllowed, pathHasParentSegment } from "./validation";
import type { WriteOperation } from "./diff-review-modal";
import { registerExtensionTools } from "./mcp-extensions";
import {
	applyTemplaterFolderTemplate,
	previewTemplaterFolderTemplate,
	withTemplaterHookSuppressed,
} from "./templater-adapter";
import { errMsg, logger } from "./logger";
import { isVaultPathSafe } from "./obsidian-internals";

export type { WriteOperation };

export type PermissionTier =
	| "read"
	| "writeScoped"
	| "writeReviewed"
	| "writeVault"
	| "navigate"
	| "manage"
	| "extensions"
	| "agent";

export type AgentStatus = "idle" | "working" | "awaiting_input";

/** Sentinel session key used by both ActivityUi and the MCP `agent_status_set` tool
 *  to represent activity outside any explicit tmux session name. */
export const DEFAULT_SESSION_KEY = "__default__";

export type OnActivity = (update: {
	sessionName: string;
	status: AgentStatus;
	detail?: string;
}) => void;

export interface McpToolDef {
	name: string;
	tier: PermissionTier;
	config: {
		title: string;
		description: string;
		inputSchema?: Record<string, z.ZodType>;
	};
	handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

export interface McpToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export function text(str: string): McpToolResult {
	return { content: [{ type: "text", text: str }] };
}

export function error(msg: string): McpToolResult {
	return { content: [{ type: "text", text: msg }], isError: true };
}

/**
 * Coerce string "true"/"false" → boolean; pass non-string booleans through.
 * Avoids z.coerce.boolean() which maps any non-empty string (including "false") → true.
 */
export function coercedBoolean() {
	return z.preprocess((v) => (v === "false" ? false : v === "true" ? true : v), z.boolean());
}

/**
 * Build a tool definition whose handler receives args typed to the inferred
 * zod schema. Runtime parsing runs before the handler; schema-mismatch
 * inputs return an error result instead of throwing or feeding undefined
 * into casts.
 *
 *   defineTool({
 *     name: "vault_read",
 *     inputSchema: { path: z.string() },
 *     handler: async ({ path }) => { ... },
 *   })
 */
export function defineTool<S extends Record<string, z.ZodType>>(def: {
	name: string;
	tier: PermissionTier;
	title: string;
	description: string;
	inputSchema?: S;
	/**
	 * Post-parse validation across fields (e.g. "require either `file` or
	 * `path`"). Return `null` when args are valid, or a message describing
	 * the problem. Wrapped with the same `Invalid arguments:` prefix zod
	 * uses so callers see a consistent error shape.
	 */
	refine?: (args: z.infer<z.ZodObject<S>>) => string | null;
	handler: (args: z.infer<z.ZodObject<S>>) => Promise<McpToolResult>;
}): McpToolDef {
	const schema = def.inputSchema ? z.object(def.inputSchema) : z.object({});
	return {
		name: def.name,
		tier: def.tier,
		config: {
			title: def.title,
			description: def.description,
			inputSchema: def.inputSchema,
		},
		handler: async (raw) => {
			const parsed = schema.safeParse(raw);
			if (!parsed.success) {
				return error(`Invalid arguments: ${parsed.error.message}`);
			}
			const data = parsed.data as z.infer<z.ZodObject<S>>;
			if (def.refine) {
				const refineErr = def.refine(data);
				if (refineErr)
					throw new McpError(
						ErrorCode.InvalidParams,
						`Input validation error: ${refineErr}`,
					);
			}
			return def.handler(data);
		},
	};
}

/** Cross-field validator: require either `file` (wikilink) or `path` (exact).
 *  `vault_tags` skips this — both omitted means "vault-wide listing". */
const requireFileOrPath = (args: { file?: string; path?: string }): string | null =>
	!args.file && !args.path ? "Provide either 'file' or 'path'." : null;

/** Extract a 180-char window around the first match offset, with newlines flattened. */
function extractSnippet(content: string, offset: number): string {
	const start = Math.max(0, offset - 60);
	const end = Math.min(content.length, offset + 120);
	return content.slice(start, end).replace(/\n/g, " ");
}

function fileToInfo(file: TFile): string {
	return [
		`path: ${file.path}`,
		`name: ${file.basename}`,
		`extension: ${file.extension}`,
		`size: ${file.stat.size}`,
		`created: ${file.stat.ctime}`,
		`modified: ${file.stat.mtime}`,
	].join("\n");
}

function formatTags(cache: CachedMetadata | null): string[] {
	if (!cache) return [];
	const tags: string[] = [];
	if (cache.tags) {
		for (const t of cache.tags) tags.push(t.tag);
	}
	if (cache.frontmatter?.tags) {
		const fm = cache.frontmatter.tags;
		if (Array.isArray(fm)) {
			for (const t of fm)
				tags.push(typeof t === "string" && !t.startsWith("#") ? `#${t}` : String(t));
		}
	}
	return [...new Set(tags)];
}

export interface PathFilter {
	allowlist: string[];
	blocklist: string[];
	/** When provided, paths inside this directory always bypass the
	 *  allow/block filter entirely — the filter governs only paths
	 *  outside the agent's write workspace. */
	getWriteDir?: () => string;
}

/** True when `pathFilter` admits `path` (or no filter is configured).
 *
 * Paths inside the write workspace (per `pathFilter.getWriteDir`) always
 * pass — the filter governs outside-workspace paths only (#123). */
export function isPathAllowedByFilter(path: string, pathFilter: PathFilter | undefined): boolean {
	if (!pathFilter) return true;
	const writeDir = pathFilter.getWriteDir?.();
	if (writeDir && isPathWithinDir(path, writeDir)) return true;
	return isPathAllowed(path, pathFilter.allowlist, pathFilter.blocklist);
}

function resolveFile(
	app: App,
	args: { file?: string; path?: string },
	pathFilter?: PathFilter,
): TFile | null {
	let resolved: TFile | null = null;
	if (args.path) resolved = app.vault.getFileByPath(args.path) ?? null;
	else if (args.file) resolved = app.metadataCache.getFirstLinkpathDest(args.file, "") ?? null;
	if (resolved && !isPathAllowedByFilter(resolved.path, pathFilter)) return null;
	if (resolved && !isVaultPathSafe(app, resolved.path)) return null;
	return resolved;
}

/**
 * Drop target paths the agent cannot see. Without this, link/graph read tools
 * leak the existence and names of out-of-allowlist files via outgoing-link
 * metadata, backlinks, orphan/unresolved-link tables, and BFS frontiers.
 */
function filterPaths(paths: Iterable<string>, pathFilter?: PathFilter): string[] {
	const arr = [...paths];
	if (!pathFilter) return arr;
	return arr.filter((p) => isPathAllowedByFilter(p, pathFilter));
}

/**
 * Compare-and-swap helper for reviewed writes. After the user approves a diff
 * preview, re-read the file and abort if the contents diverged from what was
 * reviewed. Used by both `runWrite` (per-tool path) and `gateVaultWrite`
 * (manage/extensions path) so the two paths share the same message.
 *
 * Returns null when the file is unchanged (caller may proceed), or an error
 * result the caller should return as-is.
 */
export async function assertUnchangedDuringReview(
	app: App,
	file: TFile,
	expected: string,
	filePath: string,
): Promise<string | null> {
	const current = await app.vault.read(file);
	if (current === expected) return null;
	return `File '${filePath}' changed during review — aborting to avoid clobbering an external edit. Re-run the tool to see the current contents.`;
}

/**
 * Validate a vault-relative path for create operations. Short-circuits the
 * shape/filter/realpath checks that vault_create, vault_create_folder,
 * vault_templater_create and vault_periodic_note all need before creating a
 * new file or folder.
 *
 * Rejects: `..` segments, leading `/` or `\`, Windows drive letters, NTFS
 * alt-data-stream `:`, paths blocked by the configured pathFilter, and paths
 * whose realpath resolves outside the vault (symlink escape).
 *
 * Returns `null` on success or an `McpToolResult` error the handler can
 * return as-is.
 */
export function validateNewVaultPath(
	app: App,
	path: string,
	pathFilter: PathFilter | undefined,
): McpToolResult | null {
	if (pathHasParentSegment(path) || path.startsWith("/") || path.startsWith("\\"))
		return error("Path may not contain a '..' segment or start with '/' or '\\'.");
	if (path.includes(":"))
		return error("Path may not contain drive letters or ':' (alt-data-stream).");
	if (!isPathAllowedByFilter(path, pathFilter))
		return error("Path is blocked by allow/block list.");
	if (!isVaultPathSafe(app, path)) return error("Path resolves outside the vault (symlink).");
	const basename = path.split("/").pop() ?? path;
	if (basename.startsWith("."))
		return error("Path may not create a dotfile (basename starting with '.').");
	return null;
}

/**
 * Reject frontmatter property names that would mutate the prototype chain when
 * assigned via `fm[name] = value`. Also rejects empty names. The denylist
 * mirrors the standard prototype-pollution surface.
 */
const FORBIDDEN_FM_PROPS = new Set(["__proto__", "constructor", "prototype"]);
function isSafeFrontmatterProperty(name: string): boolean {
	if (typeof name !== "string" || name.length === 0) return false;
	return !FORBIDDEN_FM_PROPS.has(name);
}

// LLMs sometimes pass arrays/objects as JSON-encoded strings (e.g. '["a","b"]').
// Unwrap those so Obsidian's tag parser sees a real array, not a quoted string.
function coerceJsonValue(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const s = value.trim();
	if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
		try {
			return JSON.parse(s);
		} catch {
			// not valid JSON — leave as-is
		}
	}
	return value;
}

function stripTagHash(tag: string): string {
	return tag.startsWith("#") ? tag.slice(1) : tag;
}

// Coerce JSON-string inputs then apply property-specific normalisation.
// Tags: strip leading # to match Obsidian's native YAML frontmatter convention.
function normalizeFrontmatterValue(property: string, value: unknown): unknown {
	const coerced = coerceJsonValue(value);
	if (property === "tags") {
		if (Array.isArray(coerced))
			return coerced.map((v) => (typeof v === "string" ? stripTagHash(v) : v));
		if (typeof coerced === "string") return stripTagHash(coerced);
	}
	return coerced;
}

/** Parallel-chunked iteration over markdown files; handler returning true stops the walk.
 *
 * Returns the read-failure count so callers can surface a "scan skipped N
 * files" hint. A single unreadable file (permission glitch, transient FS
 * error) doesn't abort the scan, but the count keeps the failure observable
 * rather than disappearing into the empty-string substitute. */
export async function forEachMarkdownChunked(
	app: App,
	handler: (file: TFile, content: string) => boolean | void | Promise<boolean | void>,
	files: TFile[] = app.vault.getMarkdownFiles(),
	chunkSize = 20,
): Promise<{ readFailures: number }> {
	let readFailures = 0;
	for (let i = 0; i < files.length; i += chunkSize) {
		const chunk = files.slice(i, i + chunkSize);
		const contents = await Promise.all(
			chunk.map((f) =>
				app.vault.cachedRead(f).catch((err) => {
					readFailures++;
					logger.warn("MCP", `cachedRead failed for ${f.path}: ${errMsg(err)}`);
					return "";
				}),
			),
		);
		for (let j = 0; j < chunk.length; j++) {
			const stop = await handler(chunk[j], contents[j]);
			if (stop) return { readFailures };
		}
	}
	return { readFailures };
}

export type ReviewFn = (request: {
	operation: WriteOperation;
	filePath: string;
	oldContent?: string;
	newContent?: string;
	description: string;
	affectedLinks?: string[];
}) => Promise<{ approved: boolean }>;

/**
 * Shared write boundary for tools that don't go through the writeScoped /
 * writeReviewed / writeVault dispatch — specifically the `manage` and
 * `extensions` tier tools that create or modify vault files. Honors the same
 * VaultWriteMode semantics: writes inside the write directory always pass;
 * writes outside require either `writeVault` (apply directly) or
 * `writeReviewed` (prompt via review); otherwise reject.
 */
export async function gateVaultWrite(args: {
	destPath: string;
	operation: WriteOperation;
	description: string;
	writeDir: string;
	enabledTiers: ReadonlySet<PermissionTier>;
	review: ReviewFn | undefined;
	apply: () => Promise<unknown>;
	successMsg: string;
	oldContent?: string;
	newContent?: string;
	affectedLinks?: string[];
	/** When set alongside a writeReviewed review, after approval the file is
	 *  re-read and the write is aborted if the contents changed out from
	 *  under the modal. Mirrors runWrite's `recheckFile` semantics — the
	 *  shared CAS contract for write tools that route through this gate
	 *  (vault_tasks_toggle, vault_batch_frontmatter, etc.) rather than
	 *  through runWrite. */
	recheckFile?: TFile;
	/** Override the CAS comparison target when `oldContent` is a derived
	 *  representation (e.g. JSON-stringified frontmatter) rather than the
	 *  raw file contents. When omitted, recheck falls back to `oldContent`. */
	recheckExpected?: string;
	/** App handle for the `recheckFile` re-read. Required when `recheckFile`
	 *  is provided; without it, the gate has no way to call `vault.read`. */
	app?: App;
}): Promise<McpToolResult> {
	// Errors thrown by apply() (e.g. the Templater post-validate guard
	// rejecting a path-relocating template) must surface as clean tool
	// errors. Propagating the throw would turn it into a generic 500 or
	// return it untyped — wrap apply() so callers always get a well-formed
	// McpToolResult.
	const runApply = async (): Promise<McpToolResult> => {
		try {
			await args.apply();
			return text(args.successMsg);
		} catch (e) {
			return error(errMsg(e));
		}
	};
	const within = isPathWithinDir(args.destPath, args.writeDir);
	if (within || args.enabledTiers.has("writeVault")) {
		return runApply();
	}
	if (args.enabledTiers.has("writeReviewed") && args.review) {
		const result = await args.review({
			operation: args.operation,
			filePath: args.destPath,
			oldContent: args.oldContent,
			newContent: args.newContent,
			description: args.description,
			affectedLinks: args.affectedLinks,
		});
		if (!result.approved) return error("Change rejected by user.");
		// Compare-and-swap against editor edits between modal-show and
		// modal-approve. Only applies on the reviewed path — direct writes
		// (in-writeDir or writeVault) have no review window to race against.
		const expected = args.recheckExpected ?? args.oldContent;
		if (args.recheckFile && args.app && expected !== undefined) {
			const conflict = await assertUnchangedDuringReview(
				args.app,
				args.recheckFile,
				expected,
				args.destPath,
			);
			if (conflict) return error(conflict);
		}
		return runApply();
	}
	return error(
		`Path '${args.destPath}' is outside the write directory '${args.writeDir}'. Enable vault-wide or reviewed writes to operate here.`,
	);
}

export type ReviewBatchFn = (request: {
	operation: WriteOperation;
	description: string;
	items: Array<{ filePath: string; oldContent?: string; newContent?: string }>;
}) => Promise<{ approved: boolean; approvedPaths: string[] }>;

const ALL_TIERS: ReadonlySet<PermissionTier> = new Set<PermissionTier>([
	"read",
	"writeScoped",
	"writeReviewed",
	"writeVault",
	"navigate",
	"manage",
	"extensions",
	"agent",
]);

export interface BuildToolsOptions {
	app: App;
	getWriteDir: () => string;
	pathFilter?: PathFilter;
	review?: ReviewFn;
	reviewBatch?: ReviewBatchFn;
	cache?: { get<T>(key: string, compute: () => T): T };
	onActivity?: OnActivity;
	onMcpWrite?: (path: string) => void;
	enabledTiers?: ReadonlySet<PermissionTier>;
}

// vault.createFolder throws if any ancestor is absent — walk the tree so
// agents can write into brand-new nested paths in one shot.
async function ensureParentFolder(app: App, filePath: string): Promise<void> {
	const parentPath = filePath.split("/").slice(0, -1).join("/");
	if (!parentPath) return;
	if (app.vault.getAbstractFileByPath(parentPath)) return;
	await ensureParentFolder(app, parentPath);
	await app.vault.createFolder(parentPath);
}

export function buildTools(opts: BuildToolsOptions): McpToolDef[] {
	const {
		app,
		getWriteDir,
		pathFilter,
		review: reviewFn,
		reviewBatch: reviewBatchFn,
		cache,
		onActivity,
		onMcpWrite,
		enabledTiers = ALL_TIERS,
	} = opts;
	const tools: McpToolDef[] = [];

	const forEachMarkdown: (
		handler: (file: TFile, content: string) => boolean | void | Promise<boolean | void>,
		files?: TFile[],
		chunkSize?: number,
	) => Promise<{ readFailures: number }> = (handler, files, chunkSize) =>
		forEachMarkdownChunked(app, handler, files, chunkSize);

	/** Cached compute, falling through directly when no cache is wired (tests). */
	function memo<T>(key: string, compute: () => T): T {
		return cache ? cache.get(key, compute) : compute();
	}

	function visibleMarkdownFiles(): TFile[] {
		// Apply pathFilter at the iteration boundary so vault-wide tag /
		// property counts don't leak the existence of tags or properties
		// from blocklisted files — otherwise `blocklist: ["secrets/"]`
		// still surfaces tag totals counting unreadable files.
		const all = app.vault.getMarkdownFiles();
		if (!pathFilter) return all;
		return all.filter((f) => isPathAllowedByFilter(f.path, pathFilter));
	}

	function computeTagCountsSorted(): [string, number][] {
		const counts: Record<string, number> = {};
		for (const file of visibleMarkdownFiles()) {
			const cache = app.metadataCache.getFileCache(file);
			for (const tag of formatTags(cache)) {
				counts[tag] = (counts[tag] ?? 0) + 1;
			}
		}
		return Object.entries(counts).sort((a, b) => b[1] - a[1]);
	}

	function computePropertyCountsSorted(): [string, number][] {
		const counts: Record<string, number> = {};
		for (const file of visibleMarkdownFiles()) {
			const cache = app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (!fm) continue;
			for (const key of Object.keys(fm)) {
				if (key === "position") continue;
				counts[key] = (counts[key] ?? 0) + 1;
			}
		}
		return Object.entries(counts).sort((a, b) => b[1] - a[1]);
	}

	// ── Read tier ─────────────────────────────────────

	tools.push(
		defineTool({
			name: "vault_read",
			tier: "read",
			title: "Read file",
			description: "Read the contents of a file in the vault.",
			inputSchema: {
				file: z.string().optional().describe("File name (wikilink-style resolution)"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const content = await app.vault.cachedRead(f);
				return text(content);
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_list",
			tier: "read",
			title: "List files",
			description: "List files in the vault. Optionally filter by folder or extension.",
			inputSchema: {
				folder: z.string().optional().describe("Filter by folder path (alias: path)"),
				path: z.string().optional().describe("Alias for folder"),
				extension: z.string().optional().describe("Filter by extension (e.g. md, json)"),
			},
			handler: async ({ folder, path: pathArg, extension }) => {
				const folderFilter = folder ?? pathArg;
				if (folderFilter) {
					const abstract = app.vault.getAbstractFileByPath(folderFilter);
					if (!abstract) return error(`Folder not found: ${folderFilter}`);
					if (!("children" in abstract)) return error(`Not a folder: ${folderFilter}`);
				}
				let files = app.vault.getFiles();
				if (folderFilter)
					files = files.filter((f) => isPathWithinDir(f.path, folderFilter));
				if (extension) files = files.filter((f) => f.extension === extension);
				// Apply pathFilter so blocklisted regions don't leak file
				// paths — otherwise `vault_list({folder: "secrets"})`
				// returns the full list regardless of allow/block config.
				const paths = filterPaths(
					files.map((f) => f.path),
					pathFilter,
				);
				return text(paths.join("\n") || "(no files)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_search",
			tier: "read",
			title: "Search vault",
			description:
				"Search for text across all markdown files in the vault. Returns matching file paths with context.",
			inputSchema: {
				query: z.string().describe("Search query text"),
				limit: z.coerce.number().optional().describe("Max results (default 20)"),
			},
			handler: async ({ query, limit: limitArg }) => {
				const limit = limitArg ?? 20;
				const search = prepareSimpleSearch(query);
				const results: string[] = [];
				await forEachMarkdown(
					(file, content) => {
						// Drop blocklisted source files so vault_search doesn't
						// leak content snippets (and existence) from paths the
						// agent can't otherwise read.
						if (!isPathAllowedByFilter(file.path, pathFilter)) return;
						const match = search(content);
						if (!match) return;
						const snippet = extractSnippet(content, match.matches[0]?.[0] ?? 0);
						results.push(`${file.path}: ...${snippet}...`);
						return results.length >= limit;
					},
					undefined,
					// Chunk size = limit (capped 1..8). forEachMarkdownChunked
					// awaits the whole chunk before checking `stop`, so a 20
					// chunk reads 19 extra files when limit=1. Keep chunks
					// tight for low limits — full-batch concurrency only helps
					// when limit is also high.
					Math.max(1, Math.min(limit, 8)),
				);
				return text(results.join("\n") || "No matches found.");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_search_fuzzy",
			tier: "read",
			title: "Fuzzy search vault",
			description:
				"Fuzzy full-text search across all markdown files — matches note content, not file names. Tolerates typos and approximate matches. Results are score-sorted.",
			inputSchema: {
				query: z.string().describe("Search query text (fuzzy matched)"),
				limit: z.coerce.number().optional().describe("Max results (default 20)"),
			},
			handler: async ({ query, limit: limitArg }) => {
				const limit = limitArg ?? 20;
				const search = prepareFuzzySearch(query);
				const hits: { path: string; score: number; snippet: string }[] = [];
				await forEachMarkdown((file, content) => {
					// Skip blocklisted source files (info-leak parity with
					// vault_search above).
					if (!isPathAllowedByFilter(file.path, pathFilter)) return;
					const match = search(content);
					if (!match) return;
					const snippet = extractSnippet(content, match.matches[0]?.[0] ?? 0);
					hits.push({ path: file.path, score: match.score, snippet });
				});
				hits.sort((a, b) => b.score - a.score);
				const formatted = hits
					.slice(0, limit)
					.map((h) => `${h.path} (score ${h.score.toFixed(2)}): ...${h.snippet}...`);
				return text(formatted.join("\n") || "No matches found.");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_file_info",
			tier: "read",
			title: "File info",
			description: "Get metadata about a file (path, name, size, dates).",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				return text(fileToInfo(f));
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_tags",
			tier: "read",
			title: "List tags",
			description:
				"List all tags in the vault with occurrence counts, or tags for a specific file when `file` or `path` is supplied.",
			inputSchema: {
				file: z
					.string()
					.optional()
					.describe(
						"File name (wikilink-style). Omit (together with `path`) for vault-wide listing.",
					),
				path: z
					.string()
					.optional()
					.describe(
						"Exact path from vault root. Omit (together with `file`) for vault-wide listing.",
					),
			},

			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (f) {
					const cache = app.metadataCache.getFileCache(f);
					const tags = formatTags(cache);
					return text(tags.join("\n") || "(no tags)");
				}
				const sorted = memo("tagCountsSorted", computeTagCountsSorted);
				return text(
					sorted.map(([tag, count]) => `${tag}: ${count}`).join("\n") || "(no tags)",
				);
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_frontmatter",
			tier: "read",
			title: "Read frontmatter",
			description: "Read YAML frontmatter properties from a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				property: z.string().optional().describe("Specific property to read"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path, property }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const cache = app.metadataCache.getFileCache(f);
				const fm = cache?.frontmatter;
				if (!fm) return text("(no frontmatter)");
				if (property) {
					const val = fm[property];
					return text(
						val !== undefined
							? JSON.stringify(val)
							: `(property '${property}' not found)`,
					);
				}
				return text(JSON.stringify(frontmatterSnapshot(f), null, 2));
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_links",
			tier: "read",
			title: "Outgoing links",
			description: "List outgoing links from a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const resolved = app.metadataCache.resolvedLinks[f.path] ?? {};
				const allowed = new Set(filterPaths(Object.keys(resolved), pathFilter));
				const entries = Object.entries(resolved)
					.filter(([target]) => allowed.has(target))
					.map(([target, count]) => `${target} (${count})`);
				return text(entries.join("\n") || "(no outgoing links)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_backlinks",
			tier: "read",
			title: "Backlinks",
			description: "List files that link to a given file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const backlinks = filterPaths(collectBacklinks(f.path), pathFilter);
				return text(backlinks.join("\n") || "(no backlinks)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_headings",
			tier: "read",
			title: "Headings",
			description: "List headings from a file as an outline.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const cache = app.metadataCache.getFileCache(f);
				const headings = cache?.headings ?? [];
				const lines = headings.map((h) => `${"  ".repeat(h.level - 1)}${h.heading}`);
				return text(lines.join("\n") || "(no headings)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_orphans",
			tier: "read",
			title: "Orphan notes",
			description: "List markdown files with no incoming links from other files.",

			handler: async () => {
				const linkedTo = buildLinkGraph().reverse;
				const orphans = app.vault
					.getMarkdownFiles()
					.filter((f) => !linkedTo.has(f.path))
					.map((f) => f.path);
				return text(filterPaths(orphans, pathFilter).join("\n") || "(no orphans)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_unresolved",
			tier: "read",
			title: "Unresolved links",
			description: "List broken wikilinks that don't resolve to any file.",

			handler: async () => {
				const entries: string[] = [];
				for (const [source, targets] of Object.entries(app.metadataCache.unresolvedLinks)) {
					// Filter by source visibility: if the agent can't see the source
					// file, don't reveal that it had unresolved links to anything.
					if (!isPathAllowedByFilter(source, pathFilter)) continue;
					for (const [target, count] of Object.entries(targets)) {
						// Also filter the TARGET string. Unresolved targets don't
						// exist on disk, but they reveal the link-text the user
						// has typed (e.g. "Project X notes") — which can leak
						// the user's vault structure / naming. Symmetric with
						// the source filter above.
						if (!isPathAllowedByFilter(target, pathFilter)) continue;
						entries.push(`${target} (from ${source}, ${count}x)`);
					}
				}
				return text(entries.join("\n") || "(no unresolved links)");
			},
		}),
	);

	// ── Graph & knowledge tools (read tier) ──────────

	tools.push(
		defineTool({
			name: "vault_recent",
			tier: "read",
			title: "Recently modified files",
			description: "List recently modified files sorted by modification time.",
			inputSchema: {
				limit: z.coerce.number().optional().describe("Max results (default 20)"),
				folder: z.string().optional().describe("Filter by folder path"),
				extension: z.string().optional().describe("Filter by extension"),
			},

			handler: async ({ limit = 20, folder, extension }) => {
				let files = app.vault.getFiles();
				if (folder) files = files.filter((f) => isPathWithinDir(f.path, folder));
				if (extension) files = files.filter((f) => f.extension === extension);
				// Drop blocklisted entries BEFORE slicing to limit so the
				// returned set is N visible files, not N-K.
				files = files.filter((f) => isPathAllowedByFilter(f.path, pathFilter));
				files.sort((a, b) => b.stat.mtime - a.stat.mtime);
				const results = files.slice(0, limit).map((f) => {
					const date = new Date(f.stat.mtime).toISOString();
					return `${date}  ${f.path}`;
				});
				return text(results.join("\n") || "(no files)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_properties",
			tier: "read",
			title: "Vault properties",
			description:
				"List all frontmatter property names across the vault with usage counts, or distinct values for a specific property.",
			inputSchema: {
				property: z
					.string()
					.optional()
					.describe("Property name to get distinct values for"),
			},

			handler: async ({ property }) => {
				if (property) {
					// `property in fm` would match inherited keys like `toString` /
					// `constructor` and let an agent get truthy counts for every
					// note. Also reject prototype-mutating names up-front so the
					// cache key can't be polluted with them.
					if (!isSafeFrontmatterProperty(property))
						return error(
							`Property name '${property}' is not allowed (reserved or invalid).`,
						);
					const compute = (): Array<[string, number]> => {
						const values: Record<string, number> = {};
						// Filter to visible files so blocklisted regions don't
						// leak property-value frequencies (matches vault_tags /
						// vault_properties totals which use visibleMarkdownFiles).
						for (const file of visibleMarkdownFiles()) {
							const fm = app.metadataCache.getFileCache(file)?.frontmatter;
							if (fm && Object.prototype.hasOwnProperty.call(fm, property)) {
								const val = JSON.stringify(fm[property]);
								values[val] = (values[val] ?? 0) + 1;
							}
						}
						return Object.entries(values).sort((a, b) => b[1] - a[1]);
					};
					const sorted = memo(`propertyValues:${property}`, compute);
					return text(
						sorted.map(([val, count]) => `${val}: ${count}`).join("\n") ||
							`(no files have property '${property}')`,
					);
				}
				const sorted = memo("propertyCountsSorted", computePropertyCountsSorted);
				return text(
					sorted.map(([key, count]) => `${key}: ${count}`).join("\n") ||
						"(no properties)",
				);
			},
		}),
	);

	interface LinkGraph {
		forward: Map<string, Set<string>>;
		reverse: Map<string, Set<string>>;
	}

	function computeLinkGraph(): LinkGraph {
		const forward = new Map<string, Set<string>>();
		const reverse = new Map<string, Set<string>>();
		// When pathFilter is set, drop edges where either endpoint is
		// out-of-allowlist before building forward/reverse:
		//  - vault_orphans: a visible file linked only by a hidden file
		//    appears "not orphan", leaking the hidden file's existence.
		//  - vault_graph_clusters: visible nodes unioned through hidden hubs
		//    leak which hidden bridges exist between visible regions.
		//  - vault_graph_path: traversing hidden intermediates reports a
		//    path through nodes the agent can't otherwise see.
		// Per-tool filterPaths-on-output doesn't recover this — the structure
		// itself leaks. Filter at graph construction.
		const allow = (p: string): boolean => isPathAllowedByFilter(p, pathFilter);
		for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
			if (!allow(source)) continue;
			if (!forward.has(source)) forward.set(source, new Set());
			for (const target of Object.keys(targets)) {
				if (!allow(target)) continue;
				forward.get(source)!.add(target);
				if (!reverse.has(target)) reverse.set(target, new Set());
				reverse.get(target)!.add(source);
			}
		}
		return { forward, reverse };
	}

	function buildLinkGraph(): LinkGraph {
		// Cache key includes filter digest so a filter-toggle (settings
		// change → MCP restart in practice) never serves a stale graph from
		// a different filter setting.
		const filterKey = pathFilter
			? `${pathFilter.allowlist.join(",")}|${pathFilter.blocklist.join(",")}`
			: "";
		return memo(`graph:${filterKey}`, computeLinkGraph);
	}

	tools.push(
		defineTool({
			name: "vault_graph_neighborhood",
			tier: "read",
			title: "Graph neighborhood",
			description: "Find all notes within N link-hops of a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				depth: z.coerce.number().optional().describe("Max hops (1-5, default 1)"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path, depth: depthArg }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const depth = Math.min(Math.max(depthArg ?? 1, 1), 5);
				const graph = buildLinkGraph();
				const visited = new Set<string>([f.path]);
				let frontier = new Set<string>([f.path]);
				const levels: string[][] = [];
				for (let d = 0; d < depth; d++) {
					const nextFrontier = new Set<string>();
					for (const node of frontier) {
						for (const neighbor of graph.forward.get(node) ?? []) {
							if (!visited.has(neighbor)) {
								visited.add(neighbor);
								nextFrontier.add(neighbor);
							}
						}
						for (const neighbor of graph.reverse.get(node) ?? []) {
							if (!visited.has(neighbor)) {
								visited.add(neighbor);
								nextFrontier.add(neighbor);
							}
						}
					}
					const visible = filterPaths(nextFrontier, pathFilter).sort();
					if (visible.length > 0) levels.push(visible);
					frontier = nextFrontier;
				}
				if (levels.length === 0) return text("(no linked notes)");
				const output = levels
					.map((nodes, i) => `Depth ${i + 1}:\n  ${nodes.join("\n  ")}`)
					.join("\n");
				return text(output);
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_graph_path",
			tier: "read",
			title: "Graph path",
			description: "Find the shortest link path between two notes.",
			inputSchema: {
				source: z.string().describe("Source file path"),
				target: z.string().describe("Target file path"),
			},

			handler: async ({ source: sourcePath, target: targetPath }) => {
				// Honor pathFilter at both endpoints so a restricted agent can't
				// probe whether out-of-allowlist files exist, and can't ride a
				// trail through them as intermediate nodes (the BFS below
				// filters intermediates too).
				if (!resolveFile(app, { path: sourcePath }, pathFilter))
					return error("Source file not found.");
				if (!resolveFile(app, { path: targetPath }, pathFilter))
					return error("Target file not found.");
				if (sourcePath === targetPath) return text(sourcePath);

				const graph = buildLinkGraph();
				// Reconstruct paths from a parent map instead of carrying full
				// path arrays in the queue. Two wins: (1) avoid the O(n²) cost
				// of `Array.shift()` by walking the queue with an index pointer
				// (Array.shift moves all subsequent elements on each call); (2)
				// memory bounded by visited size, not visited × average path
				// length.
				const queue: string[] = [sourcePath];
				let head = 0;
				const parent = new Map<string, string>();
				const visited = new Set<string>([sourcePath]);
				const MAX_VISITED = 5000;

				const reconstruct = (end: string): string => {
					const trail: string[] = [end];
					let cur: string | undefined = end;
					while ((cur = parent.get(cur))) trail.push(cur);
					trail.reverse();
					return trail.join(" → ");
				};

				// Walk both forward and reverse edges. "Shortest link path" is
				// naturally undirected (link A→B implies "connected" from the
				// user's mental model), matching vault_graph_neighborhood.
				// Graph is already filtered at construction (computeLinkGraph);
				// the intermediate-filter check below is defense in depth in
				// case the cached graph predates a filter change.
				while (head < queue.length) {
					const current = queue[head++];
					const neighbors = [
						...(graph.forward.get(current) ?? []),
						...(graph.reverse.get(current) ?? []),
					];
					for (const neighbor of neighbors) {
						if (visited.has(neighbor)) continue;
						if (neighbor !== targetPath && !isPathAllowedByFilter(neighbor, pathFilter))
							continue;
						visited.add(neighbor);
						parent.set(neighbor, current);
						if (neighbor === targetPath) return text(reconstruct(neighbor));
						if (visited.size > MAX_VISITED) {
							// Budget exhaustion is an expected outcome on large
							// graphs, not a tool error — return as text so the
							// audit log doesn't record this as a failure.
							return text(
								`Search exhausted at ${MAX_VISITED} nodes — graph too large for exhaustive BFS.`,
							);
						}
						queue.push(neighbor);
					}
				}
				return text("No path found.");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_graph_clusters",
			tier: "read",
			title: "Graph clusters",
			description: "Find groups of densely connected notes.",
			inputSchema: {
				minSize: z.coerce.number().optional().describe("Min cluster size (default 3)"),
				maxClusters: z.coerce
					.number()
					.optional()
					.describe("Max clusters to return (default 10)"),
			},

			handler: async ({ minSize = 3, maxClusters = 10 }) => {
				const graph = buildLinkGraph();

				const allNodes = new Set<string>();
				for (const [k, v] of graph.forward) {
					allNodes.add(k);
					for (const n of v) allNodes.add(n);
				}

				const parent = new Map<string, string>();
				for (const n of allNodes) parent.set(n, n);

				function find(x: string): string {
					let root = x;
					while (parent.get(root) !== root) root = parent.get(root)!;
					let cur = x;
					while (cur !== root) {
						const next = parent.get(cur)!;
						parent.set(cur, root);
						cur = next;
					}
					return root;
				}
				function union(a: string, b: string): void {
					parent.set(find(a), find(b));
				}

				for (const [source, targets] of graph.forward) {
					for (const target of targets) union(source, target);
				}

				const groups = new Map<string, string[]>();
				for (const node of allNodes) {
					const root = find(node);
					if (!groups.has(root)) groups.set(root, []);
					groups.get(root)!.push(node);
				}

				const clusters = [...groups.values()]
					// Drop members the agent can't see BEFORE applying minSize so
					// a restricted view doesn't bleed through cluster membership
					// counts. Re-apply minSize after filtering.
					.map((g) => filterPaths(g, pathFilter))
					.filter((g) => g.length >= minSize)
					.sort((a, b) => b.length - a.length)
					.slice(0, maxClusters);

				if (clusters.length === 0) return text("(no clusters found)");
				return text(
					clusters
						.map(
							(c, i) =>
								`Cluster ${i + 1} (${c.length} notes):\n  ${c.sort().join("\n  ")}`,
						)
						.join("\n\n"),
				);
			},
		}),
	);

	// ── Workflow & context tools ──────────────────────

	tools.push(
		defineTool({
			name: "vault_context",
			tier: "read",
			title: "File context",
			description:
				"Get a file's full context in one call: content, frontmatter, tags, headings, outgoing links, and backlinks.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const content = await app.vault.cachedRead(f);
				const cache = app.metadataCache.getFileCache(f);
				const snapshot = frontmatterSnapshot(f);
				const fm = Object.keys(snapshot).length > 0 ? snapshot : null;
				const tags = formatTags(cache);
				const headings = (cache?.headings ?? []).map(
					(h) => `${"#".repeat(h.level)} ${h.heading}`,
				);
				const outgoing = filterPaths(
					Object.keys(app.metadataCache.resolvedLinks[f.path] ?? {}),
					pathFilter,
				);
				const backlinks = filterPaths(collectBacklinks(f.path), pathFilter);
				const sections: string[] = [
					`# ${f.path}\n`,
					fm ? `## Frontmatter\n${JSON.stringify(fm, null, 2)}\n` : "",
					tags.length ? `## Tags\n${tags.join(", ")}\n` : "",
					headings.length ? `## Headings\n${headings.join("\n")}\n` : "",
					outgoing.length ? `## Outgoing links\n${outgoing.join("\n")}\n` : "",
					backlinks.length ? `## Backlinks\n${backlinks.join("\n")}\n` : "",
					`## Content\n${content}`,
				];
				return text(sections.filter(Boolean).join("\n"));
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_suggest_links",
			tier: "read",
			title: "Suggest links",
			description:
				"Find notes that could be linked from a file based on content overlap. Excludes already-linked notes.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				limit: z.coerce.number().optional().describe("Max suggestions (default 10)"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path, limit = 10 }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const content = await app.vault.cachedRead(f);
				const alreadyLinked = new Set(
					Object.keys(app.metadataCache.resolvedLinks[f.path] ?? {}),
				);
				alreadyLinked.add(f.path);

				const words = content
					.toLowerCase()
					.replace(/[^\w\s]/g, " ")
					.split(/\s+/)
					.filter((w) => w.length > 3);
				const wordSet = new Set(words);

				const others = app.vault
					.getMarkdownFiles()
					.filter((other) => !alreadyLinked.has(other.path));
				// Bounds for an inherently O(N×M) scan: per-file early exit
				// caps each comparison to the first ~5k words (well past the
				// point where any score signal stabilises), and SCAN_FILE_CAP
				// stops the walk once we've examined enough files to populate
				// `limit` results several times over. Without these, a vault
				// of 10k notes × 50 KiB each pegged the UI thread for >30s.
				const PER_FILE_WORD_CAP = 5000;
				const SCAN_FILE_CAP = Math.max(500, limit * 50);
				let scanned = 0;
				const candidates: { path: string; score: number }[] = [];
				await forEachMarkdown((other, otherContent) => {
					if (scanned++ >= SCAN_FILE_CAP) return true;
					let score = 0;
					if (wordSet.has(other.basename.toLowerCase())) score += 5;
					const otherWords = otherContent
						.toLowerCase()
						.replace(/[^\w\s]/g, " ")
						.split(/\s+/);
					const cap = Math.min(otherWords.length, PER_FILE_WORD_CAP);
					for (let i = 0; i < cap; i++) {
						const w = otherWords[i];
						if (w.length > 3 && wordSet.has(w)) score++;
					}
					if (score > 0) candidates.push({ path: other.path, score });
				}, others);

				candidates.sort((a, b) => b.score - a.score);
				const allowedPaths = new Set(
					filterPaths(
						candidates.map((c) => c.path),
						pathFilter,
					),
				);
				const results = candidates
					.filter((c) => allowedPaths.has(c.path))
					.slice(0, limit)
					.map((c) => `${c.path} (score: ${c.score})`);
				return text(results.join("\n") || "(no suggestions)");
			},
		}),
	);

	// ── Write tools (scoped + vault-wide via factory) ────

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
			onMcpWrite?.(op.filePath);
			const applyResult = await op.apply();
			const msg = op.successMsg.replace("{result}", applyResult ?? "");
			return text(msg);
		} catch (e) {
			return error(errMsg(e));
		}
	}

	/** Snapshot a file's frontmatter for review preview. Excludes Obsidian's internal `position`. */
	function frontmatterSnapshot(f: TFile): Record<string, unknown> {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) return {};
		const { position: _position, ...rest } = fm;
		return rest;
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
								// Capture the path before Templater runs — when a
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
								if (created.path !== expectedPath) {
									try {
										await app.vault.trash(created, true);
									} catch {
										/* surface the relocation error anyway */
									}
									throw new Error(
										`Template relocated the file from '${expectedPath}' to '${created.path}' (likely via tp.file.move). Refusing to escape the gated path.`,
									);
								}
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
				description: `Set a YAML frontmatter property on a file${scopeLabel}. Pass \`append: true\` to merge elements into an existing array rather than replacing it; if the current value is not an array it is wrapped in one first. Leading \`#\` is stripped from tag values automatically — pass \`"tag"\` or \`"#tag"\` interchangeably. JSON-encoded string arrays (e.g. \`'["a","b"]'\`) are coerced to real arrays.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					property: z.string().describe("Property name"),
					value: z
						.unknown()
						.describe("Property value — string, number, boolean, array, or object"),
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
					// Capture full file content for CAS recheck — frontmatter alone
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
					// CAS recheck against editor edits during long reviews —
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
					// event loop for seconds — past the MCP tool timeout (which
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
						// Reject patterns with nested quantifiers — classic ReDoS
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
									// No valid group at either length — pass through.
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
		scopeNote: `Restricted to the configured write directory — paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.`,
		guardPath: guardWithinWriteDir,
		resolveForWrite: (args) => {
			// Gate on the resolved TFile.path, not the caller-supplied args.
			// When the caller passes `file:` (wikilink-style basename) without
			// `path:`, resolveFile walks the whole vault to find a match — so
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
			"Unrestricted — writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.",
		guardPath: () => null,
		resolveForWrite: resolveAnywhere,
	});

	// ── Navigate tier ─────────────────────────────────

	tools.push(
		defineTool({
			name: "vault_open",
			tier: "navigate",
			title: "Open file",
			description: "Open a file in the Obsidian editor. Affects the user's UI.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				newTab: coercedBoolean().optional().describe("Open in a new tab"),
			},
			refine: requireFileOrPath,
			handler: async ({ file, path, newTab }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const leaf = app.workspace.getLeaf(newTab ? "tab" : false);
				await leaf.openFile(f);
				return text(`Opened ${f.path}`);
			},
		}),
	);

	// ── Manage tier ───────────────────────────────────

	function collectBacklinks(targetPath: string): string[] {
		return [...(buildLinkGraph().reverse.get(targetPath) ?? [])];
	}

	tools.push(
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
				// ANY vault file — the runWrite call below only checks `review`,
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

	tools.push(
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

	tools.push(
		defineTool({
			name: "vault_delete",
			tier: "manage",
			title: "Delete file or folder",
			description:
				"Move a file or folder to trash. Folder deletion is recursive — children are trashed with the parent.",
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

	tools.push(
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

	tools.push(
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
						"Value to set — string, number, boolean, array, or object. Omit to delete.",
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
						? `\n\n[showing first ${BATCH_MATCH_CAP} of ${totalMatched} matches — narrow the query to operate on more]`
						: "";

				if (dryRun) {
					const label = hasValue ? `set ${property}` : `delete ${property}`;
					return text(
						`Dry run — would ${label} on ${matched.length} file(s):\n${matched.map((f) => f.path).join("\n")}${truncationNote}`,
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
				// identity isn't reliable — Obsidian recreates the wrapper
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
				// to guard against — the snapshot and the write are back-to-back.
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

	// ── Extensions tier (plugin integrations) ─────────

	registerExtensionTools(
		app,
		(tool) => tools.push(tool),
		getWriteDir,
		enabledTiers,
		reviewFn,
		pathFilter,
	);

	// ── Agent tier ────────────────────────────────────

	tools.push(
		defineTool({
			name: "agent_status_set",
			tier: "agent",
			title: "Set agent activity status",
			description:
				"Report the current agent lifecycle state so the plugin can show which sessions are working, awaiting input, or idle. Call on transitions (e.g. at the start of a long tool call, when a user prompt is needed, when you're done).",
			inputSchema: {
				status: z
					.enum(["idle", "working", "awaiting_input"])
					.describe("Current agent state"),
				sessionName: z
					.string()
					.max(128)
					.optional()
					.describe(
						"tmux session name if running inside one (e.g. $(tmux display-message -p '#S')). Omit for an unnamed session. Max 128 chars.",
					),
				detail: z
					.string()
					.max(1024)
					.optional()
					.describe(
						"Short human-readable context (e.g. tool name, question). Max 1024 chars.",
					),
			},
			handler: async ({ status, sessionName, detail }) => {
				const name = (sessionName ?? "").trim() || DEFAULT_SESSION_KEY;
				onActivity?.({ sessionName: name, status, detail });
				return text("OK");
			},
		}),
	);

	return tools;
}
