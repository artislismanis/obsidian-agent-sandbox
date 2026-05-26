import type { TFile, WorkspaceLeaf } from "obsidian";
import { Menu, Notice, Plugin, debounce } from "obsidian";
import { getVaultBasePath } from "./obsidian-internals";
import { confirmModal, inputModal } from "./modals";
import { AnalyzeManager } from "./analyze";
import { type AgentSandboxSettings, DEFAULT_SETTINGS, AgentSandboxSettingTab } from "./settings";
import { DockerManager } from "./docker";
import type { ContainerState } from "./status-bar";
import { FirewallStatusBar, StatusBarManager } from "./status-bar";
import {
	TerminalView,
	VIEW_TYPE_TERMINAL,
	formatConnectionLog,
	getTerminalConnectionLog,
	resetTerminalConnectionLog,
} from "./terminal-view";
import { isValidWriteDir } from "./validation";
import { pollUntilReady, resolveTtydBrowserUrl } from "./ttyd-client";
import { setLogLevel, logger, errMsg } from "./logger";
import { generateToken } from "./mcp-server";
import { McpLifecycle } from "./mcp-lifecycle";
import { ActivityUi, AgentOutputNotifier } from "./activity";
import { showSessionCleanup, showSessionPicker } from "./session-ui";
import { resetTemplaterSuppression } from "./templater-adapter";
import { formatUptime } from "./format";

const TOOLTIP_STOPPED = "Container is not running\nClick for options";
const HEALTH_POLL_INTERVAL = 30_000;
// Long safety-net poll — firewall can be toggled out-of-band (user runs
// init-firewall.sh in the container) and event-driven refreshes can miss it.
const FIREWALL_REFRESH_INTERVAL = 5 * 60_000;
const FIREWALL_EVENT_THROTTLE = 10_000;

export default class AgentSandboxPlugin extends Plugin {
	settings: AgentSandboxSettings = { ...DEFAULT_SETTINGS };
	// `!` definite-assignment: onload assigns each field synchronously
	// before any await, so all later code paths (including onunload) see
	// them initialized. The `?.` in onunload is defensive against a future
	// refactor that hoists an `await` between declaration and assignment.
	private docker!: DockerManager;
	private statusBar!: StatusBarManager;
	private firewallBar!: FirewallStatusBar;
	private healthPollId: number | null = null;
	private firewallPollId: number | null = null;
	private lastFirewallRefreshAt = 0;
	private mcpLifecycle!: McpLifecycle;
	private layoutReadyHandled = false;
	private lastKnownContainerId: string = "";
	private activityUi!: ActivityUi;
	private agentOutput!: AgentOutputNotifier;
	private analyze!: AnalyzeManager;

	private debouncedSaveSettings = debounce(
		async () => {
			try {
				await this.saveData(this.settings);
			} catch (e) {
				// debounce doesn't surface the inner promise, so saveData
				// rejections (disk full, permission glitch on data.json) would
				// silently vanish — the UI shows the change "stuck" but the
				// next reload loses it.
				logger.error("Plugin", "Settings save failed", e);
				new Notice(`Failed to save settings: ${errMsg(e)}`);
			}
		},
		500,
		true,
	);

