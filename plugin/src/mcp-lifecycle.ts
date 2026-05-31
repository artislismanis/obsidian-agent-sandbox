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
	onMcpWrite: (path: string) => void;
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

	async restartIfRunning(): Promise<void> {
		await this.queueOp(async () => {
			if (!this.server?.isRunning()) return;
			await this.stopServer();
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
			// configDir (.obsidian/) is prepended by default (#124) unless the
			// user has explicitly disabled the block via mcpBlockConfigDir.
			// Users can also override a specific subtree with a more-specific
			// allow entry (e.g. ".obsidian/plugins/my-plugin/") while keeping
			// the rest blocked — most-specific-prefix wins in isPathAllowed.
			const configDir = this.app.vault.configDir;
			const effectiveBlocklist = [
				...(settings.mcpBlockConfigDir !== false ? [configDir] : []),
				...splitCsv(settings.mcpPathBlocklist),
			];
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
				},
				hooks: {
					review: reviewsRequired(settings.mcpVaultWrites)
						? async (req) => new DiffReviewModal(this.app, req).review()
						: undefined,
					reviewBatch: reviewsRequired(settings.mcpVaultWrites)
						? async (req) => new BatchReviewModal(this.app, req).review()
						: undefined,
					onActivity: (update) => this.cb.onActivity(update),
					onMcpWrite: (path) => this.cb.onMcpWrite(path),
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
			if (this.getSettings().mcpEnabled) {
				this.getSettings().mcpEnabled = false;
				this.cb.saveSettings();
			}
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
