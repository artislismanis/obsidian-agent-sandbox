/**
 * Activity feedback + agent-output notice plumbing.
 *
 * Kept out of main.ts so the plugin entry doesn't carry per-session UI
 * routing and debounce state inline. Two small managers:
 *
 * - `ActivityUi` - wires MCP `agent_status_set` updates into per-tab tab-title
 *   prefixes and the aggregate status-bar attention badge.
 * - `AgentOutputNotifier` - watches vault creates/modifies under the write
 *   directory, debounces bursts, rate-limits, and surfaces an Obsidian Notice.
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { ActivityEntry } from "./mcp-server";
import type { StatusBarManager } from "./status-bar";
import type { ActivityPrefix, TerminalView } from "./terminal-view";
import { VIEW_TYPE_TERMINAL } from "./view-types";
import type { AgentStatus } from "./mcp-tools";
import { DEFAULT_SESSION_KEY } from "./mcp-tools";
import { isPathWithinDir } from "./validation";

/**
 * Structural-typed guard that doesn't import the TerminalView class - that
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
		// because ActivityUi has no Plugin reference - clear() owns cleanup.
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
			// views during plugin reload - `view` may not yet be a TerminalView.
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

interface BufferedEntry {
	kind: "created" | "modified" | "deleted" | "renamed";
	path: string;
}

const DEBOUNCE_MS = 2000;
const RATE_LIMIT_MS = 5000;
/** How long after a create to suppress a modify for the same path. */
const CREATE_MODIFY_SUPPRESS_MS = 3000;

export class AgentOutputNotifier {
	private buffer: BufferedEntry[] = [];
	/** Batch frozen at the rate-limit boundary, waiting for the next window. */
	private pendingBuffer: BufferedEntry[] = [];
	private debounceId: ReturnType<typeof setTimeout> | null = null;
	private lastNoticeAt = 0;
	/** Paths recently edited by the user in Obsidian - keyed to their expiry epoch ms. */
	private recentUserEdits = new Map<string, number>();
	/** Paths recently created by the agent - suppresses the modify that follows a create. */
	private recentlyCreated = new Map<string, number>();

	constructor(
		private getNotifyCreated: () => boolean,
		private getNotifyEdited: () => boolean,
		private getNotifyDeleted: () => boolean,
		private getNotifyRenamed: () => boolean,
		private getVaultWide: () => boolean,
		private getWriteDir: () => string,
		private getUserEditTtl: () => number,
	) {}

	/** Mark a path as recently edited by the user (suppresses notifications). */
	markUserEdit(path: string): void {
		this.recentUserEdits.set(path, Date.now() + this.getUserEditTtl() * 1000);
	}

	/** Feed `vault.on("create")` events. */
	onCreate(path: string): void {
		// Stamp before the guards so suppression applies regardless of notifyCreated state.
		this.recentlyCreated.set(path, Date.now() + CREATE_MODIFY_SUPPRESS_MS);
		if (!this.getNotifyCreated()) return;
		if (!this.pathInScope(path)) return;
		if (this.isRecentUserEdit(path)) return;
		this.enqueue({ kind: "created", path });
	}

	/** Feed `vault.on("modify")` events. */
	onModify(path: string): void {
		if (!this.getNotifyEdited()) return;
		if (!this.pathInScope(path)) return;
		if (this.isRecentUserEdit(path)) return;
		if (this.isRecentlyCreated(path)) return;
		this.enqueue({ kind: "modified", path });
	}

	/** Feed `vault.on("delete")` events. */
	onDelete(path: string): void {
		if (!this.getNotifyDeleted()) return;
		if (!this.pathInScope(path)) return;
		if (this.isRecentUserEdit(path)) return;
		this.enqueue({ kind: "deleted", path });
	}

	/** Feed `vault.on("rename")` events. */
	onRename(newPath: string, oldPath: string): void {
		if (!this.getNotifyRenamed()) return;
		if (!this.pathInScope(oldPath)) return;
		if (this.isRecentUserEdit(oldPath)) return;
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
		this.recentUserEdits.clear();
		this.recentlyCreated.clear();
	}

	private isRecentUserEdit(path: string): boolean {
		const expiry = this.recentUserEdits.get(path);
		if (expiry === undefined) return false;
		if (Date.now() >= expiry) {
			this.recentUserEdits.delete(path);
			return false;
		}
		return true;
	}

	private isRecentlyCreated(path: string): boolean {
		const expiry = this.recentlyCreated.get(path);
		if (expiry === undefined) return false;
		if (Date.now() >= expiry) {
			this.recentlyCreated.delete(path);
			return false;
		}
		return true;
	}

	private pathInScope(path: string): boolean {
		if (this.getVaultWide()) return true;
		// Empty vaultWriteDir fails closed - no path is considered in scope.
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
			// just append to this.buffer - they'll be picked up in the next
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
