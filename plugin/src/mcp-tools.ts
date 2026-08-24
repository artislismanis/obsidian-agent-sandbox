import type { App } from "obsidian";
import { registerExtensionTools } from "./mcp-extensions";
import { ALL_TIERS, type PermissionTier } from "./permission-tiers";
import type {
	ToolBuildContext,
	McpToolDef,
	PathFilter,
	ReviewFn,
	ReviewBatchFn,
	OnActivity,
} from "./mcp-tools-registrars/core";
import { registerReadTools } from "./mcp-tools-registrars/read-tools";
import { registerWriteTools } from "./mcp-tools-registrars/write-factory";
import { registerManageTools } from "./mcp-tools-registrars/manage-tools";
import { registerMiscTools } from "./mcp-tools-registrars/misc-tools";

// Public surface re-exported unchanged so every existing `from "./mcp-tools"`
// import keeps working - the split only changes where the implementation
// lives, not the module's external shape. See mcp-tools-registrars/core.ts
// for the definitions.
export type {
	WriteOperation,
	PermissionTier,
	AgentStatus,
	OnActivity,
	McpToolDef,
	McpToolResult,
	PathFilter,
	ReviewFn,
	ReviewBatchFn,
} from "./mcp-tools-registrars/core";
export {
	DEFAULT_SESSION_KEY,
	text,
	error,
	coercedBoolean,
	defineTool,
	isPathAllowedByFilter,
	assertUnchangedDuringReview,
	validateNewVaultPath,
	forEachMarkdownChunked,
	gateVaultWrite,
} from "./mcp-tools-registrars/core";

const ALL_TIERS_SET: ReadonlySet<PermissionTier> = new Set(ALL_TIERS);

export interface BuildToolsOptions {
	app: App;
	getWriteDir: () => string;
	pathFilter?: PathFilter;
	review?: ReviewFn;
	reviewBatch?: ReviewBatchFn;
	cache?: { get<T>(key: string, compute: () => T): T };
	onActivity?: OnActivity;
	enabledTiers?: ReadonlySet<PermissionTier>;
}

/**
 * Assemble every MCP tool across all tiers. Composition root: each tier (or
 * small cluster of tiers) is registered by its own module in
 * `mcp-tools-registrars/`, sharing cross-tier helpers (link graph,
 * frontmatter snapshot, tag/property counts) via `shared-helpers.ts` and
 * registration primitives (defineTool, gateVaultWrite, path validation) via
 * `core.ts`. Does NOT filter by tier - the caller (mcp-server.ts) filters the
 * returned array against its own `enabledTiers`.
 */
export function buildTools(opts: BuildToolsOptions): McpToolDef[] {
	const ctx: ToolBuildContext = {
		app: opts.app,
		getWriteDir: opts.getWriteDir,
		pathFilter: opts.pathFilter,
		review: opts.review,
		reviewBatch: opts.reviewBatch,
		cache: opts.cache,
		onActivity: opts.onActivity,
		enabledTiers: opts.enabledTiers ?? ALL_TIERS_SET,
	};

	const tools: McpToolDef[] = [];
	const push = (tool: McpToolDef): void => {
		tools.push(tool);
	};

	registerReadTools(ctx, push);
	registerWriteTools(ctx, push);
	registerManageTools(ctx, push);
	registerMiscTools(ctx, push);
	registerExtensionTools(
		ctx.app,
		push,
		ctx.getWriteDir,
		ctx.enabledTiers,
		ctx.review,
		ctx.pathFilter,
	);

	return tools;
}