	async onload() {
		// Module-level state in terminal-view.ts (ring buffer + instance
		// counter) and templater-adapter.ts (hook-suppression refcount)
		// survives plugin disable/enable — Obsidian caches the module. Reset
		// on each load so postmortems don't include events from a previous
		// lifecycle, and so a previous mid-write unload doesn't leave
		// Templater's trigger_on_file_creation pinned to false.
		resetTerminalConnectionLog();
		resetTemplaterSuppression();
		await this.loadSettings();
		this.addSettingTab(new AgentSandboxSettingTab(this.app, this));

		this.docker = new DockerManager(() => {
			const _vp = getVaultBasePath(this.app);
			logger.info(
				"Docker",
				`vaultPath probe: type=${typeof _vp} value=${JSON.stringify(_vp)} adapter=${this.app.vault.adapter?.constructor?.name}`,
			);
			return {
				dockerMode: this.settings.dockerMode,
				composePath: this.settings.dockerComposeFilePath,
				wslDistro: this.settings.wslDistroName || "Ubuntu",
				vaultPath: _vp ?? undefined,
				writeDir: this.settings.vaultWriteDir,
				memoryFileName: this.settings.memoryFileName,
				ttydPort: this.settings.ttydPort,
				ttydBindAddress: this.settings.ttydBindAddress,
				allowedPrivateHosts: this.settings.allowedPrivateHosts,
				additionalFirewallDomains: this.settings.additionalFirewallDomains,
				containerMemory: this.settings.containerMemory,
				containerCpus: this.settings.containerCpus,
				sudoPassword: this.settings.sudoPassword,
				mcpToken: this.settings.mcpEnabled ? this.settings.mcpToken : undefined,
				mcpPort: this.settings.mcpEnabled ? this.settings.mcpPort : undefined,
			};
		});

		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new StatusBarManager(statusBarEl);
		this.statusBar.setDetails(TOOLTIP_STOPPED);
		this.registerDomEvent(statusBarEl, "click", (evt) => void this.showStatusMenu(evt));

		this.mcpLifecycle = new McpLifecycle(this.app, () => this.settings, {
			saveSettings: () => this.saveSettings(),
			updateTooltip: () => this.updateTooltip(),
			onActivity: (update) => this.activityUi.route(update),
			clearActivity: () => this.activityUi.clear(),
		});
		this.activityUi = new ActivityUi(this.app, this.statusBar, () =>
			this.mcpLifecycle.getActivity(),
		);
		this.agentOutput = new AgentOutputNotifier(
			() => this.settings.agentOutputNotify,
			() => this.settings.vaultWriteDir,
		);
		this.analyze = new AnalyzeManager({
			app: this.app,
			isContainerRunning: () => this.isContainerRunning(),
			activateTerminalView: (sessionName, initialPrompt) =>
				this.activateTerminalView(sessionName, initialPrompt),
		});
		void this.analyze
			.prewarm()
			.catch((err) => logger.warn("Plugin", `Template prewarm failed: ${errMsg(err)}`));

		const fwBarEl = this.addStatusBarItem();
		this.firewallBar = new FirewallStatusBar(
			fwBarEl,
			this.safeFire("Toggle firewall", () => this.toggleFirewall()),
		);

		this.registerDomEvent(fwBarEl, "mouseenter", () => this.maybeRefreshFirewall());
		this.registerDomEvent(window, "focus", () => this.maybeRefreshFirewall());

		this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
			const view = new TerminalView(leaf, () => ({
				ttydPort: this.settings.ttydPort,
				ttydBindAddress: this.settings.ttydBindAddress,
				terminalTheme: this.settings.terminalTheme,
				terminalFont: this.settings.terminalFont,
				terminalFontSize: this.settings.terminalFontSize,
				terminalScrollback: this.settings.terminalScrollback,
				clipboardAutoCopy: this.settings.clipboardAutoCopy,
			}));
			view.onRenameSession = async () => {
				const oldName = (view.getState().sessionName as string) ?? "";
				const newName = await this.promptSessionName("Rename Session", oldName);
				if (!newName || newName === oldName) return;
				if (oldName) {
					try {
						await this.docker.renameSession(oldName, newName);
					} catch (e) {
						logger.error("Plugin", "renameSession failed", e);
						// Surface the real cause (validation message, tmux state,
						// docker error) instead of a generic "Failed" that
						// forces the user to open dev tools.
						new Notice(`Failed to rename tmux session: ${errMsg(e)}`);
						return;
					}
				}
				await leaf.setViewState({
					type: VIEW_TYPE_TERMINAL,
					state: { sessionName: newName },
				});
			};
			return view;
		});

		this.app.workspace.onLayoutReady(() => {
			// onLayoutReady can fire more than once across rapid disable/enable
			// cycles in Obsidian — re-fires have been observed when the plugin
			// re-registers during a layout transition. A double
			// backgroundStartup races docker probe and status-bar state, so
			// guard with a one-shot flag.
			if (this.layoutReadyHandled) return;
			this.layoutReadyHandled = true;
			void this.backgroundStartup();
		});

		// "box" represents the sandbox concept; the terminal tab and
		// command-palette entry use TerminalView.getIcon()'s "terminal" glyph
		// for the action itself.
		this.addRibbonIcon("box", "Open Sandbox Terminal", () => {
			void this.openTerminalOrPromptStart();
		});

		this.addCommand({
			id: "open-claude-terminal",
			name: "Open Sandbox Terminal",
			callback: () => {
				void this.openTerminalOrPromptStart();
			},
		});

		this.addCommand({
			id: "sandbox-start-container",
			name: "Sandbox: Start Container",
			callback: this.safeFire("Start container", () => this.startContainer()),
		});

		this.addCommand({
			id: "sandbox-stop-container",
			name: "Sandbox: Stop Container",
			callback: this.safeFire("Stop container", () => this.stopContainer()),
		});

		this.addCommand({
			id: "sandbox-container-status",
			name: "Sandbox: Container Status",
			callback: this.safeFire("Container status", () => this.containerStatus()),
		});

		this.addCommand({
			id: "sandbox-restart-container",
			name: "Sandbox: Restart Container",
			callback: this.safeFire("Restart container", () => this.restartContainer()),
		});

		this.addCommand({
			id: "sandbox-toggle-firewall",
			name: "Sandbox: Toggle Firewall",
			callback: this.safeFire("Toggle firewall", () => this.toggleFirewall()),
		});

		this.addCommand({
			id: "open-session",
			name: "Open Sandbox Session...",
			callback: async () => {
				const name = await this.promptSessionName("New Session");
				if (name) void this.activateTerminalView(name);
			},
		});

		this.addCommand({
			id: "open-browser",
			name: "Open Sandbox in Browser",
			callback: () => {
				window.open(
					resolveTtydBrowserUrl(this.settings.ttydPort, this.settings.ttydBindAddress),
				);
			},
		});

		this.addCommand({
			id: "sandbox-toggle-mcp",
			name: "Sandbox: Toggle MCP Server",
			callback: this.safeFire("Toggle MCP server", () => this.mcpLifecycle.toggle()),
		});

		this.addCommand({
			id: "sandbox-copy-terminal-connection-log",
			name: "Sandbox: Copy terminal connection log",
			callback: async () => {
				const events = getTerminalConnectionLog();
				if (events.length === 0) {
					new Notice("No terminal connection events recorded yet.");
					return;
				}
				const text = formatConnectionLog(events);
				// Log to dev console first so postmortem data is recoverable
				// even when the clipboard write rejects (document not focused,
				// clipboard API disabled).
				logger.info("Terminal", `Connection log (${events.length} events):\n${text}`);
				try {
					await navigator.clipboard.writeText(text);
					new Notice(`Copied ${events.length} terminal connection events to clipboard.`);
				} catch (e) {
					logger.error("Terminal", "Clipboard write failed", e);
					new Notice(
						`Could not copy to clipboard: ${errMsg(e)}. See developer console for the log content.`,
					);
				}
			},
		});

		this.addCommand({
			id: "sandbox-cleanup-sessions",
			name: "Sandbox: Clean up empty sessions",
			callback: () =>
				void showSessionCleanup(
					this.app,
					{
						listEmptySessions: () => this.docker.listEmptySessions(),
						killSession: (name) => this.docker.killSession(name),
					},
					() => this.isContainerRunning(),
				),
		});

		// obsidian://agent-sandbox/open-terminal — activate or open a terminal tab
		this.registerObsidianProtocolHandler("agent-sandbox/open-terminal", async () => {
			try {
				if (!this.isContainerRunning()) {
					new Notice("Sandbox container is not running.");
					return;
				}
				await this.activateTerminalView();
			} catch (e) {
				logger.error("Plugin", "agent-sandbox/open-terminal handler failed", e);
				new Notice(`Open terminal failed: ${errMsg(e)}`);
			}
		});

		// obsidian://agent-sandbox/analyze?path=<vault/path>&template=<name>
		this.registerObsidianProtocolHandler("agent-sandbox/analyze", async (params) => {
			try {
				const path = params.path;
				if (!path) {
					new Notice("Analyze: missing 'path' parameter.");
					return;
				}
				await this.analyze.runAnalyze(path, params.template);
			} catch (e) {
				// Obsidian's protocol-handler dispatcher swallows unhandled
				// rejections silently — external tooling triggering this URI
				// would see no visible failure (e.g. template load throws).
				logger.error("Plugin", "agent-sandbox/analyze handler failed", e);
				new Notice(`Analyze failed: ${errMsg(e)}`);
			}
		});

		// File context menu → "Analyze in Sandbox" submenu
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!("extension" in file)) return;
				this.analyze.attachFileMenu(menu, file as TFile);
			}),
		);

		if (this.settings.mcpEnabled) {
			void this.mcpLifecycle.applyEnabled(true);
		}

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!("extension" in file)) return;
				this.agentOutput.onCreate(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => this.agentOutput.onModify(file.path)),
		);

		// Quick-Switcher-style picker for open sandbox sessions
		this.addCommand({
			id: "sandbox-switch-session",
			name: "Sandbox: Switch to Sandbox session…",
			callback: () => showSessionPicker(this.app),
		});

		// onunload fires on plugin disable but not on app exit, so register a quit
		// handler to stop the container when Obsidian is closing.
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				if (this.settings.autoStopContainer) {
					tasks.add(async () => {
						if (this.docker.isBusy()) {
							this.docker.stopDetached();
							return;
						}
						// Promise.race: whichever of (docker stop) or (5s timer)
						// resolves first wins. The losing branch keeps running —
						// docker stop continues in the background and the timer
						// leaks until GC. AbortController would only cancel the
						// timer, not the child_process.exec inside
						// DockerManager.stop(); quit races Obsidian shutdown anyway.
						await Promise.race([
							this.docker.stop().catch((err) => {
								logger.warn(
									"Plugin",
									`Docker stop during quit failed: ${errMsg(err)}`,
								);
							}),
							new Promise((r) => setTimeout(r, 5000)),
						]);
					});
				}
			}),
		);
	}

	async onunload(): Promise<void> {
		this.stopHealthPoll();
		// Order is load-bearing:
		// 1. Stop MCP first so no onActivity events fire after the UI sinks
		//    are torn down — otherwise in-flight tool calls fire activity
		//    events into a cleared UI.
		// 2. Dispose AgentOutputNotifier and clear ActivityUi.
		// 3. Persist settings.
		// 4. Detach terminal leaves last (TerminalView.onClose may log a
		//    final activity event before the MCP server is gone).
		// The 2s race inside mcpServer.stop() bounds worst-case wait.
		// Drain queued ops and stop server — shutdown() flushes the queue first
		// so a toggle/restart enqueued just before unload can't construct a
		// fresh server after stop() returns.
		await this.mcpLifecycle?.shutdown();
		this.agentOutput?.dispose();
		// ActivityUi holds a setInterval for the stale-rolling tick — clear()
		// drops it. Idempotent.
		this.activityUi?.clear();
		// Cancel any pending debounced save so the explicit one below isn't
		// overwritten by a stale trailing call. Await the explicit save before
		// returning so a fast disable+quit doesn't lose recent settings changes.
		this.debouncedSaveSettings.cancel?.();
		await this.saveData(this.settings).catch((e) =>
			logger.error("Plugin", "Save on unload failed", e),
		);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
		this.firewallBar?.destroy();

		// Plugin disable always stops the container — `autoStopContainer`
		// only governs the Obsidian-exit ("quit") path above. Disable is an
		// explicit user action; leaving the container up would surprise
		// users reaching for the toggle to release docker resources.
		this.docker?.stopDetached();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		let needsSave = false;
		// One-shot migration: "none" was renamed to "scoped" to match the tier vocabulary.
		if ((this.settings.mcpVaultWrites as string) === "none") {
			this.settings.mcpVaultWrites = "scoped";
			needsSave = true;
		}
		if (!this.settings.mcpToken) {
			this.settings.mcpToken = generateToken();
			needsSave = true;
		}
		if (needsSave) {
			// Guard the save so a disk/permission failure on first install
			// doesn't abort onload — the unhandled reject would make the
			// plugin appear to "not load" with no visible error.
			try {
				await this.saveData(this.settings);
			} catch (e) {
				logger.error(
					"Plugin",
					"Could not persist settings migration; changes may not persist",
					e,
				);
				new Notice(
					"Could not save plugin settings; MCP token will not persist across restarts.",
				);
			}
		}
		setLogLevel(this.settings.logLevel);
	}

	saveSettings() {
		this.debouncedSaveSettings();
	}

	isContainerRunning(): boolean {
		return this.statusBar.getState() === "running";
	}

	async firewallSources(): Promise<string> {
		return this.docker.firewallSources();
	}

	/**
	 * Wrap an async handler so any unhandled rejection becomes a user-visible
	 * Notice instead of a silent dev-console entry. Use for command and menu
	 * callbacks where the registration site only accepts `() => void`.
	 *
	 * Most action methods wrap their work in try/catch + Notice, but a
	 * pre-condition (guardBusy, settings access) that throws outside those
	 * handlers escapes, and Obsidian discards the rejection without surfacing
	 * anything. This wrapper closes that gap.
	 */
	private safeFire(label: string, fn: () => Promise<unknown>): () => void {
		return () => {
			void fn().catch((err: unknown) => {
				logger.error("Plugin", `${label} failed`, err);
				new Notice(`${label}: ${errMsg(err)}`);
			});
		};
	}

	private async openTerminalOrPromptStart(): Promise<void> {
		if (this.isContainerRunning()) {
			await this.activateTerminalView();
			return;
		}
		const confirmed = await confirmModal(this.app, {
			title: "Start Container?",
			message: "The container is not running. Start it now?",
			ctaLabel: "Start",
		});
		if (!confirmed) return;
		logger.info("Plugin", "Auto-starting container from terminal prompt");
		await this.startContainer();
		if (this.isContainerRunning()) {
			logger.info("Plugin", "Container started — opening terminal");
			await this.activateTerminalView();
		} else {
			logger.warn("Plugin", "Container not running after startContainer — skipping terminal");
		}
	}

	async activateTerminalView(
		sessionName?: string,
		initialPrompt?: string,
	): Promise<TerminalView | null> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
			state: sessionName ? { sessionName } : {},
		});
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view instanceof TerminalView ? leaf.view : null;
		if (view && initialPrompt) view.queueInitialPrompt(initialPrompt);
		return view;
	}

	// ── Container actions ──────────────────────────────────

	private guardBusy(): boolean {
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return true;
		}
		return false;
	}

	private async startContainer(): Promise<void> {
		if (this.guardBusy()) return;
		let conflicts = await this.checkStartupPortConflicts();
		if (conflicts.length > 0) {
			// A prior `docker compose down` may still be tearing the container
			// down — it no longer reports as "running" but the host port
			// mapping is still held. Treat any compose-managed container as
			// ours so cleanup finishes before retrying.
			const isRunning = await this.docker.probeIsRunning();
			const hasContainer = isRunning || (await this.docker.hasAnyContainer());
			if (hasContainer) {
				logger.info(
					"Plugin",
					`Port conflict from ${isRunning ? "running" : "half-stopped"} sandbox container — running compose down before retry`,
				);
				this.statusBar.setState("starting");
				this.statusBar.setDetails(
					"Waiting for previous container to shut down before starting...",
				);
				new Notice("Cleaning up previous sandbox container...");
				try {
					await this.docker.stop();
				} catch (error: unknown) {
					logger.warn(
						"Plugin",
						"compose down during port-conflict recovery failed",
						error,
					);
				}
				conflicts = await this.checkStartupPortConflicts();
				if (conflicts.length > 0) {
					this.statusBar.setState("stopped");
					this.statusBar.setDetails(TOOLTIP_STOPPED);
				}
			}
			if (conflicts.length > 0) {
				new Notice(
					`Port conflict: ${conflicts.join(", ")} already in use on ${this.settings.ttydBindAddress || "127.0.0.1"}. Stop the other process or change the port in settings.`,
					10000,
				);
				return;
			}
		}
		const ok = await this.runDockerCommand({
			preState: "starting",
			action: async () => {
				await this.ensureWriteDir();
				return this.docker.start();
			},
			postState: "running",
			successMsg: "Sandbox container started.",
			failurePrefix: "Failed to start container",
		});
		if (ok) await this.postStartTasks();
	}

	private async postStartTasks(): Promise<void> {
		try {
			this.lastKnownContainerId = await this.docker.getContainerId();
		} catch (err) {
			// A probe failure here doesn't block startup — it just loses the
			// drift-detection baseline for this session. Logging keeps it
			// observable; checkContainerIdDrift handles its own probe failure.
			logger.warn("Plugin", "Initial container-id probe failed", err);
			this.lastKnownContainerId = "";
		}
		await this.applyFirewallAfterStart();
		this.startHealthPoll();
		await this.checkTtydReachability();
	}

	private async checkTtydReachability(): Promise<void> {
		const { ttydPort, ttydBindAddress } = this.settings;
		const reached = await pollUntilReady(
			ttydPort,
			3,
			(i) => [500, 1500, 2500][i] ?? 2500,
			() => false,
			undefined,
			ttydBindAddress,
		);
		if (!reached) {
			const bind = ttydBindAddress || "127.0.0.1";
			new Notice(
				`Sandbox started but terminal isn't reachable on ${bind}:${ttydPort}. Check for a port conflict or run 'docker compose logs' to investigate.`,
				10000,
			);
		}
	}

	private async stopContainer(): Promise<void> {
		if (this.guardBusy()) return;
		await this.runDockerCommand({
			action: () => this.docker.stop(),
			postState: "stopped",
			successMsg: "Sandbox container stopped.",
			failurePrefix: "Failed to stop container",
		});
		this.firewallBar.setState("hidden");
		this.statusBar.setDetails(TOOLTIP_STOPPED);
		this.stopHealthPoll();
		this.lastKnownContainerId = "";
	}

	async restartContainer(): Promise<void> {
		if (this.guardBusy()) return;
		const ok = await this.runDockerCommand({
			preState: "starting",
			action: () => this.docker.restart(),
			postState: "running",
			successMsg: "Sandbox container restarted.",
			failurePrefix: "Failed to restart container",
		});
		if (ok) await this.postStartTasks();
	}

	private async applyFirewallAfterStart(): Promise<void> {
		if (this.settings.autoEnableFirewall) {
			try {
				await this.docker.enableFirewall();
				this.firewallBar.setState("enabled");
			} catch (error: unknown) {
				// Don't collapse the failure to "disabled" — the firewall may
				// be off, half-applied, or fully applied with docker exec
				// returning non-zero on a side concern. Probe the real state
				// instead, falling back to "hidden" (renders as "n/a") if even
				// the probe fails.
				try {
					await this.refreshFirewallStatus();
				} catch {
					this.firewallBar.setState("hidden");
				}
				// When the container is not running (restart-looping, exited, etc.)
				// the firewall exec fails for that reason — surface a clearer message
				// pointing at docker logs rather than the misleading "firewall failed".
				let noticeMsg = `Auto-enable firewall failed: ${errMsg(error)}. You can enable it manually from the status bar.`;
				try {
					if (!(await this.docker.probeIsRunning())) {
						noticeMsg =
							"Container exited during startup — the firewall could not be applied. " +
							"Run `docker logs oas-sandbox` for the cause " +
							"(common: invalid Write Directory or IPv6 not disabled). " +
							"Fix the setting and restart the container.";
					}
				} catch {
					// probe failed — keep original message
				}
				new Notice(noticeMsg);
			}
		} else {
			await this.refreshFirewallStatus();
		}
		this.updateTooltip();
	}

	// ── Firewall ───────────────────────────────────────────

	private async toggleFirewall(): Promise<void> {
		if (this.firewallBar.getState() === "hidden") {
			new Notice("Container is not running. Start it first.");
			return;
		}
		if (this.guardBusy()) return;
		try {
			if (this.firewallBar.getState() === "enabled") {
				await this.docker.disableFirewall();
				this.firewallBar.setState("disabled");
				new Notice("Firewall disabled.");
			} else {
				await this.docker.enableFirewall();
				this.firewallBar.setState("enabled");
				new Notice("Firewall enabled.");
			}
			this.updateTooltip();
		} catch (error: unknown) {
			new Notice(`Firewall toggle failed: ${errMsg(error)}`);
		}
	}

	private async refreshFirewallStatus(): Promise<void> {
		const status = await this.docker.firewallStatus();
		this.firewallBar.setState(status === "unavailable" ? "hidden" : status);
		this.lastFirewallRefreshAt = Date.now();
	}

	/** Event-driven refresh — rate-limited to avoid exec spam on rapid focus/hover. */
	private maybeRefreshFirewall(): void {
		if (this.firewallBar.getState() === "hidden") return;
		if (Date.now() - this.lastFirewallRefreshAt < FIREWALL_EVENT_THROTTLE) return;
		void this.refreshFirewallStatus();
	}

	// ── MCP server ────────────────────────────────────────

	// Shims for settings.ts — it calls these on the plugin instance.
	async applyMcpEnabled(enabled: boolean): Promise<void> {
		return this.mcpLifecycle.applyEnabled(enabled);
	}

	async restartMcpIfRunning(): Promise<void> {
		return this.mcpLifecycle.restartIfRunning();
	}

	// ── Status bar menu ────────────────────────────────────

	private async showStatusMenu(evt: MouseEvent): Promise<void> {
		const menu = new Menu();
		const busy = this.docker.isBusy();
		const running = this.statusBar.getState() === "running";

		menu.addItem((item) =>
			item
				.setTitle("Start Container")
				.setIcon("play")
				.setDisabled(busy || running)
				.onClick(this.safeFire("Start container", () => this.startContainer())),
		);
		menu.addItem((item) =>
			item
				.setTitle("Stop Container")
				.setIcon("square")
				.setDisabled(busy || !running)
				.onClick(this.safeFire("Stop container", () => this.stopContainer())),
		);
		menu.addItem((item) =>
			item
				.setTitle("Restart Container")
				.setIcon("refresh-cw")
				.setDisabled(busy || !running)
				.onClick(this.safeFire("Restart container", () => this.restartContainer())),
		);
		menu.addSeparator();

		const fwEnabled = this.firewallBar.getState() === "enabled";
		menu.addItem((item) =>
			item
				.setTitle(fwEnabled ? "Disable Firewall" : "Enable Firewall")
				.setIcon("shield")
				.setDisabled(busy || !running)
				.onClick(this.safeFire("Toggle firewall", () => this.toggleFirewall())),
		);

		const mcpRunning = this.mcpLifecycle.isRunning();
		menu.addItem((item) =>
			item
				.setTitle(mcpRunning ? "Disable MCP Server" : "Enable MCP Server")
				.setIcon("server")
				.onClick(this.safeFire("Toggle MCP server", () => this.mcpLifecycle.toggle())),
		);

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("New Terminal")
				.setIcon("terminal")
				.setDisabled(!running)
				.onClick(this.safeFire("Open terminal", () => this.activateTerminalView())),
		);
		menu.addItem((item) =>
			item
				.setTitle("New Session...")
				.setIcon("plus")
				.setDisabled(!running)
				.onClick(
					this.safeFire("Open new session", async () => {
						const name = await this.promptSessionName("New Session");
						if (name) await this.activateTerminalView(name);
					}),
				),
		);

		if (running) {
			const sessions = await this.docker.listSessions();
			for (const name of sessions) {
				menu.addItem((item) =>
					item
						.setTitle(`Attach: ${name}`)
						.setIcon("arrow-right")
						.onClick(
							this.safeFire(`Attach to ${name}`, () =>
								this.activateTerminalView(name),
							),
						),
				);
			}
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Open in Browser")
				.setIcon("external-link")
				.setDisabled(!running)
				.onClick(() =>
					window.open(
						resolveTtydBrowserUrl(
							this.settings.ttydPort,
							this.settings.ttydBindAddress,
						),
					),
				),
		);
		menu.addItem((item) =>
			item
				.setTitle("Check Status")
				.setIcon("activity")
				.onClick(this.safeFire("Container status", () => this.containerStatus())),
		);

		menu.showAtMouseEvent(evt);
	}

	// ── Tooltip ────────────────────────────────────────────

	private updateTooltip(): void {
		this.statusBar.setRunningTooltipContext({
			port: this.settings.ttydPort,
			firewall: this.firewallBar.getState(),
			mcp: {
				running: this.mcpLifecycle.isRunning(),
				port: this.settings.mcpPort,
				toolCount: this.mcpLifecycle.getToolCount(),
			},
		});
	}

	// ── Background startup ────────────────────────────

	private async backgroundStartup(): Promise<void> {
		this.statusBar.setState("checking");
		this.statusBar.setDetails("Starting: checking Docker availability…");

		try {
			this.statusBar.setDetails("Starting: probing WSL (5s fast-fail)…");
			await this.docker.ensureWslReady();
		} catch (error: unknown) {
			this.reportContainerError({ detailsPrefix: "WSL error", error, notice: true });
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
			return;
		}

		try {
			this.statusBar.setDetails("Starting: probing container status…");
			const isRunning = await this.docker.probeIsRunning();
			if (!isRunning) {
				this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
			}
			await this.syncStatusBar(isRunning);

			if (this.settings.autoStartContainer && !isRunning) {
				this.statusBar.setDetails("Starting: docker compose up -d (auto-start)…");
				await this.startContainer();
			}

			this.startHealthPoll();
		} catch (error: unknown) {
			// A probe throw (vs. a clean false) means the container state is
			// indeterminate — Docker daemon momentarily unavailable, WSL
			// handshake glitch, etc. Don't destroy persisted terminal tabs
			// over a transient: the health poll below retries every 5s and
			// detaches legitimately once the container is definitely down.
			this.startHealthPoll();
			this.reportContainerError({ detailsPrefix: "Docker error", error, notice: true });
		}
	}

	// ── Health poll ───────────────────────────────────

	private startHealthPoll(): void {
		this.stopHealthPoll();
		this.healthPollId = this.registerInterval(
			window.setInterval(() => void this.healthCheck(), HEALTH_POLL_INTERVAL),
		);
		this.startFirewallPoll();
	}

	private stopHealthPoll(): void {
		if (this.healthPollId != null) {
			window.clearInterval(this.healthPollId);
			this.healthPollId = null;
		}
		this.stopFirewallPoll();
	}

	private async healthCheck(): Promise<void> {
		if (this.docker.isBusy()) return;
		try {
			const isRunning = await this.docker.probeIsRunning();
			await this.syncStatusBar(isRunning);
			if (isRunning) await this.checkContainerIdDrift();
		} catch (error: unknown) {
			this.reportContainerError({ detailsPrefix: "Docker error", error });
			this.stopHealthPoll();
		}
	}

	private async checkStartupPortConflicts(): Promise<number[]> {
		// Only probe ports the container will bind. The MCP server is hosted
		// by the plugin (this process), so its port is always "in use" from
		// the OS's perspective — including it would always abort container
		// start when MCP is enabled.
		const ports = [this.settings.ttydPort];
		return this.docker.checkStartupConflicts(
			ports,
			this.settings.ttydBindAddress || "127.0.0.1",
		);
	}

	private async checkContainerIdDrift(): Promise<void> {
		let current: string;
		try {
			current = await this.docker.getContainerId();
		} catch (err) {
			// Log on probe failure so a flaky probe doesn't silently mask
			// real container recreation. Next health poll retries.
			logger.warn("Plugin", "Container-id drift probe failed; will retry on next poll", err);
			return;
		}
		if (!current) return;
		if (!this.lastKnownContainerId) {
			this.lastKnownContainerId = current;
			return;
		}
		if (current !== this.lastKnownContainerId) {
			new Notice(
				"Sandbox container was recreated outside the plugin. Terminal sessions may be disconnected; reopen to reconnect.",
			);
			this.lastKnownContainerId = current;
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
		}
	}

	// ── Session prompt ─────────────────────────────────────

	private promptSessionName(title: string, defaultValue = ""): Promise<string | null> {
		return inputModal(this.app, {
			title,
			placeholder: "e.g. work, research, debug",
			defaultValue,
			multiline: false,
		});
	}

	// ── Helpers ────────────────────────────────────────────

	private async ensureWriteDir(): Promise<void> {
		const dir = this.settings.vaultWriteDir;
		if (!dir) return;
		if (!isValidWriteDir(dir)) {
			throw new Error("Invalid vault write directory.");
		}
		// Skip when the folder already exists; otherwise let create surface its real error.
		if (this.app.vault.getFolderByPath(dir)) return;
		await this.app.vault.createFolder(dir);
	}

	/**
	 * Funnel for "container/docker/wsl call failed" status updates.
	 * Sets state=error, details=`<prefix>: <msg>\nClick for options`, and
	 * optionally raises a Notice (`true` → `Sandbox: <msg>`; string → `<string>: <msg>`).
	 */
	private reportContainerError(opts: {
		detailsPrefix: string;
		error: unknown;
		notice?: string | true;
	}): void {
		this.statusBar.setState("error");
		const msg = errMsg(opts.error);
		this.statusBar.setDetails(`${opts.detailsPrefix}: ${msg}\nClick for options`);
		if (opts.notice === true) {
			new Notice(`Sandbox: ${msg}`);
		} else if (typeof opts.notice === "string") {
			new Notice(`${opts.notice}: ${msg}`);
		}
	}

	private async runDockerCommand(opts: {
		preState?: ContainerState;
		preDetails?: string;
		action: () => Promise<string>;
		postState: ContainerState;
		successMsg: string;
		failurePrefix: string;
	}): Promise<boolean> {
		try {
			if (opts.preState) {
				this.statusBar.setState(opts.preState);
				// Honour caller-supplied details (e.g. "Waiting for previous
				// container to shut down...") instead of clobbering with a generic.
				this.statusBar.setDetails(opts.preDetails ?? "Container is starting up...");
			}
			await opts.action();
			this.statusBar.setState(opts.postState);
			new Notice(opts.successMsg);
			return true;
		} catch (error: unknown) {
			this.reportContainerError({
				detailsPrefix: "Container error",
				error,
				notice: opts.failurePrefix,
			});
			return false;
		}
	}

	private async containerStatus(): Promise<void> {
		try {
			const output = await this.docker.status();
			const isRunning = DockerManager.parseIsRunning(output);
			await this.syncStatusBar(isRunning);
			this.startHealthPoll();

			if (!isRunning) {
				new Notice("Sandbox: Stopped", 5000);
				return;
			}

			const info = await this.docker.getContainerInfo();

			const mcpRunning = this.mcpLifecycle.isRunning();
			const fwState = this.firewallBar.getState();
			const fwLine =
				fwState === "enabled" ? "on" : fwState === "disabled" ? "off" : "unknown";

			const lines = ["Sandbox: Running"];
			if (info?.id) lines.push(`ID: ${info.id.slice(0, 12)}`);
			if (info?.image) lines.push(`Image: ${info.image}`);
			if (info?.startedAt) lines.push(`Up: ${formatUptime(info.startedAt)}`);
			lines.push(`MCP: ${mcpRunning ? `on (port ${this.settings.mcpPort})` : "off"}`);
			lines.push(`Firewall: ${fwLine}`);

			new Notice(lines.join("\n"), 8000);
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to get status: ${errMsg(error)}`);
		}
	}

	private async syncStatusBar(isRunning: boolean): Promise<void> {
		const wasRunning = this.statusBar.getState() === "running";
		this.statusBar.setState(isRunning ? "running" : "stopped");
		if (isRunning) {
			if (!wasRunning) await this.refreshFirewallStatus();
			this.updateTooltip();
		} else {
			this.firewallBar.setState("hidden");
			this.statusBar.setDetails(TOOLTIP_STOPPED);
			this.stopFirewallPoll();
		}
	}

	private startFirewallPoll(): void {
		this.stopFirewallPoll();
		this.firewallPollId = this.registerInterval(
			window.setInterval(() => {
				if (this.firewallBar.getState() !== "hidden") void this.refreshFirewallStatus();
			}, FIREWALL_REFRESH_INTERVAL),
		);
	}

	private stopFirewallPoll(): void {
		if (this.firewallPollId != null) {
			window.clearInterval(this.firewallPollId);
			this.firewallPollId = null;
		}
	}
}
