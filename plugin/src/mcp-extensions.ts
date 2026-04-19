/**
 * Plugin API integrations — MCP tools that delegate to other installed
 * Obsidian plugins. Each integration registers its tools only when its
 * target plugin is loaded; missing plugins mean the tool is absent from
 * the tool list, not present-but-erroring.
 *
 * Canvas is the exception: `.canvas` files are native Obsidian JSON, so
 * the read/modify tools work without any target plugin installed.
 */

import type { App, TFile } from "obsidian";
import { z } from "zod/v4";
import type { McpToolDef } from "./mcp-tools";

type ToolPusher = (tool: McpToolDef) => void;

function text(str: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: str }] };
}

function error(msg: string): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return { content: [{ type: "text", text: msg }], isError: true };
}

function resolveCanvasFile(app: App, path: string): TFile | null {
	const f = app.vault.getFileByPath(path);
	if (!f || f.extension !== "canvas") return null;
	return f;
}

// ── Canvas ──────────────────────────────────────────

export function registerCanvasTools(app: App, push: ToolPusher): void {
	push({
		name: "vault_canvas_read",
		tier: "extensions",
		config: {
			title: "Read canvas",
			description:
				"Read a .canvas file and return its JSON structure: nodes (text/file/link/group) and edges. Works without any target plugin — `.canvas` is Obsidian's native format.",
			inputSchema: {
				path: z.string().describe("Canvas file path from vault root (.canvas extension)"),
			},
		},
		handler: async (args) => {
			const path = args.path as string;
			const f = resolveCanvasFile(app, path);
			if (!f) return error("Canvas file not found (must end in .canvas).");
			const raw = await app.vault.read(f);
			try {
				const parsed = JSON.parse(raw);
				return text(JSON.stringify(parsed, null, 2));
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return error(`Canvas JSON parse failed: ${msg}`);
			}
		},
	});

	push({
		name: "vault_canvas_modify",
		tier: "extensions",
		config: {
			title: "Modify canvas",
			description:
				"Apply changes to a .canvas file. Supports adding or removing nodes and edges. The `changes` payload is a JSON object with optional `addNodes`, `removeNodeIds`, `addEdges`, `removeEdgeIds` arrays.",
			inputSchema: {
				path: z.string().describe("Canvas file path from vault root"),
				changes: z
					.string()
					.describe(
						"JSON: { addNodes?: CanvasNode[]; removeNodeIds?: string[]; addEdges?: CanvasEdge[]; removeEdgeIds?: string[] }",
					),
			},
		},
		handler: async (args) => {
			const path = args.path as string;
			const changesRaw = args.changes as string;
			const f = resolveCanvasFile(app, path);
			if (!f) return error("Canvas file not found (must end in .canvas).");

			let changes: {
				addNodes?: Array<Record<string, unknown>>;
				removeNodeIds?: string[];
				addEdges?: Array<Record<string, unknown>>;
				removeEdgeIds?: string[];
			};
			try {
				changes = JSON.parse(changesRaw);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return error(`Invalid JSON in 'changes': ${msg}`);
			}

			const raw = await app.vault.read(f);
			let doc: {
				nodes?: Array<Record<string, unknown>>;
				edges?: Array<Record<string, unknown>>;
			};
			try {
				doc = JSON.parse(raw);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return error(`Existing canvas JSON parse failed: ${msg}`);
			}

			doc.nodes ??= [];
			doc.edges ??= [];

			const removeNodeIds = new Set(changes.removeNodeIds ?? []);
			if (removeNodeIds.size > 0) {
				doc.nodes = doc.nodes.filter((n) => !removeNodeIds.has(n.id as string));
				// Cascade: drop edges touching removed nodes
				doc.edges = doc.edges.filter(
					(e) =>
						!removeNodeIds.has(e.fromNode as string) &&
						!removeNodeIds.has(e.toNode as string),
				);
			}
			const removeEdgeIds = new Set(changes.removeEdgeIds ?? []);
			if (removeEdgeIds.size > 0) {
				doc.edges = doc.edges.filter((e) => !removeEdgeIds.has(e.id as string));
			}
			if (changes.addNodes) doc.nodes.push(...changes.addNodes);
			if (changes.addEdges) doc.edges.push(...changes.addEdges);

			await app.vault.modify(f, JSON.stringify(doc, null, 2));
			const summary = [
				changes.addNodes?.length ? `+${changes.addNodes.length} nodes` : null,
				removeNodeIds.size ? `-${removeNodeIds.size} nodes` : null,
				changes.addEdges?.length ? `+${changes.addEdges.length} edges` : null,
				removeEdgeIds.size ? `-${removeEdgeIds.size} edges` : null,
			]
				.filter(Boolean)
				.join(", ");
			return text(`Modified ${f.path} (${summary || "no-op"}).`);
		},
	});
}

// ── Dataview ────────────────────────────────────────

interface DataviewQueryResult {
	successful: boolean;
	value?: unknown;
	error?: string;
}

interface DataviewPlugin {
	api?: {
		query?: (source: string) => Promise<DataviewQueryResult> | DataviewQueryResult;
	};
}

