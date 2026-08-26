import { prepareSimpleSearch, prepareFuzzySearch } from "obsidian";
import { z } from "zod/v4";
import { isPathWithinDir } from "../validation";
import {
	type ToolBuildContext,
	type ToolPusher,
	defineTool,
	text,
	error,
	requireFileOrPath,
	extractSnippet,
	fileToInfo,
	formatTags,
	isPathAllowedByFilter,
	isSafeFrontmatterProperty,
	resolveFile,
	filterPaths,
} from "./core";
import { createSharedHelpers } from "./shared-helpers";

export function registerReadTools(ctx: ToolBuildContext, push: ToolPusher): void {
	const { app, pathFilter } = ctx;
	const {
		forEachMarkdown,
		memo,
		visibleMarkdownFiles,
		computeTagCountsSorted,
		computePropertyCountsSorted,
		buildLinkGraph,
		collectBacklinks,
		frontmatterSnapshot,
	} = createSharedHelpers(ctx);

	// ── Read tier ─────────────────────────────────────

	push(
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

	push(
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
				// paths - otherwise `vault_list({folder: "secrets"})`
				// returns the full list regardless of allow/block config.
				const paths = filterPaths(
					files.map((f) => f.path),
					pathFilter,
				);
				return text(paths.join("\n") || "(no files)");
			},
		}),
	);

	push(
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
					// tight for low limits - full-batch concurrency only helps
					// when limit is also high.
					Math.max(1, Math.min(limit, 8)),
				);
				return text(results.join("\n") || "No matches found.");
			},
		}),
	);

	push(
		defineTool({
			name: "vault_search_fuzzy",
			tier: "read",
			title: "Fuzzy search vault",
			description:
				"Fuzzy full-text search across all markdown files - matches note content, not file names. Tolerates typos and approximate matches. Results are score-sorted.",
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

	push(
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

	push(
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

	push(
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

	push(
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

	push(
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

	push(
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

	push(
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

	push(
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
						// has typed (e.g. "Project X notes") - which can leak
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

	push(
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

	push(
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

	push(
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

	push(
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
				// the intermediate-filter check below is defence in depth in
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
							// graphs, not a tool error - return as text so the
							// audit log doesn't record this as a failure.
							return text(
								`Search exhausted at ${MAX_VISITED} nodes - graph too large for exhaustive BFS.`,
							);
						}
						queue.push(neighbor);
					}
				}
				return text("No path found.");
			},
		}),
	);

	push(
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

	push(
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

	push(
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
}
