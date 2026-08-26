import type { TFile } from "obsidian";
import {
	type ToolBuildContext,
	forEachMarkdownChunked,
	isPathAllowedByFilter,
	formatTags,
} from "./core";

export interface LinkGraph {
	forward: Map<string, Set<string>>;
	reverse: Map<string, Set<string>>;
}

export interface SharedHelpers {
	forEachMarkdown: (
		handler: (file: TFile, content: string) => boolean | void | Promise<boolean | void>,
		files?: TFile[],
		chunkSize?: number,
	) => Promise<{ readFailures: number }>;
	memo: <T>(key: string, compute: () => T) => T;
	visibleMarkdownFiles: () => TFile[];
	computeTagCountsSorted: () => [string, number][];
	computePropertyCountsSorted: () => [string, number][];
	buildLinkGraph: () => LinkGraph;
	collectBacklinks: (targetPath: string) => string[];
	frontmatterSnapshot: (f: TFile) => Record<string, unknown>;
}

/**
 * Cross-tier helpers extracted from buildTools() - used by read-tools.ts,
 * write-factory.ts, and manage-tools.ts alike (e.g. `collectBacklinks` is
 * used by both `vault_backlinks` (read) and `vault_rename`/`vault_move`/
 * `vault_delete` (manage); `frontmatterSnapshot` by `vault_frontmatter`
 * (read), the write factory, and `vault_batch_frontmatter` (manage)).
 *
 * Each registrar that needs these calls this factory once. `memo` itself is
 * stateless - it just forwards to `ctx.cache.get()` (the real cache, a
 * single VaultCache instance shared across the whole buildTools() call via
 * `ctx`), so creating multiple independent closures here is harmless: they
 * all read/write the same underlying cache by key.
 */
export function createSharedHelpers(ctx: ToolBuildContext): SharedHelpers {
	const { app, pathFilter, cache } = ctx;

	const forEachMarkdown: SharedHelpers["forEachMarkdown"] = (handler, files, chunkSize) =>
		forEachMarkdownChunked(app, handler, files, chunkSize);

	/** Cached compute, falling through directly when no cache is wired (tests). */
	function memo<T>(key: string, compute: () => T): T {
		return cache ? cache.get(key, compute) : compute();
	}

	function visibleMarkdownFiles(): TFile[] {
		// Apply pathFilter at the iteration boundary so vault-wide tag /
		// property counts don't leak the existence of tags or properties
		// from blocklisted files - otherwise `blocklist: ["secrets/"]`
		// still surfaces tag totals counting unreadable files.
		const all = app.vault.getMarkdownFiles();
		if (!pathFilter) return all;
		return all.filter((f) => isPathAllowedByFilter(f.path, pathFilter));
	}

	function computeTagCountsSorted(): [string, number][] {
		const counts: Record<string, number> = {};
		for (const file of visibleMarkdownFiles()) {
			const fileCache = app.metadataCache.getFileCache(file);
			for (const tag of formatTags(fileCache)) {
				counts[tag] = (counts[tag] ?? 0) + 1;
			}
		}
		return Object.entries(counts).sort((a, b) => b[1] - a[1]);
	}

	function computePropertyCountsSorted(): [string, number][] {
		const counts: Record<string, number> = {};
		for (const file of visibleMarkdownFiles()) {
			const fileCache = app.metadataCache.getFileCache(file);
			const fm = fileCache?.frontmatter;
			if (!fm) continue;
			for (const key of Object.keys(fm)) {
				if (key === "position") continue;
				counts[key] = (counts[key] ?? 0) + 1;
			}
		}
		return Object.entries(counts).sort((a, b) => b[1] - a[1]);
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
		// Per-tool filterPaths-on-output doesn't recover this - the structure
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

	function collectBacklinks(targetPath: string): string[] {
		return [...(buildLinkGraph().reverse.get(targetPath) ?? [])];
	}

	/** Snapshot a file's frontmatter for review preview. Excludes Obsidian's internal `position`. */
	function frontmatterSnapshot(f: TFile): Record<string, unknown> {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) return {};
		const { position: _position, ...rest } = fm;
		return rest;
	}

	return {
		forEachMarkdown,
		memo,
		visibleMarkdownFiles,
		computeTagCountsSorted,
		computePropertyCountsSorted,
		buildLinkGraph,
		collectBacklinks,
		frontmatterSnapshot,
	};
}