/** Recognise an installed+enabled Dataview. Narrow runtime shape check. */
function getDataview(app: App): DataviewPlugin | null {
	type PluginsHost = {
		plugins: {
			getPlugin?: (id: string) => unknown;
			plugins?: Record<string, unknown>;
			enabledPlugins?: Set<string>;
		};
	};
	const host = (app as unknown as PluginsHost).plugins;
	if (!host) return null;
	if (host.enabledPlugins && !host.enabledPlugins.has("dataview")) return null;
	const plugin =
		host.getPlugin?.("dataview") ?? (host.plugins && host.plugins["dataview"]) ?? null;
	if (!plugin) return null;
	const api = (plugin as DataviewPlugin).api;
	if (!api || typeof api.query !== "function") return null;
	return plugin as DataviewPlugin;
}

export function registerDataviewTools(app: App, push: ToolPusher): void {
	if (!getDataview(app)) return;
	push({
		name: "vault_dataview_query",
		tier: "extensions",
		config: {
			title: "Dataview query",
			description:
				"Run a Dataview Query Language (DQL) query against the vault. Requires the Dataview plugin to be installed and enabled. Returns the serialized result.",
			inputSchema: {
				query: z
					.string()
					.describe("Full DQL source (e.g. 'TABLE rating FROM #book SORT rating DESC')"),
			},
		},
		handler: async (args) => {
			const query = args.query as string;
			const dv = getDataview(app);
			if (!dv?.api?.query) return error("Dataview is not available.");
			try {
				const result = await dv.api.query(query);
				if (!result.successful) {
					return error(`Dataview query error: ${result.error ?? "(no message)"}`);
				}
				return text(JSON.stringify(result.value ?? null, null, 2));
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return error(`Dataview threw: ${msg}`);
			}
		},
	});
}

// ── Tasks ───────────────────────────────────────────

interface TasksApi {
	executeToggleTaskDoneCommand?: (line: string, path: string) => string;
}

interface TasksPlugin {
	apiV1?: TasksApi;
}

function getTasks(app: App): TasksPlugin | null {
	type PluginsHost = {
		plugins: {
			getPlugin?: (id: string) => unknown;
			plugins?: Record<string, unknown>;
			enabledPlugins?: Set<string>;
		};
	};
	const host = (app as unknown as PluginsHost).plugins;
	if (!host) return null;
	if (host.enabledPlugins && !host.enabledPlugins.has("obsidian-tasks-plugin")) return null;
	const plugin =
		host.getPlugin?.("obsidian-tasks-plugin") ??
		(host.plugins && host.plugins["obsidian-tasks-plugin"]) ??
		null;
	if (!plugin) return null;
	return plugin as TasksPlugin;
}

interface TaskEntry {
	path: string;
	line: number;
	rawLine: string;
	status: "open" | "done";
	text: string;
	due?: string;
	scheduled?: string;
	start?: string;
	priority?: "highest" | "high" | "medium" | "low" | "lowest";
	tags: string[];
}

