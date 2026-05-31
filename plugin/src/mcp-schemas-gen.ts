/**
 * Generate a human-readable reference doc for every MCP tool the plugin
 * registers. The source of truth is `buildTools()` itself - instantiate it
 * with a minimal mock App, walk the returned tool defs, and emit markdown
 * tables of params (name, type, required, describe-text).
 *
 * `src/__tests__/mcp-schemas-doc.test.ts` both regenerates the file (when
 * `UPDATE_SCHEMAS=1`) and verifies the on-disk copy stays in sync.
 */

import { z } from "zod/v4";
import { buildTools, type McpToolDef } from "./mcp-tools";

interface ParamRow {
	name: string;
	type: string;
	required: boolean;
	description: string;
}

interface ToolDoc {
	name: string;
	tier: string;
	title: string;
	description: string;
	params: ParamRow[];
}

/** Mock App with all plugin-availability guards satisfied so `buildTools`
 *  registers every extension tool. Methods are no-ops - the generator only
 *  inspects schemas, never invokes handlers. */
function mockAppForGeneration(): unknown {
	const stub = async () => {};
	const sync = () => {};
	return {
		vault: {
			getFiles: () => [],
			getMarkdownFiles: () => [],
			getFileByPath: () => null,
			getAbstractFileByPath: () => null,
			read: stub,
			cachedRead: stub,
			create: stub,
			modify: stub,
			append: stub,
			trash: stub,
			createFolder: stub,
		},
		metadataCache: {
			getFileCache: () => null,
			getFirstLinkpathDest: () => null,
			resolvedLinks: {},
			unresolvedLinks: {},
		},
		fileManager: {
			renameFile: stub,
			processFrontMatter: stub,
		},
		workspace: {
			getLeaf: () => ({ openFile: stub }),
		},
		// Shape mirrors obsidian-internals.getInstalledPlugin and each
		// integration's per-plugin guard so every extension tool registers.
		plugins: {
			enabledPlugins: new Set([
				"dataview",
				"obsidian-tasks-plugin",
				"templater-obsidian",
				"periodic-notes",
			]),
			getPlugin: (id: string) => {
				switch (id) {
					case "dataview":
						return { api: { query: stub } };
					case "obsidian-tasks-plugin":
						return { apiV1: { executeToggleTaskDoneCommand: sync } };
					case "templater-obsidian":
						return {
							settings: { templates_folder: "Templates" },
							templater: { create_new_note_from_template: stub },
						};
					case "periodic-notes":
						return { instance: { settings: {} } };
				}
				return null;
			},
			plugins: {},
		},
	};
}

/** Walk a tool's zod inputSchema and produce row objects for the params table. */
function paramsFromSchema(inputSchema: Record<string, z.ZodType> | undefined): ParamRow[] {
	if (!inputSchema) return [];
	const rows: ParamRow[] = [];
	for (const [name, field] of Object.entries(inputSchema)) {
		const jsonSchema = (() => {
			try {
				// `io: "input"` renders the parsable request shape, which is
				// what the doc describes.
				return z.toJSONSchema(field as z.ZodType, { io: "input" }) as Record<
					string,
					unknown
				>;
			} catch {
				return {} as Record<string, unknown>;
			}
		})();
		const required = !isOptionalSchema(field);
		const description =
			(jsonSchema.description as string | undefined) ?? extractDescription(field) ?? "";
		rows.push({
			name,
			type: formatType(jsonSchema),
			required,
			description: description.replace(/\|/g, "\\|").replace(/\n/g, " "),
		});
	}
	return rows;
}

/** True when the zod field is wrapped in `.optional()`. Uses the
 *  `_zod.def.type` marker rather than instanceof to survive bundling. */
function isOptionalSchema(field: z.ZodType): boolean {
	const def = (field as unknown as { _zod?: { def?: { type?: string } } })._zod?.def;
	return def?.type === "optional" || def?.type === "default";
}

/** Pull `.describe(...)` text out of a zod field. zod stores it at
 *  `_zod.def.description` for nested wrappers. */
function extractDescription(field: z.ZodType): string | undefined {
	const def = (field as unknown as { _zod?: { def?: { description?: string } } })._zod?.def;
	if (def?.description) return def.description;
	const inner = (field as unknown as { _zod?: { def?: { innerType?: z.ZodType } } })._zod?.def
		?.innerType;
	if (inner) return extractDescription(inner);
	return undefined;
}

