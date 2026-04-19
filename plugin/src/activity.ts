/**
 * Activity feedback + agent-output notice plumbing.
 *
 * Kept out of main.ts so the plugin entry doesn't carry per-session UI
 * routing and debounce state inline. Two small managers:
 *
 * - `ActivityUi` — wires MCP `agent_status_set` updates into per-tab tab-title
 *   prefixes and the aggregate status-bar attention badge.
 * - `AgentOutputNotifier` — watches vault creates/modifies under the write
 *   directory, debounces bursts, rate-limits, and surfaces an Obsidian Notice.
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { ActivityEntry } from "./mcp-server";
import type { StatusBarManager } from "./status-bar";
import type { ActivityPrefix, TerminalView } from "./terminal-view";
import { VIEW_TYPE_TERMINAL } from "./terminal-view";
import type { AgentStatus } from "./mcp-tools";

const DEFAULT_SESSION_KEY = "__default__";

export interface ActivityUpdate {
	sessionName: string;
	status: AgentStatus;
	detail?: string;
}

export class ActivityUi {
	constructor(
		private app: App,
		private statusBar: StatusBarManager,
		private getActivity: () => ReadonlyMap<string, ActivityEntry> | undefined,
	) {}

	route(update: ActivityUpdate): void {
		const prefix: ActivityPrefix =
			update.status === "working"
				? "working"
				: update.status === "awaiting_input"
					? "awaiting_input"
					: null;

		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view as TerminalView;
			const sessionKey = view.getSessionName() ?? DEFAULT_SESSION_KEY;
			if (sessionKey === update.sessionName) {
				view.setActivityPrefix(prefix);
			}
		}

		this.refreshAttentionBadge();
	}

	clear(): void {
		this.statusBar.setAttentionCount(0);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			(leaf.view as TerminalView).setActivityPrefix(null);
		}
	}

	private refreshAttentionBadge(): void {
		const activity = this.getActivity();
		if (!activity) {
			this.statusBar.setAttentionCount(0);
			return;
		}
		let count = 0;
		const waitingNames: string[] = [];
		for (const [name, entry] of activity) {
			if (entry.status === "awaiting_input") {
				count++;
				waitingNames.push(name === DEFAULT_SESSION_KEY ? "(unnamed)" : name);
			}
		}
		this.statusBar.setAttentionCount(count);
		if (count > 0 && this.statusBar.getState() === "running") {
			this.statusBar.setDetails(
				`Sandbox running. ${count} session(s) awaiting input: ${waitingNames.join(", ")}\nClick for options`,
			);
		}
	}
}

export type AgentOutputMode = "new" | "new_or_modified" | "off";

interface BufferedEntry {
	kind: "created" | "modified";
	path: string;
}

const DEBOUNCE_MS = 2000;
const RATE_LIMIT_MS = 5000;

export class AgentOutputNotifier {
	private buffer: BufferedEntry[] = [];
	private debounceId: number | null = null;
	private lastNoticeAt = 0;

	constructor(
		private getMode: () => AgentOutputMode,
		private getWriteDir: () => string,
	) {}

	/** Feed `vault.on("create")` events. */
	onCreate(path: string): void {
		if (this.getMode() === "off") return;
		if (!this.pathInsideWriteDir(path)) return;
		this.enqueue({ kind: "created", path });
	}

	/** Feed `vault.on("modify")` events (only fires notices in "new_or_modified" mode). */
	onModify(path: string): void {
		if (this.getMode() !== "new_or_modified") return;
		if (!this.pathInsideWriteDir(path)) return;
		this.enqueue({ kind: "modified", path });
	}

	/** Cancel any pending debounce; call from plugin onunload. */
	dispose(): void {
		if (this.debounceId != null) {
			window.clearTimeout(this.debounceId);
			this.debounceId = null;
		}
		this.buffer = [];
	}

	private pathInsideWriteDir(path: string): boolean {
		const dir = this.getWriteDir() || "agent-workspace";
		return path === dir || path.startsWith(dir + "/");
	}

	private enqueue(entry: BufferedEntry): void {
		this.buffer.push(entry);
		if (this.debounceId != null) return;
		this.debounceId = window.setTimeout(() => {
			this.debounceId = null;
			this.flush();
		}, DEBOUNCE_MS);
	}

	private flush(): void {
		const buf = this.buffer;
		this.buffer = [];
		if (buf.length === 0) return;
		const now = Date.now();
		if (now - this.lastNoticeAt < RATE_LIMIT_MS) return;
		this.lastNoticeAt = now;
		if (buf.length === 1) {
			new Notice(`Agent ${buf[0].kind} ${buf[0].path}`, 5000);
			return;
		}
		const createdCount = buf.filter((e) => e.kind === "created").length;
		const modifiedCount = buf.length - createdCount;
		const parts: string[] = [];
		if (createdCount > 0) parts.push(`${createdCount} created`);
		if (modifiedCount > 0) parts.push(`${modifiedCount} modified`);
		new Notice(`Agent output: ${parts.join(", ")}`, 5000);
	}
}
