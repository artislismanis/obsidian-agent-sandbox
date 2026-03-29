import { Plugin } from "obsidian";
import {
	type PkmClaudeTerminalSettings,
	DEFAULT_SETTINGS,
	PkmClaudeTerminalSettingTab,
} from "./settings";

export default class PkmClaudeTerminalPlugin extends Plugin {
	settings: PkmClaudeTerminalSettings;

	async onload() {
		console.log("Loading PKM Claude Terminal plugin");

		await this.loadSettings();

		this.addSettingTab(new PkmClaudeTerminalSettingTab(this.app, this));
	}

	async onunload() {
		console.log("Unloading PKM Claude Terminal plugin");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
