import type { App } from "obsidian";
import { Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { confirmModal, inputModal } from "./modals";
import type AgentSandboxPlugin from "./main";
import { setLogLevel, errMsg } from "./logger";
import type { PermissionTier } from "./mcp-tools";
import {
	ALWAYS_ON_TIERS,
	GATED_TIERS as PERMISSION_GATED_TIERS,
	vaultWriteTiers,
} from "./permission-tiers";
import type { TierDef, VaultWriteMode } from "./permission-tiers";
import {
	isValidBindAddress,
	isValidCpus,
	isValidDomainList,
	isValidMemory,
	isValidMemoryFileName,
	isValidPathPrefixList,
	isValidPrivateHosts,
	isValidWriteDir,
} from "./validation";
import { promises as fsp } from "fs";
import { join } from "path";

export type TerminalThemeMode = "obsidian" | "dark" | "light";
export type DockerMode = "wsl" | "local";

export interface AgentSandboxSettings {
	dockerMode: DockerMode;
	dockerComposeFilePath: string;
	wslDistroName: string;
	vaultWriteDir: string;
	memoryFileName: string;
	ttydPort: number;
	ttydBindAddress: string;
	autoStartContainer: boolean;
	autoStopContainer: boolean;
	terminalTheme: TerminalThemeMode;
	terminalFont: string;
	terminalFontSize: number;
	terminalScrollback: number;
	clipboardAutoCopy: boolean;
	allowedPrivateHosts: string;
	additionalFirewallDomains: string;
	containerMemory: string;
	containerCpus: string;
	/** Name of the Obsidian secret holding the container sudo password; the value lives in secret storage, not here. */
	sudoSecretId: string;
	autoEnableFirewall: boolean;
	mcpEnabled: boolean;
	mcpPort: number;
	mcpBindAddress: string;
	mcpToken: string;
	mcpVaultWrites: VaultWriteMode;
	mcpTierNavigate: boolean;
	mcpTierManage: boolean;
	mcpTierExtensions: boolean;
	mcpPathAllowlist: string;
	mcpPathBlocklist: string;
	mcpDefaultDeny: boolean;
	notifyCreated: boolean;
	notifyEdited: boolean;
	notifyDeleted: boolean;
	notifyRenamed: boolean;
	notifyVaultWide: boolean;
	notifyUserEditTtlSeconds: number;
	logLevel: "debug" | "info" | "warn" | "error";
	mcpToolTimeout: number;
	mcpReviewTimeout: number;
	pendingRestartMarker: boolean;
}

/**
 * Gated MCP tiers - user must opt in because each escalates beyond the
 * filesystem access Claude already has (RO vault, RW workspace). The "read"
 * and "writeScoped" tiers are not listed: they're always enabled when MCP is
 * on because disabling them wouldn't deny access, only remove convenience.
 *
 * Sourced from permission-tiers.ts (no Obsidian deps), with `settingKey`
 * narrowed to `keyof AgentSandboxSettings` for type-safe indexing.
 */
export const GATED_TIERS: readonly TierDef<keyof AgentSandboxSettings>[] =
	PERMISSION_GATED_TIERS as readonly TierDef<keyof AgentSandboxSettings>[];

export function enabledTiersFromSettings(settings: AgentSandboxSettings): Set<PermissionTier> {
	const tiers = new Set<PermissionTier>(ALWAYS_ON_TIERS);
	for (const def of GATED_TIERS) {
		// Strict boolean check. A hand-edited `data.json` could put a string
		// (e.g. `"false"`) in the slot - that's truthy, so a plain `if (...)`
		// would incorrectly enable the tier. Treat anything other than the
		// literal `true` as off.
		if (settings[def.settingKey] === true) tiers.add(def.tier);
	}
	for (const tier of vaultWriteTiers(settings.mcpVaultWrites)) tiers.add(tier);
	return tiers;
}

export type TerminalSettings = Pick<
	AgentSandboxSettings,
	| "ttydPort"
	| "ttydBindAddress"
	| "terminalTheme"
	| "terminalFont"
	| "terminalFontSize"
	| "terminalScrollback"
	| "clipboardAutoCopy"
>;

export const DEFAULT_SETTINGS: AgentSandboxSettings = {
	dockerMode: "wsl",
	dockerComposeFilePath: "",
	wslDistroName: "",
	vaultWriteDir: "agent-workspace",
	memoryFileName: "memory.json",
	ttydPort: 7681,
	ttydBindAddress: "127.0.0.1",
	autoStartContainer: false,
	autoStopContainer: false,
	terminalTheme: "obsidian",
	terminalFont: "",
	terminalFontSize: 14,
	terminalScrollback: 10000,
	clipboardAutoCopy: true,
	allowedPrivateHosts: "",
	additionalFirewallDomains: "",
	containerMemory: "4G",
	containerCpus: "2",
	sudoSecretId: "",
	autoEnableFirewall: true,
	mcpEnabled: true,
	mcpPort: 28080,
	// Default 127.0.0.1 - host-only. The container reaches the host MCP server
	// via host.docker.internal, which resolves to a non-loopback IP, so
	// container access requires an explicit opt-in (set 0.0.0.0 or the docker
	// bridge gateway). This default keeps the vault tool surface off the LAN.
	mcpBindAddress: "127.0.0.1",
	mcpToken: "",
	mcpVaultWrites: "scoped",
	mcpTierNavigate: false,
	mcpTierManage: false,
	mcpTierExtensions: false,
	mcpPathAllowlist: "",
	mcpPathBlocklist: "",
	mcpDefaultDeny: false,
	notifyCreated: true,
	notifyEdited: false,
	notifyDeleted: true,
	notifyRenamed: true,
	notifyVaultWide: false,
	notifyUserEditTtlSeconds: 10,
	logLevel: "warn",
	mcpToolTimeout: 10,
	mcpReviewTimeout: 180,
	pendingRestartMarker: false,
};

const RESTART_CONTAINER_SUFFIX = " Requires container restart.";

/** Settings keys whose values must match the snapshot to skip a restart prompt. */
export const RESTART_REQUIRED_KEYS: ReadonlyArray<keyof AgentSandboxSettings> = [
	"dockerMode",
	"dockerComposeFilePath",
	"wslDistroName",
	"vaultWriteDir",
	"memoryFileName",
	"ttydPort",
	"ttydBindAddress",
	"mcpPort",
	"mcpToken",
	"containerMemory",
	"containerCpus",
	"allowedPrivateHosts",
	"additionalFirewallDomains",
];

/**
 * Returns true if any restart-required key in `current` differs from its value in `baseline`.
 * Used both by the settings tab (hide-time diff) and by the status-bar feed (live diff).
 */
export function restartKeysChanged(
	current: AgentSandboxSettings,
	baseline: Partial<AgentSandboxSettings>,
): boolean {
	return RESTART_REQUIRED_KEYS.some((k) => current[k] !== baseline[k]);
}

type TabId = "general" | "terminal" | "advanced" | "mcp";

export class AgentSandboxSettingTab extends PluginSettingTab {
	plugin: AgentSandboxPlugin;
	private activeTab: TabId = "general";
	private restartSnapshot: Partial<AgentSandboxSettings> = {};
	private sudoPasswordSnapshot: string | undefined;
	// Cache of compose-file-existence checks keyed by path, populated async
	// to avoid blocking the renderer with sync `existsSync`. Values:
	// true=found, false=missing, undefined=not yet checked. Re-renders when
	// a pending path resolves so the warning appears without user interaction.
	private composePathExists: Map<string, boolean> = new Map();

	constructor(app: App, plugin: AgentSandboxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		const dirty = this.needsRestart();
		this.restartSnapshot = {};
		this.sudoPasswordSnapshot = undefined;
		if (!dirty) return;
		if (this.plugin.isContainerRunning()) {
			void confirmModal(this.app, {
				title: "Restart Container?",
				message:
					"You changed settings that require a container restart. Restart now? This will stop all active terminal sessions.",
				ctaLabel: "Restart",
				cancelLabel: "Later",
			}).then((ok) => {
				if (ok) void this.plugin.restartContainer();
			});
		} else {
			this.plugin.settings.pendingRestartMarker = true;
			void this.plugin.saveSettings();
			new Notice("Settings saved - restart the container to apply changes.", 5000);
		}
	}

	private needsRestart(): boolean {
		return (
			this.isSudoRestartDirty() ||
			(Object.keys(this.restartSnapshot).length > 0 &&
				restartKeysChanged(this.plugin.settings, this.restartSnapshot))
		);
	}

	private isRestartDirty(key: keyof AgentSandboxSettings): boolean {
		return (
			Object.keys(this.restartSnapshot).length > 0 &&
			this.plugin.settings[key] !== this.restartSnapshot[key]
		);
	}

	private isSudoRestartDirty(): boolean {
		return (
			this.sudoPasswordSnapshot !== undefined &&
			this.plugin.sudoPassword !== this.sudoPasswordSnapshot
		);
	}

	/**
	 * Append a `↺ Pending restart` pill span to a setting's descEl.
	 * The span is initially shown or hidden based on `dirty`.
	 * Returns the element for live toggling in onChange handlers.
	 */
	private restartIndicator(s: Setting, dirty: boolean): HTMLSpanElement {
		const el = s.descEl.createEl("span", {
			cls: "sandbox-settings-restart-indicator",
			text: "↺ Pending restart",
		});
		el.style.display = dirty ? "" : "none";
		return el;
	}

	/**
	 * Add a numeric Setting whose input parses as int and validates against
	 * [min, max]. Invalid input shows the error class and is dropped (not saved).
	 */
	private addNumberSetting(
		el: HTMLElement,
		opts: {
			name: string;
			desc: string;
			key: keyof AgentSandboxSettings;
			min: number;
			max: number;
			placeholder?: string;
			requiresRestart?: boolean;
			narrow?: boolean;
			onChange?: () => void;
		},
	): void {
		let indicator: HTMLSpanElement | null = null;
		const s = new Setting(el)
			.setName(opts.name)
			.setDesc(opts.requiresRestart ? opts.desc + RESTART_CONTAINER_SUFFIX : opts.desc)
			.addText((text) => {
				if (opts.placeholder) text.setPlaceholder(opts.placeholder);
				text.setValue(String(this.plugin.settings[opts.key])).onChange(async (value) => {
					const n = parseInt(value, 10);
					if (!isNaN(n) && n >= opts.min && n <= opts.max) {
						(this.plugin.settings[opts.key] as number) = n;
						this.plugin.saveSettings();
						text.inputEl.removeClass("sandbox-input-error");
						if (indicator)
							indicator.style.display = this.isRestartDirty(opts.key) ? "" : "none";
						opts.onChange?.();
					} else {
						text.inputEl.addClass("sandbox-input-error");
					}
				});
				if (opts.narrow) text.inputEl.addClass("sandbox-settings-narrow-input");
			});
		if (opts.requiresRestart)
			indicator = this.restartIndicator(s, this.isRestartDirty(opts.key));
	}

	/** Add a boolean Setting backed by a toggle. */
	private addToggleSetting(
		el: HTMLElement,
		opts: {
			name: string;
			desc: string;
			key: keyof AgentSandboxSettings;
			requiresRestart?: boolean;
			onChange?: (value: boolean) => void | Promise<void>;
		},
	): void {
		let indicator: HTMLSpanElement | null = null;
		const s = new Setting(el)
			.setName(opts.name)
			.setDesc(opts.requiresRestart ? opts.desc + RESTART_CONTAINER_SUFFIX : opts.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings[opts.key] as boolean)
					.onChange(async (value) => {
						(this.plugin.settings[opts.key] as boolean) = value;
						this.plugin.saveSettings();
						if (indicator)
							indicator.style.display = this.isRestartDirty(opts.key) ? "" : "none";
						await opts.onChange?.(value);
					}),
			);
		if (opts.requiresRestart)
			indicator = this.restartIndicator(s, this.isRestartDirty(opts.key));
	}

	/**
	 * Add a text Setting that saves on change. When `validator` is supplied,
	 * invalid input shows the error class and is not saved.
	 */
	private addValidatedTextSetting(
		el: HTMLElement,
		opts: {
			name: string;
			desc: string;
			key: keyof AgentSandboxSettings;
			validator?: (value: string) => boolean;
			placeholder?: string;
			requiresRestart?: boolean;
			onChange?: () => void;
		},
	): void {
		let indicator: HTMLSpanElement | null = null;
		const s = new Setting(el)
			.setName(opts.name)
			.setDesc(opts.requiresRestart ? opts.desc + RESTART_CONTAINER_SUFFIX : opts.desc)
			.addText((text) => {
				if (opts.placeholder) text.setPlaceholder(opts.placeholder);
				const initial = String(this.plugin.settings[opts.key]);
				text.setValue(initial);
				if (opts.validator && !opts.validator(initial)) {
					text.inputEl.addClass("sandbox-input-error");
				}
				text.onChange(async (value) => {
					if (!opts.validator || opts.validator(value)) {
						(this.plugin.settings[opts.key] as string) = value;
						this.plugin.saveSettings();
						text.inputEl.removeClass("sandbox-input-error");
						if (indicator)
							indicator.style.display = this.isRestartDirty(opts.key) ? "" : "none";
						opts.onChange?.();
					} else {
						text.inputEl.addClass("sandbox-input-error");
					}
				});
			});
		if (opts.requiresRestart)
			indicator = this.restartIndicator(s, this.isRestartDirty(opts.key));
	}

	/**
	 * Render a per-entry add/remove list editor for a comma-separated string
	 * setting. Each entry gets its own row with a × remove button. An "Add"
	 * button opens an inputModal to capture and validate a new entry.
	 */
	private renderListEditor(
		containerEl: HTMLElement,
		opts: {
			name: string;
			desc: string;
			key:
				| "additionalFirewallDomains"
				| "allowedPrivateHosts"
				| "mcpPathAllowlist"
				| "mcpPathBlocklist";
			validator: (v: string) => boolean;
			placeholder: string;
			requiresRestart?: boolean;
			onChange?: () => void;
		},
	): void {
		const save = (entries: string[]) => {
			(this.plugin.settings[opts.key] as string) = entries.join(",");
			void this.plugin.saveSettings();
			opts.onChange?.();
			this.display();
		};

		const entries = (this.plugin.settings[opts.key] as string)
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		const wrapper = containerEl.createDiv({ cls: "setting-item sandbox-settings-list-editor" });
		const infoEl = wrapper.createDiv({ cls: "setting-item-info" });
		infoEl.createDiv({ cls: "setting-item-name", text: opts.name });
		const descDiv = infoEl.createDiv({ cls: "setting-item-description" });
		descDiv.appendText(opts.requiresRestart ? opts.desc + RESTART_CONTAINER_SUFFIX : opts.desc);
		if (opts.requiresRestart && this.isRestartDirty(opts.key)) {
			descDiv.createEl("span", {
				cls: "sandbox-settings-restart-indicator",
				text: "↺ Pending restart",
			});
		}

		const listEl = infoEl.createDiv({ cls: "sandbox-settings-list-entries" });
		for (const entry of entries) {
			const row = listEl.createDiv({ cls: "sandbox-settings-list-row" });
			row.createSpan({ text: entry, cls: "sandbox-settings-list-entry-text" });
			const removeBtn = row.createEl("button", {
				text: "×",
				cls: "sandbox-settings-list-remove",
			});
			removeBtn.setAttribute("aria-label", `Remove ${entry}`);
			removeBtn.addEventListener("click", () => {
				save(entries.filter((e) => e !== entry));
			});
		}

		const controlEl = wrapper.createDiv({ cls: "setting-item-control" });
		const addBtn = controlEl.createEl("button", {
			text: "Add",
			cls: "mod-cta sandbox-settings-list-add",
		});
		addBtn.addEventListener("click", () => {
			void inputModal(this.app, {
				title: `Add ${opts.name}`,
				placeholder: opts.placeholder,
				multiline: false,
			}).then((value) => {
				if (value === null) return;
				if (!opts.validator(value)) {
					new Notice(`Invalid entry: ${value}`);
					return;
				}
				if (entries.includes(value)) {
					new Notice(`Entry already exists: ${value}`);
					return;
				}
				save([...entries, value]);
			});
		});
	}

	display(): void {
		if (Object.keys(this.restartSnapshot).length === 0) {
			this.restartSnapshot = Object.fromEntries(
				RESTART_REQUIRED_KEYS.map((k) => [k, this.plugin.settings[k]]),
			) as Partial<AgentSandboxSettings>;
			this.sudoPasswordSnapshot = this.plugin.sudoPassword;
		}
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("sandbox-settings");

		this.renderTabs(containerEl);

		const contentEl = containerEl.createDiv({ cls: "sandbox-settings-content" });

		switch (this.activeTab) {
			case "general":
				this.renderGeneral(contentEl);
				break;
			case "terminal":
				this.renderTerminal(contentEl);
				break;
			case "advanced":
				this.renderAdvanced(contentEl);
				break;
			case "mcp":
				this.renderMcp(contentEl);
				break;
		}
	}

	private renderTabs(containerEl: HTMLElement): void {
		const tabBar = containerEl.createDiv({ cls: "sandbox-settings-tabs" });
		const tabs: { id: TabId; label: string }[] = [
			{ id: "general", label: "General" },
			{ id: "terminal", label: "Terminal" },
			{ id: "mcp", label: "MCP" },
			{ id: "advanced", label: "Advanced" },
		];
		for (const tab of tabs) {
			const btn = tabBar.createEl("button", {
				text: tab.label,
				cls: "sandbox-settings-tab",
			});
			if (tab.id === this.activeTab) {
				btn.addClass("is-active");
			}
			btn.addEventListener("click", () => {
				this.activeTab = tab.id;
				this.display();
			});
		}
	}

	private renderGeneral(el: HTMLElement): void {
		const dockerModeSetting = new Setting(el)
			.setName("Docker mode")
			.setDesc(
				"How Docker is accessed. WSL runs commands via wsl.exe. " +
					"Local runs docker compose directly on the host." +
					RESTART_CONTAINER_SUFFIX,
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("wsl", "WSL (Windows)")
					.addOption("local", "Local (Linux / Mac / Windows)")
					.setValue(this.plugin.settings.dockerMode)
					.onChange(async (value) => {
						this.plugin.settings.dockerMode = value as DockerMode;
						this.plugin.saveSettings();
						this.display();
					}),
			);
		// dockerMode re-renders via display() on change - badge is correct at render time.
		this.restartIndicator(dockerModeSetting, this.isRestartDirty("dockerMode"));

		const isWsl = this.plugin.settings.dockerMode === "wsl";

		const composeDesc = isWsl
			? "Absolute WSL path to the directory containing docker-compose.yml."
			: "Absolute path to the directory containing docker-compose.yml.";

		const composeSetting = new Setting(el)
			.setName("Docker Compose path")
			.setDesc(composeDesc + RESTART_CONTAINER_SUFFIX);

		// Compose-file existence is computed off the event loop - the settings
		// tab re-renders on every keystroke (onChange → display()), so a sync
		// stat per render adds up. The cache short-circuits repeats; the
		// async miss path triggers a one-shot re-render when the answer lands.
		if (!isWsl && this.plugin.settings.dockerComposeFilePath) {
			const composePath = this.plugin.settings.dockerComposeFilePath;
			const yml = join(composePath, "docker-compose.yml");
			const cached = this.composePathExists.get(yml);
			if (cached === false) {
				composeSetting.descEl.createEl("br");
				composeSetting.descEl.createEl("strong", {
					text: "docker-compose.yml not found at this path.",
					cls: "sandbox-settings-warning-text",
				});
			} else if (cached === undefined) {
				// Kick off the probe; re-render the panel once the answer
				// lands, but only if the general tab is still active -
				// switching tabs mid-probe is fine since the answer is cached.
				const activeAtProbe = this.activeTab;
				fsp.access(yml)
					.then(() => this.composePathExists.set(yml, true))
					.catch(() => this.composePathExists.set(yml, false))
					.finally(() => {
						if (this.activeTab === activeAtProbe) this.display();
					});
			}
		}
		// composePath onChange does NOT call display(), so we toggle the indicator live.
		const composeIndicator = this.restartIndicator(
			composeSetting,
			this.isRestartDirty("dockerComposeFilePath"),
		);
		composeSetting.addText((text) =>
			text
				.setPlaceholder(
					isWsl
						? "/home/user/obsidian-agent-sandbox/container"
						: "/opt/obsidian-agent-sandbox/container",
				)
				.setValue(this.plugin.settings.dockerComposeFilePath)
				.onChange(async (value) => {
					this.plugin.settings.dockerComposeFilePath = value;
					this.plugin.saveSettings();
					composeIndicator.style.display = this.isRestartDirty("dockerComposeFilePath")
						? ""
						: "none";
				}),
		);

		if (isWsl) {
			this.addValidatedTextSetting(el, {
				name: "WSL distribution",
				desc: "The WSL distribution used for running Docker commands.",
				key: "wslDistroName",
				placeholder: "Ubuntu",
				requiresRestart: true,
			});
		}

		this.addValidatedTextSetting(el, {
			name: "Vault write directory",
			desc:
				"Folder inside the vault where the container can write - nested paths like " +
				"@Inbox/agent-workspace are supported. The rest of the vault is mounted read-only. " +
				"Created automatically on start.",
			key: "vaultWriteDir",
			validator: isValidWriteDir,
			placeholder: "agent-workspace",
			requiresRestart: true,
		});

		this.addValidatedTextSetting(el, {
			name: "Memory file name",
			desc:
				"Filename for the memory MCP server, stored in the vault's .oas/ directory " +
				"(independent of the write directory).",
			key: "memoryFileName",
			validator: isValidMemoryFileName,
			placeholder: "memory.json",
			requiresRestart: true,
		});

		this.addToggleSetting(el, {
			name: "Auto-start on load",
			desc:
				"Start the container when the plugin loads. If the container is " +
				"already running from a previous session, this is a fast no-op - compose reuses it.",
			key: "autoStartContainer",
		});

		this.addToggleSetting(el, {
			name: "Auto-stop on exit",
			desc:
				"Controls behaviour when Obsidian itself exits (disabling the plugin always stops the container). " +
				"Off (default): keep the container running between Obsidian sessions so the next open is instant " +
				"and any background work continues. " +
				"On: stop the container on Obsidian exit to free memory and CPU; next open starts it fresh.",
			key: "autoStopContainer",
		});

		new Setting(el).setName("Agent output notifications").setHeading();

		this.addToggleSetting(el, {
			name: "Notify on file created",
			desc: "Show a notice when the agent creates a file under the write directory (or vault-wide if enabled below).",
			key: "notifyCreated",
		});

		this.addToggleSetting(el, {
			name: "Notify on file edited",
			desc: "Show a notice when the agent modifies an existing file. Can be noisy during long edit sessions.",
			key: "notifyEdited",
		});

		this.addToggleSetting(el, {
			name: "Notify on file deleted",
			desc: "Show a notice when the agent deletes a file.",
			key: "notifyDeleted",
		});

		this.addToggleSetting(el, {
			name: "Notify on file renamed/moved",
			desc: "Show a notice when the agent renames or moves a file.",
			key: "notifyRenamed",
		});

		this.addToggleSetting(el, {
			name: "Vault-wide scope",
			desc: "When off (default), notifications only fire for files inside the vault write directory. When on, notifications fire for any file the agent touches anywhere in the vault.",
			key: "notifyVaultWide",
		});
	}

	private renderTerminal(el: HTMLElement): void {
		this.addNumberSetting(el, {
			name: "Port",
			desc: "The host port mapped to ttyd inside the container (default: 7681).",
			key: "ttydPort",
			min: 1,
			max: 65535,
			requiresRestart: true,
		});

		const ttydBindSetting = new Setting(el)
			.setName("Bind address")
			.setDesc(
				"IP address ttyd binds to on the host. Default 127.0.0.1 (localhost only)." +
					RESTART_CONTAINER_SUFFIX,
			)
			.addText((text) => {
				text.setPlaceholder("127.0.0.1")
					.setValue(this.plugin.settings.ttydBindAddress)
					.onChange(async (value) => {
						if (isValidBindAddress(value)) {
							this.plugin.settings.ttydBindAddress = value;
							this.plugin.saveSettings();
							text.inputEl.removeClass("sandbox-input-error");
							ttydBindWarning.style.display = value === "0.0.0.0" ? "" : "none";
							ttydBindIndicator.style.display = this.isRestartDirty("ttydBindAddress")
								? ""
								: "none";
						} else {
							text.inputEl.addClass("sandbox-input-error");
						}
					});
			});
		const ttydBindWarning = ttydBindSetting.descEl.createEl("div", {
			cls: "sandbox-settings-field-warning",
			text: "0.0.0.0 exposes ttyd to your network without authentication. Anyone on your network can access the terminal.",
		});
		ttydBindWarning.style.display =
			this.plugin.settings.ttydBindAddress === "0.0.0.0" ? "" : "none";
		const ttydBindIndicator = this.restartIndicator(
			ttydBindSetting,
			this.isRestartDirty("ttydBindAddress"),
		);

		new Setting(el).setName("Appearance").setHeading();

		new Setting(el)
			.setName("Terminal theme")
			.setDesc("Follow Obsidian's current theme, or force dark or light.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("obsidian", "Follow Obsidian theme")
					.addOption("dark", "Dark")
					.addOption("light", "Light")
					.setValue(this.plugin.settings.terminalTheme)
					.onChange(async (value) => {
						this.plugin.settings.terminalTheme = value as TerminalThemeMode;
						this.plugin.saveSettings();
					}),
			);

		this.addValidatedTextSetting(el, {
			name: "Terminal font",
			desc:
				"Custom font family for the terminal. Leave empty for automatic fallback " +
				"(Obsidian theme font, then Cascadia Code, Consolas, Menlo, DejaVu Sans Mono).",
			key: "terminalFont",
			placeholder: "e.g. Fira Code, JetBrains Mono",
		});

		this.addNumberSetting(el, {
			name: "Font size",
			desc: "Terminal font size in pixels (8–32).",
			key: "terminalFontSize",
			min: 8,
			max: 32,
			placeholder: "14",
		});

		this.addNumberSetting(el, {
			name: "Scrollback",
			desc: "Number of lines of terminal history to keep (100–100,000).",
			key: "terminalScrollback",
			min: 100,
			max: 100000,
			placeholder: "10000",
		});

		this.addToggleSetting(el, {
			name: "Auto-copy on selection",
			desc: "Copy selected terminal text to the clipboard automatically. Disable if selecting text for reading surprises you by overwriting the clipboard.",
			key: "clipboardAutoCopy",
		});
	}

	private renderMcp(el: HTMLElement): void {
		new Setting(el).setName("Server").setHeading();

		this.addToggleSetting(el, {
			name: "Enable MCP server",
			desc:
				"Run an MCP server that exposes vault tools to Claude Code inside the container. " +
				"The server starts automatically with the plugin when enabled.",
			key: "mcpEnabled",
			onChange: (v) => this.plugin.applyMcpEnabled(v),
		});

		this.addNumberSetting(el, {
			name: "MCP port",
			desc: "Port for the MCP Streamable HTTP endpoint.",
			key: "mcpPort",
			min: 1,
			max: 65535,
			placeholder: "28080",
			requiresRestart: true,
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		const mcpBindSetting = new Setting(el)
			.setName("MCP bind address")
			.setDesc(
				"IP the MCP HTTP server binds to. Default 127.0.0.1 hides MCP from the network and from the container. " +
					"To let the container reach MCP via host.docker.internal, set this to the docker bridge gateway IP " +
					"(e.g. 172.17.0.1 on Linux native Docker) or 0.0.0.0.",
			)
			.addText((text) => {
				text.setPlaceholder("127.0.0.1")
					.setValue(this.plugin.settings.mcpBindAddress)
					.onChange(async (value) => {
						if (isValidBindAddress(value)) {
							this.plugin.settings.mcpBindAddress = value;
							this.plugin.saveSettings();
							void this.plugin.restartMcpIfRunning();
							text.inputEl.removeClass("sandbox-input-error");
							mcpBindWarning.style.display = value === "0.0.0.0" ? "" : "none";
						} else {
							text.inputEl.addClass("sandbox-input-error");
						}
					});
			});
		const mcpBindWarning = mcpBindSetting.descEl.createEl("div", {
			cls: "sandbox-settings-field-warning",
			text: "0.0.0.0 exposes MCP to your network. Bearer-token auth is the only line of defence.",
		});
		mcpBindWarning.style.display =
			this.plugin.settings.mcpBindAddress === "0.0.0.0" ? "" : "none";

		const mcpTokenSetting = new Setting(el)
			.setName("Auth token")
			.setDesc(
				"Bearer token for MCP authentication. Auto-generated and passed to the container." +
					RESTART_CONTAINER_SUFFIX,
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.mcpToken).setDisabled(true);
				text.inputEl.addClass("sandbox-settings-code-input");
			})
			.addButton((btn) =>
				btn.setButtonText("Regenerate").onClick(async () => {
					const { generateToken } = await import("./mcp-server");
					this.plugin.settings.mcpToken = generateToken();
					this.plugin.saveSettings();
					await this.plugin.restartMcpIfRunning();
					this.display();
				}),
			);
		// mcpToken re-renders via display() on Regenerate - badge is correct at render time.
		this.restartIndicator(mcpTokenSetting, this.isRestartDirty("mcpToken"));

		const alwaysEnabled = new Setting(el)
			.setName("Always enabled")
			.setDesc(
				"These MCP tools are always available when MCP is enabled. They don't grant access " +
					"beyond what Claude already has via the filesystem (RO vault, RW workspace) - " +
					"they just offer a more ergonomic interface via Obsidian's metadata.",
			)
			.setHeading();
		// Don't burn the writeDir value into the blurb - the MCP server reads it
		// live (via getWriteDir), but the settings UI only re-renders on full
		// tab re-render, so a stale snapshot would confuse users. Refer the
		// reader to the "Vault write directory" setting instead.
		const list = alwaysEnabled.descEl.createEl("ul", { cls: "sandbox-settings-info-list" });
		list.createEl("li", {
			text: "Read: search, read files, query metadata, tags, links, backlinks, frontmatter.",
		});
		list.createEl("li", {
			text: "Write (scoped): create and modify files within the configured vault write directory only (see General settings).",
		});

		new Setting(el)
			.setName("Escalations")
			.setDesc(
				"These tiers grant Claude capabilities beyond its filesystem access. Enable only what you need.",
			)
			.setHeading();

		new Setting(el)
			.setName("Vault-wide writes")
			.setDesc(
				"Writes outside the scoped write directory. None: scoped only. Reviewed: each change prompts a diff approval. Full: unrestricted, no review.",
			)
			.addDropdown((dd) =>
				dd
					.addOption("scoped", "None")
					.addOption("reviewed", "Reviewed")
					.addOption("full", "Full (no review)")
					.setValue(this.plugin.settings.mcpVaultWrites)
					.onChange(async (value) => {
						this.plugin.settings.mcpVaultWrites = value as VaultWriteMode;
						this.plugin.saveSettings();
						void this.plugin.restartMcpIfRunning();
					}),
			);

		for (const tier of GATED_TIERS) {
			this.addToggleSetting(el, {
				name: tier.name,
				desc: tier.desc,
				key: tier.settingKey,
				onChange: () => this.plugin.restartMcpIfRunning(),
			});
		}

		new Setting(el)
			.setName("Path restrictions")
			.setDesc(
				"These restrictions apply only to vault paths outside the vault write directory " +
					"(configured in General settings). Paths inside the vault write directory are " +
					"always writable by the agent regardless of what is set here.",
			)
			.setHeading();

		this.renderListEditor(el, {
			name: "Allowed paths",
			desc:
				"Vault path prefixes the agent may access outside the vault write " +
				"directory. A more-specific allow entry overrides a block entry - e.g. add " +
				"'.obsidian/plugins/my-plugin/' to permit that plugin's data while the rest of " +
				"the vault config folder stays blocked. Without 'Allowlist mode' below, allow " +
				"entries only matter when they override a block.",
			key: "mcpPathAllowlist",
			validator: isValidPathPrefixList,
			placeholder: "notes/",
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		this.addToggleSetting(el, {
			name: "Allowlist mode",
			desc:
				"When on, paths not matching the allow list above are denied. " +
				"When off, the allow list only overrides block entries - all other paths are accessible.",
			key: "mcpDefaultDeny",
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		this.renderListEditor(el, {
			name: "Blocked paths",
			desc:
				"Vault path prefixes denied outside the vault write directory. " +
				"Use the allow list above to permit a specific subtree; a more-specific allow entry " +
				"takes precedence (most-specific prefix wins). " +
				"The vault config folder ('.obsidian/') is always blocked.",
			key: "mcpPathBlocklist",
			validator: isValidPathPrefixList,
			placeholder: "private/",
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		new Setting(el).setName("Timeouts").setHeading();

		this.addNumberSetting(el, {
			name: "Tool timeout (seconds)",
			desc: "Max time for a normal MCP tool call to complete before failing.",
			key: "mcpToolTimeout",
			min: 1,
			max: 300,
			placeholder: "10",
			narrow: true,
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		this.addNumberSetting(el, {
			name: "Review timeout (seconds)",
			desc: "How long you have to approve or reject a write in the review modal before it times out.",
			key: "mcpReviewTimeout",
			min: 1,
			max: 600,
			placeholder: "180",
			narrow: true,
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		this.addNumberSetting(el, {
			name: "User edit suppression window (seconds)",
			desc: "After you type in a file, agent-output notifications for that file are suppressed for this many seconds. Prevents your own Obsidian edits triggering notices.",
			key: "notifyUserEditTtlSeconds",
			min: 1,
			max: 60,
			placeholder: "10",
			narrow: true,
		});
	}

	private renderAdvanced(el: HTMLElement): void {
		new Setting(el).setName("Diagnostics").setHeading();

		new Setting(el)
			.setName("Log level")
			.setDesc(
				"Controls verbosity of plugin logs in the developer console (Ctrl+Shift+I). " +
					"Debug shows MCP tool calls, session lifecycle, and WebSocket events.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("debug", "Debug")
					.addOption("info", "Info")
					.addOption("warn", "Warn")
					.addOption("error", "Error")
					.setValue(this.plugin.settings.logLevel)
					.onChange(async (value) => {
						this.plugin.settings.logLevel = value as AgentSandboxSettings["logLevel"];
						this.plugin.saveSettings();
						setLogLevel(this.plugin.settings.logLevel);
					}),
			);

		new Setting(el).setName("Resource limits").setHeading();

		this.addValidatedTextSetting(el, {
			name: "Memory limit",
			desc:
				"Maximum memory for the container (e.g. 4G, 8G, 16G). " +
				"On WSL2, also check .wslconfig memory allocation.",
			key: "containerMemory",
			validator: isValidMemory,
			placeholder: "4G",
			requiresRestart: true,
		});

		this.addValidatedTextSetting(el, {
			name: "CPU limit",
			desc: "Maximum CPU cores for the container.",
			key: "containerCpus",
			validator: isValidCpus,
			placeholder: "2",
			requiresRestart: true,
		});

		new Setting(el).setName("Security").setHeading();

		this.addToggleSetting(el, {
			name: "Auto-enable firewall on start",
			desc:
				"Automatically enable the outbound firewall when the container starts. " +
				"Restricts traffic to Anthropic, npm, GitHub, PyPI, and configured private hosts.",
			key: "autoEnableFirewall",
		});

		this.renderListEditor(el, {
			name: "Allowed private hosts",
			desc:
				"IPs or CIDRs allowed through the firewall. " +
				"Use for local services like NAS, API servers, etc. " +
				"The Docker gateway is always allowed.",
			key: "allowedPrivateHosts",
			validator: isValidPrivateHosts,
			placeholder: "e.g. 192.168.1.100 or 10.0.0.0/8",
			requiresRestart: true,
		});

		this.renderListEditor(el, {
			name: "Additional firewall domains",
			desc:
				"Domains to add to the firewall allowlist. " +
				"Adds to - never overrides - the built-in baseline. For host-managed rules Claude cannot see, " +
				"edit container/firewall-extras.txt instead.",
			key: "additionalFirewallDomains",
			validator: isValidDomainList,
			placeholder: "e.g. api.atlassian.com",
			requiresRestart: true,
		});

		const sourcesBox = el.createDiv({ cls: "setting-item sandbox-settings-sources" });
		const sourcesHeader = sourcesBox.createDiv({ cls: "sandbox-settings-sources-header" });
		sourcesHeader.createEl("div", {
			text: "Effective allowlist",
			cls: "setting-item-name",
		});
		const refreshBtn = sourcesHeader.createEl("button", { text: "Refresh" });
		const sourcesOutput = sourcesBox.createEl("pre", {
			cls: "sandbox-settings-sources-output",
		});
		sourcesOutput.setText(
			"(Click Refresh to fetch the effective firewall allowlist from the container.)",
		);
		refreshBtn.addEventListener("click", async () => {
			sourcesOutput.setText("Fetching…");
			try {
				const output = await this.plugin.firewallSources();
				sourcesOutput.setText(output.trim() || "(empty)");
			} catch (e: unknown) {
				const msg = errMsg(e);
				sourcesOutput.setText(`Error: ${msg}\n\nIs the container running?`);
			}
		});

		const sudoSetting = new Setting(el)
			.setName("Sudo password")
			.setDesc(
				"Password for the narrow apt-get/apt sudo inside the container. " +
					"Used by humans during interactive sessions to test-install tools. " +
					"Stored via Obsidian secret storage, outside the vault the container mounts." +
					RESTART_CONTAINER_SUFFIX,
			)
			.addComponent((c) =>
				new SecretComponent(this.app, c)
					.setValue(this.plugin.settings.sudoSecretId)
					.onChange((value) => {
						this.plugin.settings.sudoSecretId = value;
						this.plugin.saveSettings();
						sudoIndicator.style.display = this.isSudoRestartDirty() ? "" : "none";
					}),
			);
		const sudoIndicator = this.restartIndicator(sudoSetting, this.isSudoRestartDirty());
	}
}
