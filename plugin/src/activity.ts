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
import { VIEW_TYPE_TERMINAL } from "./view-types";

/**
 * Structural-typed guard that doesn't import the TerminalView class — that
 * import would pull xterm.js into the (jsdom-free) unit test bundle. Checks
 * both the leaf's view-type and the required methods; a placeholder /
 * deferred view returned by Obsidian during reload satisfies neither.
 */
function isTerminalViewLike(leafView: unknown): leafView is TerminalView {
	if (!leafView || typeof leafView !== "object") return false;
	const v = leafView as {
		getViewType?: () => string;
		getSessionName?: unknown;
		setActivityPrefix?: unknown;
	};
	return (
		typeof v.getViewType === "function" &&
		v.getViewType() === VIEW_TYPE_TERMINAL &&
		typeof v.getSessionName === "function" &&
		typeof v.setActivityPrefix === "function"
	);
}
import type { AgentStatus } from "./mcp-tools";
import { isPathWithinDir } from "./validation";

import { DEFAULT_SESSION_KEY } from "./mcp-tools";

const STATUS_TO_PREFIX: Record<AgentStatus, ActivityPrefix> = {
	working: "working",
	awaiting_input: "awaiting_input",
	idle: null,
};

export interface ActivityUpdate {
	sessionName: string;
	status: AgentStatus;
	detail?: string;
}

// How often to re-evaluate stale-rolling: getActivity() rolls "working" → "idle"
// after 10 min of no updates, but the UI only refreshes on incoming routes. A
// silent session needs this tick to clear its prefix and badge.
const STALE_TICK_MS = 60_000;

export class ActivityUi {
	private staleTickId: ReturnType<typeof setInterval> | null = null;

	constructor(
		private app: App,
		private statusBar: StatusBarManager,
		private getActivity: () => ReadonlyMap<string, ActivityEntry> | undefined,
	) {
		// Wrap tickStale in try/catch so a late tick after teardown can't
		// propagate as an unhandled error against stale `this.app` /
		// `this.statusBar` refs. Raw setInterval (not Plugin.registerInterval)
		// because ActivityUi has no Plugin reference — clear() owns cleanup.
		this.staleTickId = setInterval(() => {
			try {
				this.tickStale();
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn("[Agent Sandbox] [ActivityUi] tickStale failed:", e);
			}
		}, STALE_TICK_MS);
	}

	route(update: ActivityUpdate): void {
		const prefix = STATUS_TO_PREFIX[update.status];

		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			if (!isTerminalViewLike(leaf.view)) continue;
			const view = leaf.view;
			const sessionKey = view.getSessionName() ?? DEFAULT_SESSION_KEY;
			if (sessionKey === update.sessionName) {
				view.setActivityPrefix(prefix);
			}
		}

		this.refreshAttentionBadge();
	}

	/**
	 * Re-route prefixes for all known sessions based on the current (rolled)
	 * activity map. Catches "working" → "idle" transitions caused by staleness
	 * rather than an explicit status update.
	 */
	private tickStale(): void {
		const activity = this.getActivity();
		if (!activity) return;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			// Defensive: getLeavesOfType normally only returns matching views,
			// but Obsidian has been observed to surface deferred / placeholder
			// views during plugin reload — `view` may not yet be a TerminalView.
			if (!isTerminalViewLike(leaf.view)) continue;
			const view = leaf.view;
			const key = view.getSessionName() ?? DEFAULT_SESSION_KEY;
			const entry = activity.get(key);
			view.setActivityPrefix(entry ? STATUS_TO_PREFIX[entry.status] : null);
		}
		this.refreshAttentionBadge();
	}

	clear(): void {
		if (this.staleTickId != null) {
			clearInterval(this.staleTickId);
			this.staleTickId = null;
		}
		this.statusBar.setAttention(0);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			if (isTerminalViewLike(leaf.view)) leaf.view.setActivityPrefix(null);
		}
	}

	private computeWaiting(): { count: number; names: string[] } {
		const activity = this.getActivity();
		if (!activity) return { count: 0, names: [] };
		const names: string[] = [];
		for (const [name, entry] of activity) {
			if (entry.status === "awaiting_input") {
				names.push(name === DEFAULT_SESSION_KEY ? "(unnamed)" : name);
			}
		}
		return { count: names.length, names };
	}

	private refreshAttentionBadge(): void {
		const { count, names } = this.computeWaiting();
		this.statusBar.setAttention(count, names);
	}
}

/** Kept for migration only — maps old enum to new per-event booleans. */
export type AgentOutputMode = "new" | "new_or_modified" | "off";

interface BufferedEntry {
	kind: "created" | "modified" | "deleted" | "renamed";
	path: string;
}

const DEBOUNCE_MS = 2000;
const RATE_LIMIT_MS = 5000;
// How long a path stays in the "recently written by MCP" set before expiring.
const MCP_WRITE_TTL_MS = 5000;

export class AgentOutputNotifier {
	private buffer: BufferedEntry[] = [];
	/** Batch frozen at the rate-limit boundary, waiting for the next window. */
	private pendingBuffer: BufferedEntry[] = [];
	private debounceId: ReturnType<typeof setTimeout> | null = null;
	private lastNoticeAt = 0;
	/** Paths recently written via MCP tools — keyed to their expiry epoch ms. */
	private recentMcpWrites = new Map<string, number>();

