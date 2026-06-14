import { browser, expect, $$ } from "@wdio/globals";
import { describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { existsSync } from "node:fs";
import path from "node:path";

// Harness capability: on-disk install + settings persistence + disable/enable.
//
// HISTORY: these two specs were previously skipped. On Obsidian 1.12.7 a
// diagnostic showed wdio-obsidian-service loaded the plugin OUT-OF-TREE
// (<vault>/.obsidian/plugins/<id>/main.js absent), so in-session saveData never
// reached data.json, reloadObsidian() reset settings to defaults, and
// enablePlugin() after disablePlugin() was a silent no-op.
//
// On the current CI Obsidian (default: latest) that no longer holds — an E1 spike
// confirmed `main.js` IS present on disk under the vault and a saved setting
// survives reloadObsidian(). So both probes now run and stand as real coverage for
// QA-plan 2.6 (persistence) and 2.5a (disable/enable). The stored-escape (1.6) and
// templates-after-reload (6.4) items that depend on the same on-disk-persistence
// capability are covered in persistence-reload.e2e.ts. If a future Obsidian /
// service version regresses to out-of-tree loading, the first assertion below
// (main.js exists) fails loudly rather than silently passing.

const PLUGIN_ID = "agent-sandbox";

function readFontSize(): Promise<number | null> {
	return browser.executeObsidian(({ app }) => {
		const plugins = (
			app as unknown as {
				plugins: { plugins: Record<string, { settings: { terminalFontSize: number } }> };
			}
		).plugins.plugins;
		return plugins["agent-sandbox"]?.settings?.terminalFontSize ?? null;
	});
}

function isEnabled(): Promise<boolean> {
	return browser.executeObsidian(({ app }) =>
		(app as unknown as { plugins: { enabledPlugins: Set<string> } }).plugins.enabledPlugins.has(
			"agent-sandbox",
		),
	);
}

function basePath(): Promise<string> {
	return browser.executeObsidian(({ app }) => {
		const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
		return adapter.getBasePath?.() ?? "";
	});
}

// NOTE: no resetVault() here. resetVault() re-fixtures the vault and drops the
// on-disk plugin install, which both removes main.js and turns enablePlugin()
// back into a no-op. These probes run against the initial launched vault, where
// the service has installed the plugin on disk.
describe("Harness capability: on-disk install + persistence (QA 2.6 / 2.5a)", function () {
	// QA plan 2.6 — a saved setting must survive a real reload. Also asserts the
	// plugin is installed on disk (the precondition that makes persistence work).
	it("persists a saved setting across reloadObsidian()", async function () {
		const base = await basePath();
		const mainJs = path.join(base, ".obsidian", "plugins", PLUGIN_ID, "main.js");
		expect(existsSync(mainJs)).toBe(true);

		await browser.executeObsidian(async ({ app }) => {
			const plugin = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{
								settings: { terminalFontSize: number };
								saveData: (d: unknown) => Promise<void>;
							}
						>;
					};
				}
			).plugins.plugins["agent-sandbox"];
			plugin.settings.terminalFontSize = 18;
			await plugin.saveData(plugin.settings);
		});

		await browser.reloadObsidian();

		expect(await readFontSize()).toBe(18);
	});

	// QA plan 2.5a — disable then re-enable leaves no debris: all 12 commands
	// re-registered, exactly one ribbon icon and one status-bar pill.
	it("re-enables cleanly after a disable/enable cycle", async function () {
		await obsidianPage.disablePlugin(PLUGIN_ID);
		await browser.waitUntil(async () => (await isEnabled()) === false, {
			timeout: 5000,
			timeoutMsg: "plugin did not disable",
		});

		await obsidianPage.enablePlugin(PLUGIN_ID);
		await browser.waitUntil(async () => (await isEnabled()) === true, {
			timeout: 5000,
			timeoutMsg: "plugin did not re-enable",
		});

		const commandCount = await browser.executeObsidian(({ app }, pluginId) => {
			const commands = (app as unknown as { commands: { commands: Record<string, unknown> } })
				.commands.commands;
			return Object.keys(commands).filter((id) => id.startsWith(`${pluginId}:`)).length;
		}, PLUGIN_ID);
		expect(commandCount).toBe(12);

		const ribbons = await $$(
			'.side-dock-ribbon-action[aria-label="Open Sandbox Terminal"]',
		).getElements();
		expect(ribbons.length).toBe(1);

		const pills = await $$(
			"//*[contains(concat(' ', normalize-space(@class), ' '), ' status-bar-item ') and contains(., 'Sandbox')]",
		).getElements();
		expect(pills.length).toBe(1);
	});
});
