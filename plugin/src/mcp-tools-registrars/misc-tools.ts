import { moment } from "obsidian";
import { z } from "zod/v4";
import type { MomentFactory } from "../obsidian-internals";
import type { ToolBuildContext, ToolPusher } from "./core";
import {
	defineTool,
	text,
	error,
	coercedBoolean,
	requireFileOrPath,
	resolveFile,
	DEFAULT_SESSION_KEY,
} from "./core";

/** Registers the two smallest tiers: `navigate` (vault_open) and `agent`
 *  (agent_status_set, agent_time) - too small individually to justify their
 *  own files. */
export function registerMiscTools(ctx: ToolBuildContext, push: ToolPusher): void {
	const { app, pathFilter, onActivity } = ctx;

	// ── Navigate tier ─────────────────────────────────

	push(
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

	// ── Agent tier ────────────────────────────────────

	push(
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
						"Session routing key. When running inside the Obsidian Agent Sandbox, omit this; the proxy stamps the correct key. Max 128 chars.",
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

	push(
		defineTool({
			name: "agent_time",
			tier: "agent",
			title: "Host clock",
			description:
				"Return the current date/time as seen by the Obsidian host process (not the container). " +
				"Date-sensitive tools (e.g. vault_periodic_note) resolve relative dates using this host clock. " +
				"Call this when you need to know the host date or detect the UTC offset between container and host - " +
				"if they differ, pass an explicit `date` param derived from `localIso` rather than relying on your own clock.",
			inputSchema: {},
			handler: async () => {
				// Obsidian's moment re-export loses its call signature under bundler resolution.
				const m = (moment as unknown as MomentFactory)();
				return text(
					JSON.stringify({
						localIso: m.format(),
						utcOffsetMinutes: m.utcOffset(),
						tzAbbr: m.format("z"),
					}),
				);
			},
		}),
	);
}