function parseTaskLine(rawLine: string): Omit<TaskEntry, "path" | "line"> | null {
	const m = /^\s*-\s*\[( |x|X)\]\s+(.*)$/.exec(rawLine);
	if (!m) return null;
	const status: "open" | "done" = m[1].toLowerCase() === "x" ? "done" : "open";
	const body = m[2];

	const due = /(?:📅|@due\()\s*(\d{4}-\d{2}-\d{2})\)?/.exec(body)?.[1];
	const scheduled = /(?:⏳|@scheduled\()\s*(\d{4}-\d{2}-\d{2})\)?/.exec(body)?.[1];
	const start = /(?:🛫|@start\()\s*(\d{4}-\d{2}-\d{2})\)?/.exec(body)?.[1];
	let priority: TaskEntry["priority"];
	if (body.includes("🔺")) priority = "highest";
	else if (body.includes("⏫")) priority = "high";
	else if (body.includes("🔼")) priority = "medium";
	else if (body.includes("🔽")) priority = "low";
	else if (body.includes("⏬")) priority = "lowest";

	const tags = [...body.matchAll(/#([\w/-]+)/g)].map((t) => `#${t[1]}`);

	// Strip trailing tokens from display text
	const text = body
		.replace(/(?:📅|⏳|🛫|📆)\s*\d{4}-\d{2}-\d{2}/g, "")
		.replace(/\u{1F53A}|\u{23EB}|\u{1F53C}|\u{1F53D}|\u{23EC}/gu, "")
		.trim();

	return { rawLine, status, text, due, scheduled, start, priority, tags };
}

export function registerTasksTools(app: App, push: ToolPusher): void {
	if (!getTasks(app)) return;

	push({
		name: "vault_tasks_query",
		tier: "extensions",
		config: {
			title: "Query tasks",
			description:
				"Scan markdown files for Tasks-format checklist items and filter by status / due date / priority / tag. Requires the Tasks plugin to be installed and enabled.",
			inputSchema: {
				status: z
					.enum(["open", "done", "any"])
					.optional()
					.describe("Filter by status (default: open)"),
				tag: z.string().optional().describe("Filter by a #tag (case-sensitive)"),
				dueOnOrBefore: z
					.string()
					.optional()
					.describe("ISO date (YYYY-MM-DD). Keep only tasks due on or before this date."),
				priorityAtLeast: z
					.enum(["lowest", "low", "medium", "high", "highest"])
					.optional()
					.describe("Keep only tasks with this priority or higher"),
				folder: z.string().optional().describe("Restrict scan to a folder prefix"),
				limit: z.number().optional().describe("Max results (default 100)"),
			},
		},
		handler: async (args) => {
			const wantStatus = (args.status as "open" | "done" | "any" | undefined) ?? "open";
			const tagFilter = args.tag as string | undefined;
			const dueLimit = args.dueOnOrBefore as string | undefined;
			const folder = args.folder as string | undefined;
			const limit = (args.limit as number | undefined) ?? 100;
			const priorityOrder = ["lowest", "low", "medium", "high", "highest"] as const;
			const minPriority = args.priorityAtLeast as TaskEntry["priority"] | undefined;
			const minIdx = minPriority ? priorityOrder.indexOf(minPriority) : -1;

			const files = app.vault
				.getMarkdownFiles()
				.filter((f) => !folder || f.path.startsWith(folder + "/") || f.path === folder);

			const results: TaskEntry[] = [];
			for (const file of files) {
				if (results.length >= limit) break;
				const content = await app.vault.cachedRead(file);
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					const parsed = parseTaskLine(lines[i]);
					if (!parsed) continue;
					if (wantStatus !== "any" && parsed.status !== wantStatus) continue;
					if (tagFilter && !parsed.tags.includes(tagFilter)) continue;
					if (dueLimit && parsed.due && parsed.due > dueLimit) continue;
					if (dueLimit && !parsed.due) continue;
					if (minIdx >= 0) {
						const pIdx = parsed.priority ? priorityOrder.indexOf(parsed.priority) : -1;
						if (pIdx < minIdx) continue;
					}
					results.push({ ...parsed, path: file.path, line: i + 1 });
					if (results.length >= limit) break;
				}
			}

			if (results.length === 0) return text("(no matching tasks)");
			const body = results
				.map((r) => {
					const meta: string[] = [];
					if (r.due) meta.push(`due ${r.due}`);
					if (r.scheduled) meta.push(`scheduled ${r.scheduled}`);
					if (r.priority) meta.push(r.priority);
					if (r.tags.length) meta.push(r.tags.join(" "));
					const metaStr = meta.length ? ` [${meta.join(", ")}]` : "";
					return `${r.path}:${r.line}  [${r.status === "done" ? "x" : " "}] ${r.text}${metaStr}`;
				})
				.join("\n");
			return text(body);
		},
	});

	push({
		name: "vault_tasks_toggle",
		tier: "extensions",
		config: {
			title: "Toggle task",
			description:
				"Toggle a checklist item between done and open at a specific file:line. Delegates to the Tasks plugin's apiV1.executeToggleTaskDoneCommand so it applies the plugin's full done-handling (recurring tasks, done-date, etc).",
			inputSchema: {
				path: z.string().describe("File path from vault root"),
				line: z.number().describe("1-based line number of the task"),
			},
		},
		handler: async (args) => {
			const path = args.path as string;
			const line = args.line as number;
			const plugin = getTasks(app);
			if (!plugin?.apiV1?.executeToggleTaskDoneCommand)
				return error("Tasks plugin is not available.");
			const f = app.vault.getFileByPath(path);
			if (!f) return error(`File not found: ${path}`);
			const content = await app.vault.read(f);
			const lines = content.split("\n");
			const targetIdx = line - 1;
			if (targetIdx < 0 || targetIdx >= lines.length)
				return error(`Line ${line} is out of range (1-${lines.length}).`);
			const originalLine = lines[targetIdx];
			if (!/^\s*-\s*\[.\]/.test(originalLine))
				return error(`Line ${line} is not a checklist item.`);
			try {
				const updated = plugin.apiV1.executeToggleTaskDoneCommand(originalLine, path);
				if (typeof updated !== "string")
					return error("Tasks plugin returned an unexpected value.");
				if (updated === originalLine) return text(`No change at ${path}:${line}.`);
				// Tasks may return multi-line output when splitting recurring tasks.
				const newBlock = updated.replace(/\n$/, "");
				const newLines = [
					...lines.slice(0, targetIdx),
					...newBlock.split("\n"),
					...lines.slice(targetIdx + 1),
				];
				await app.vault.modify(f, newLines.join("\n"));
				return text(`Toggled ${path}:${line}.`);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return error(`Tasks plugin threw: ${msg}`);
			}
		},
	});
}

/** Register every plugin-integration tool whose target plugin is loaded. */
export function registerExtensionTools(app: App, push: ToolPusher): void {
	registerCanvasTools(app, push);
	registerDataviewTools(app, push);
	registerTasksTools(app, push);
}