	constructor(
		private getNotifyCreated: () => boolean,
		private getNotifyEdited: () => boolean,
		private getNotifyDeleted: () => boolean,
		private getNotifyRenamed: () => boolean,
		private getVaultWide: () => boolean,
		private getWriteDir: () => string,
	) {}

	/**
	 * Called by MCP write tool handlers immediately before a vault write so
	 * the subsequent vault event can be identified as agent-originated.
	 */
	markMcpWrite(path: string): void {
		this.recentMcpWrites.set(path, Date.now() + MCP_WRITE_TTL_MS);
	}

	/** Feed `vault.on("create")` events. */
	onCreate(path: string): void {
		if (!this.getNotifyCreated()) return;
		if (!this.pathInScope(path)) return;
		if (!this.isRecentMcpWrite(path)) return;
		this.enqueue({ kind: "created", path });
	}

	/** Feed `vault.on("modify")` events. */
	onModify(path: string): void {
		if (!this.getNotifyEdited()) return;
		if (!this.pathInScope(path)) return;
		if (!this.isRecentMcpWrite(path)) return;
		this.enqueue({ kind: "modified", path });
	}

	/** Feed `vault.on("delete")` events. */
	onDelete(path: string): void {
		if (!this.getNotifyDeleted()) return;
		if (!this.pathInScope(path)) return;
		if (!this.isRecentMcpWrite(path)) return;
		this.enqueue({ kind: "deleted", path });
	}

	/** Feed `vault.on("rename")` events. */
	onRename(newPath: string, oldPath: string): void {
		if (!this.getNotifyRenamed()) return;
		// Check old path for scope — that's where the file lived.
		if (!this.pathInScope(oldPath)) return;
		if (!this.isRecentMcpWrite(oldPath)) return;
		this.enqueue({ kind: "renamed", path: `${oldPath} → ${newPath}` });
	}

	/** Cancel any pending debounce; call from plugin onunload. */
	dispose(): void {
		if (this.debounceId != null) {
			clearTimeout(this.debounceId);
			this.debounceId = null;
		}
		this.buffer = [];
		this.pendingBuffer = [];
		this.recentMcpWrites.clear();
	}

	private isRecentMcpWrite(path: string): boolean {
		const expiry = this.recentMcpWrites.get(path);
		if (expiry === undefined) return false;
		if (Date.now() >= expiry) {
			this.recentMcpWrites.delete(path);
			return false;
		}
		return true;
	}

	private pathInScope(path: string): boolean {
		// When vault-wide is on, every path passes.
		if (this.getVaultWide()) return true;
		// Mirror the writeScoped MCP gate: when `vaultWriteDir` is cleared,
		// it fail-closes, so no path counts as inside and notifications
		// stay silent rather than firing for a fallback path.
		return isPathWithinDir(path, this.getWriteDir());
	}

	private enqueue(entry: BufferedEntry): void {
		this.buffer.push(entry);
		if (this.debounceId != null) return;
		this.debounceId = setTimeout(() => {
			this.debounceId = null;
			this.flush();
		}, DEBOUNCE_MS);
	}

	private flush(): void {
		if (this.buffer.length === 0) return;
		const now = Date.now();
		const sinceLast = now - this.lastNoticeAt;
		if (sinceLast < RATE_LIMIT_MS) {
			// Freeze the current batch so new events arriving during the wait
			// don't mix into this notice. The debounce timer becomes the
			// rate-limit hold timer; new enqueue() calls see it non-null and
			// just append to this.buffer — they'll be picked up in the next
			// window via the recursive flush() below.
			this.pendingBuffer = [...this.pendingBuffer, ...this.buffer];
			this.buffer = [];
			this.debounceId = setTimeout(() => {
				this.debounceId = null;
				this.flushPending();
			}, RATE_LIMIT_MS - sinceLast);
			return;
		}
		const buf = this.buffer;
		this.buffer = [];
		this.lastNoticeAt = now;
		this.emitBatch(buf);
	}

	private flushPending(): void {
		if (this.pendingBuffer.length === 0) {
			// Nothing to emit for the frozen batch; try current buffer instead.
			this.flush();
			return;
		}
		const buf = this.pendingBuffer;
		this.pendingBuffer = [];
		this.lastNoticeAt = Date.now();
		this.emitBatch(buf);
		// If new events arrived during the hold, start a fresh debounce for them.
		if (this.buffer.length > 0) {
			this.debounceId = setTimeout(() => {
				this.debounceId = null;
				this.flush();
			}, DEBOUNCE_MS);
		}
	}

	private emitBatch(buf: BufferedEntry[]): void {
		if (buf.length === 1) {
			new Notice(`Agent ${buf[0].kind} ${buf[0].path}`, 5000);
			return;
		}
		const counts: Partial<Record<BufferedEntry["kind"], number>> = {};
		for (const e of buf) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
		const parts: string[] = [];
		if (counts.created) parts.push(`${counts.created} created`);
		if (counts.modified) parts.push(`${counts.modified} modified`);
		if (counts.deleted) parts.push(`${counts.deleted} deleted`);
		if (counts.renamed) parts.push(`${counts.renamed} renamed`);
		new Notice(`Agent output: ${parts.join(", ")}`, 5000);
	}
}