/** Render a JSON Schema fragment as a single-line human-readable type. */
function formatType(jsonSchema: Record<string, unknown>): string {
	if (jsonSchema.enum) {
		const values = jsonSchema.enum as unknown[];
		return values.map((v) => JSON.stringify(v)).join(" \\| ");
	}
	const type = jsonSchema.type as string | string[] | undefined;
	if (Array.isArray(type)) return type.join(" \\| ");
	if (type === "array") {
		const items = jsonSchema.items as Record<string, unknown> | undefined;
		return items ? `${formatType(items)}[]` : "array";
	}
	if (type) return type;
	return "any";
}

/** Build the doc objects for every tool in the registry. */
export function collectToolDocs(): ToolDoc[] {
	const tools: McpToolDef[] = buildTools({
		app: mockAppForGeneration() as never,
		getWriteDir: () => "agent-workspace",
		// `addWriteTools` only emits the writeReviewed-tier variants when
		// `review` is truthy.
		review: async () => ({ approved: true }),
		reviewBatch: async () => ({ approved: true, approvedPaths: [] }),
		enabledTiers: new Set([
			"read",
			"writeScoped",
			"writeReviewed",
			"writeVault",
			"navigate",
			"manage",
			"extensions",
			"agent",
		]),
	});
	return tools.map((t) => ({
		name: t.name,
		tier: t.tier,
		title: t.config.title,
		description: t.config.description,
		params: paramsFromSchema(t.config.inputSchema),
	}));
}

/** Stable tier ordering for the rendered doc. */
const TIER_ORDER = [
	"read",
	"writeScoped",
	"writeReviewed",
	"writeVault",
	"navigate",
	"manage",
	"extensions",
	"agent",
] as const;

/** Render the full markdown doc. Deterministic - sorts tools alphabetically
 *  within each tier so re-runs only diff when the schema actually changes. */
export function renderMcpSchemasMarkdown(docs: ToolDoc[]): string {
	const byTier = new Map<string, ToolDoc[]>();
	for (const tier of TIER_ORDER) byTier.set(tier, []);
	for (const d of docs) {
		const bucket = byTier.get(d.tier) ?? [];
		bucket.push(d);
		byTier.set(d.tier, bucket);
	}
	for (const list of byTier.values()) {
		list.sort((a, b) => a.name.localeCompare(b.name));
	}
	const lines: string[] = [];
	lines.push("# MCP Tool Schema Reference");
	lines.push("");
	lines.push(
		"> Generated from `buildTools()` in `plugin/src/mcp-tools.ts`. Do not edit by hand - run `npm run docs:gen` (or `UPDATE_SCHEMAS=1 npm run test`) to regenerate.",
	);
	lines.push("");
	lines.push(
		"Canonical reference for every MCP tool the plugin exposes: parameter names, types, and descriptions. Test scripts, skills, and docs that mention a tool's params should copy from here rather than from memory.",
	);
	lines.push("");
	const tableOfContents: string[] = ["## Tools by tier", ""];
	for (const tier of TIER_ORDER) {
		const list = byTier.get(tier) ?? [];
		if (list.length === 0) continue;
		tableOfContents.push(
			`- [${tier}](#${tier.toLowerCase()}) - ${list.map((t) => `\`${t.name}\``).join(", ")}`,
		);
	}
	tableOfContents.push("");
	lines.push(...tableOfContents);
	for (const tier of TIER_ORDER) {
		const list = byTier.get(tier) ?? [];
		if (list.length === 0) continue;
		lines.push(`## ${tier}`);
		lines.push("");
		for (const tool of list) {
			lines.push(`### \`${tool.name}\``);
			lines.push("");
			lines.push(`**Title:** ${tool.title}`);
			lines.push("");
			lines.push(tool.description);
			lines.push("");
			if (tool.params.length === 0) {
				lines.push("_No parameters._");
			} else {
				lines.push("| Param | Type | Required | Description |");
				lines.push("|-------|------|----------|-------------|");
				for (const p of tool.params) {
					lines.push(
						`| \`${p.name}\` | \`${p.type}\` | ${p.required ? "yes" : "no"} | ${p.description || "-"} |`,
					);
				}
			}
			lines.push("");
		}
	}
	return lines.join("\n") + "\n";
}
