import type { App, TFile, CachedMetadata } from "obsidian";
import { z } from "zod/v4";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isPathWithinDir, isPathAllowed, pathHasParentSegment } from "../validation";
import type { WriteOperation } from "../diff-review-modal";
import { errMsg, logger } from "../logger";
import { isVaultPathSafe } from "../obsidian-internals";
import type { PermissionTier } from "../permission-tiers";

export type { WriteOperation };
export type { PermissionTier };

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

/** Pushes a completed tool def into the array the composition root collects
 *  from every registrar - shared shape with mcp-extensions.ts's ToolPusher. */
export type ToolPusher = (tool: McpToolDef) => void;

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
 *  `vault_tags` skips this - both omitted means "vault-wide listing". */
export const requireFileOrPath = (args: { file?: string; path?: string }): string | null =>
	!args.file && !args.path ? "Provide either 'file' or 'path'." : null;

/** Extract a 180-char window around the first match offset, with newlines flattened. */
export function extractSnippet(content: string, offset: number): string {
	const start = Math.max(0, offset - 60);
	const end = Math.min(content.length, offset + 120);
	return content.slice(start, end).replace(/\n/g, " ");
}

export function fileToInfo(file: TFile): string {
	return [
		`path: ${file.path}`,
		`name: ${file.basename}`,
		`extension: ${file.extension}`,
		`size: ${file.stat.size}`,
		`created: ${file.stat.ctime}`,
		`modified: ${file.stat.mtime}`,
	].join("\n");
}

export function formatTags(cache: CachedMetadata | null): string[] {
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
	/** Paths inside this directory bypass the filter; it governs only outside paths. */
	getWriteDir?: () => string;
	/** When true, paths matching neither list are denied. Default: false (allow). */
	defaultDeny?: boolean;
}

/** True when `pathFilter` admits `path` (or no filter is configured).
 *
 * Paths inside the vault write directory always pass. */
export function isPathAllowedByFilter(path: string, pathFilter: PathFilter | undefined): boolean {
	if (!pathFilter) return true;
	const writeDir = pathFilter.getWriteDir?.();
	if (writeDir && isPathWithinDir(path, writeDir)) return true;
	return isPathAllowed(
		path,
		pathFilter.allowlist,
		pathFilter.blocklist,
		pathFilter.defaultDeny ?? false,
	);
}

export function resolveFile(
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
export function filterPaths(paths: Iterable<string>, pathFilter?: PathFilter): string[] {
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
	return `File '${filePath}' changed during review - aborting to avoid clobbering an external edit. Re-run the tool to see the current contents.`;
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
export function isSafeFrontmatterProperty(name: string): boolean {
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
			// not valid JSON - leave as-is
		}
	}
	return value;
}

function stripTagHash(tag: string): string {
	return tag.startsWith("#") ? tag.slice(1) : tag;
}

// Coerce JSON-string inputs then apply property-specific normalisation.
// Tags: strip leading # to match Obsidian's native YAML frontmatter convention.
export function normalizeFrontmatterValue(property: string, value: unknown): unknown {
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
 * writeReviewed / writeVault dispatch - specifically the `manage` and
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
	 *  under the modal. Mirrors runWrite's `recheckFile` semantics - the
	 *  shared CAS contract for write tools that route through this gate
	 *  (vault_tasks_toggle, vault_batch_frontmatter, etc.) rather than
	 *  through runWrite. `app` is required alongside `file` - grouped in one
	 *  object so a caller can't supply one without the other and silently
	 *  get no clobber check. */
	recheck?: {
		file: TFile;
		app: App;
		/** Override the CAS comparison target when `oldContent` is a derived
		 *  representation (e.g. JSON-stringified frontmatter) rather than the
		 *  raw file contents. When omitted, recheck falls back to `oldContent`. */
		expected?: string;
	};
}): Promise<McpToolResult> {
	// Errors thrown by apply() (e.g. the Templater post-validate guard
	// rejecting a path-relocating template) must surface as clean tool
	// errors. Propagating the throw would turn it into a generic 500 or
	// return it untyped - wrap apply() so callers always get a well-formed
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
		// modal-approve. Only applies on the reviewed path - direct writes
		// (in-writeDir or writeVault) have no review window to race against.
		if (args.recheck) {
			const expected = args.recheck.expected ?? args.oldContent;
			if (expected !== undefined) {
				const conflict = await assertUnchangedDuringReview(
					args.recheck.app,
					args.recheck.file,
					expected,
					args.destPath,
				);
				if (conflict) return error(conflict);
			}
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

/**
 * Shared build-time context threaded through every tier registrar - the
 * subset of BuildToolsOptions (mcp-tools.ts) each registrar needs, plus the
 * resolved `enabledTiers` default. Mirrors mcp-extensions.ts's WriteGate
 * shape (registerExtensionTools was already an extracted registrar using
 * this pattern before the rest of buildTools() was split).
 *
 * `getWriteDir` is a live getter, re-read per call - never resolve it to a
 * string here. `enabledTiers` is read both by handlers at call time (manage/
 * batch tools) and by the composition root to filter the returned array;
 * registrars must not filter by tier themselves.
 */
export interface ToolBuildContext {
	app: App;
	getWriteDir: () => string;
	pathFilter?: PathFilter;
	review?: ReviewFn;
	reviewBatch?: ReviewBatchFn;
	cache?: { get<T>(key: string, compute: () => T): T };
	onActivity?: OnActivity;
	enabledTiers: ReadonlySet<PermissionTier>;
}
