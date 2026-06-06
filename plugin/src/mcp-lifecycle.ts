import type { App } from "obsidian";
import { Notice } from "obsidian";
import { ObsidianMcpServer } from "./mcp-server";
import type { ActivityEntry } from "./mcp-server";
import { DiffReviewModal, BatchReviewModal } from "./diff-review-modal";
import type { AgentSandboxSettings } from "./settings";
import { enabledTiersFromSettings } from "./settings";
import { reviewsRequired } from "./permission-tiers";
import type { OnActivity } from "./mcp-tools";
import { isValidPathPrefixList, splitCsv } from "./validation";
import { logger, errMsg } from "./logger";

interface McpLifecycleCallbacks {
	saveSettings: () => void;
	updateTooltip: () => void;
	onActivity: OnActivity;
	clearActivity: () => void;
}

export class McpLifecycle {
	private server: ObsidianMcpServer | null = null;
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly app: App,
		private readonly getSettings: () => AgentSandboxSettings,
		private readonly cb: McpLifecycleCallbacks,
	) {}

	isRunning(): boolean {
		return this.server?.isRunning() ?? false;
	}

	getActivity(): Map<string, ActivityEntry> {
		return this.server?.getActivity() ?? new Map();
	}

	getToolCount(): number {
		return this.server?.getToolCount() ?? 0;
	}

	toggle(): Promise<void> {
		return this.queueOp(async () => {
			if (this.server?.isRunning()) {
				await this.stopServer();
				this.getSettings().mcpEnabled = false;
				this.cb.saveSettings();
				new Notice("MCP server stopped.");
			} else {
				this.getSettings().mcpEnabled = true;
				this.cb.saveSettings();
				await this.startServer();
				if (this.server?.isRunning()) {
					new Notice(`MCP server listening on port ${this.getSettings().mcpPort}.`);
				}
			}
			this.cb.updateTooltip();
		});
	}

	async applyEnabled(enabled: boolean): Promise<void> {
		await this.queueOp(async () => {
			if (enabled && !this.server?.isRunning()) {
				await this.startServer();
			} else if (!enabled && this.server?.isRunning()) {
				await this.stopServer();
			}
			this.cb.updateTooltip();
		});
	}

	// Reconciles the server to the desired state (mcpEnabled), not just the
	// current one: if enabled but not running (e.g. a prior start failed), this
	// recovers it. Called after any hot-swappable MCP setting changes.
	async restartIfRunning(): Promise<void> {
		await this.queueOp(async () => {
			if (!this.getSettings().mcpEnabled) return;
			if (this.server?.isRunning()) await this.stopServer();
			await this.startServer();
		});
	}

	async shutdown(): Promise<void> {
		await this.queue.catch((e) =>
			logger.warn("Plugin", "Pending MCP queue op rejected during unload", e),
		);
		await this.server
			?.stop()
			.catch((e) => logger.warn("Plugin", "MCP stop during unload failed", e));
	}

	private async queueOp(op: () => Promise<void>): Promise<void> {
		const next = this.queue.then(op, op);
		this.queue = next;
		return next;
	}

	private async startServer(): Promise<void> {
		if (this.server?.isRunning()) return;
		const settings = this.getSettings();
		try {
			if (!isValidPathPrefixList(settings.mcpPathAllowlist ?? "")) {
				throw new Error(
					"Invalid mcpPathAllowlist in settings. Use comma-separated path prefixes (e.g. 'notes/, archive/').",
				);
			}
			if (!isValidPathPrefixList(settings.mcpPathBlocklist ?? "")) {
				throw new Error(
					"Invalid mcpPathBlocklist in settings. Use comma-separated path prefixes.",
				);
			}
			const allowlist = splitCsv(settings.mcpPathAllowlist);
			const configDir = this.app.vault.configDir;
			const effectiveBlocklist = [configDir, ...splitCsv(settings.mcpPathBlocklist)];
			this.server = new ObsidianMcpServer(this.app, {
				port: settings.mcpPort,
				bindAddress: settings.mcpBindAddress,
				token: settings.mcpToken,
				enabledTiers: enabledTiersFromSettings(settings),
				getWriteDir: () => this.getSettings().vaultWriteDir,
				pathFilter: {
					allowlist,
					blocklist: effectiveBlocklist,
					getWriteDir: () => this.getSettings().vaultWriteDir,
					defaultDeny: settings.mcpDefaultDeny === true,
				},
				hooks: {
					review: reviewsRequired(settings.mcpVaultWrites)
						? async (req) => new DiffReviewModal(this.app, req).review()
						: undefined,
					reviewBatch: reviewsRequired(settings.mcpVaultWrites)
						? async (req) => new BatchReviewModal(this.app, req).review()
						: undefined,
					onActivity: (update) => this.cb.onActivity(update),
				},
				toolTimeoutMs: settings.mcpToolTimeout * 1000,
				reviewTimeoutMs: settings.mcpReviewTimeout * 1000,
			});
			await this.server.start();
		} catch (error: unknown) {
			try {
				await this.server?.stop();
			} catch {
				/* nothing usable started */
			}
			this.server = null;
			// Leave mcpEnabled untouched: it records user intent, not runtime
			// state. A transient start failure (e.g. a bad bind address or a
			// socket still closing from the previous stop) must not silently
			// flip and persist the toggle off. The next reconcile retries.
			new Notice(`MCP server failed to start: ${errMsg(error)}`);
		}
	}

	private async stopServer(): Promise<void> {
		if (!this.server) return;
		await this.server.stop();
		this.server = null;
		this.cb.clearActivity();
	}
}
