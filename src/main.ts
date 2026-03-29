import { Plugin, WorkspaceLeaf } from "obsidian";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./terminal-view";

interface TerminalSettings {
	ttydPort: number;
	ttydUser: string;
	ttydPassword: string;
}

const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
	ttydPort: 7681,
	ttydUser: "user",
	ttydPassword: "changeme",
};

export default class PkmClaudeTerminalPlugin extends Plugin {
	settings: TerminalSettings = DEFAULT_TERMINAL_SETTINGS;

	async onload() {
		console.log("Loading PKM Claude Terminal plugin");

		this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
			return new TerminalView(leaf, {
				ttydPort: this.settings.ttydPort,
				ttydUser: this.settings.ttydUser,
				ttydPassword: this.settings.ttydPassword,
			});
		});

		this.addRibbonIcon("terminal", "Open Claude Terminal", () => {
			this.activateTerminalView();
		});

		this.addCommand({
			id: "open-claude-terminal",
			name: "PKM: Open Claude Terminal",
			callback: () => {
				this.activateTerminalView();
			},
		});
	}

	async onunload() {
		console.log("Unloading PKM Claude Terminal plugin");
	}

	async activateTerminalView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);

		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: VIEW_TYPE_TERMINAL,
				active: true,
			});
			this.app.workspace.revealLeaf(leaf);
		}
	}
}
