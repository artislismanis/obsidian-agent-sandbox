import { browser, expect, $$ } from "@wdio/globals";
import { describe, it, before } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

// Harness-limit probes — REPRODUCIBLE EVIDENCE, intentionally skipped.
//
// docs/testing.md lists "settings persistence across restart" and "plugin
// disable/enable via the UI" as un-automatable. Before trusting that, we probed
// whether the harness APIs the suite hadn't used (reloadObsidian,
// enablePlugin/disablePlugin) could reach them. They cannot, and the root cause
// is the same for both:
//
//   wdio-obsidian-service does NOT install the plugin as real files in the
//   vault. A diagnostic showed <vault>/.obsidian/plugins/<id>/main.js is absent
//   even while the plugin is loaded and working at boot — the service loads it
//   out-of-tree. Consequences observed on obsidian 1.12.7:
//     * settings written in-session never reach <vault>/.obsidian/.../data.json,
//       and a reloadObsidian() reboot resets settings to defaults; and
//     * disablePlugin() then enablePlugin() leaves the plugin disabled — enable
//       is a silent no-op because there is no on-disk main.js to reload.
//
// Both specs below therefore stay skipped. They are the canonical repro: if a
// future wdio-obsidian-service version installs the plugin on disk (or exposes a
// persistent-install option), un-skip them and re-classify QA-plan items 2.6
// (persistence), 2.5a (disable/enable), 1.6 (stored-escape), 6.4 (templates
// after reload). Unload cleanup itself is covered by unit tests on
// StatusBarManager.destroy() / FirewallStatusBar.destroy(); durable persistence
// is Obsidian's own saveData/loadData responsibility.

const PLUGIN_ID = "obsidian-agent-sandbox";

function readFontSize(): Promise<number | null> {
	return browser.executeObsidian(({ app }) => {
		const plugins = (
			app as unknown as {
				plugins: { plugins: Record<string, { settings: { terminalFontSize: number } }> };
			}
		).plugins.plugins;
		return plugins["obsidian-agent-sandbox"]?.settings?.terminalFontSize ?? null;
	});
}

function isEnabled(): Promise<boolean> {
	return browser.executeObsidian(({ app }) =>
		(app as unknown as { plugins: { enabledPlugins: Set<string> } }).plugins.enabledPlugins.has(
			"obsidian-agent-sandbox",
		),
	);
}

describe("Harness probes (skipped — see file header)", function () {
	before(async function () {
		await obsidianPage.resetVault();
	});

	// QA plan 2.6. SKIPPED: reloadObsidian() resets plugin settings to defaults
	// because the service loads the plugin out-of-tree (no on-disk data.json).
	it.skip("persists a saved setting across reloadObsidian()", async function () {
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
			).plugins.plugins["obsidian-agent-sandbox"];
			plugin.settings.terminalFontSize = 18;
			await plugin.saveData(plugin.settings);
		});

		await browser.reloadObsidian();

		expect(await readFontSize()).toBe(18);
	});

	// QA plan 2.5a. SKIPPED: enablePlugin() after disablePlugin() is a silent
	// no-op in this harness (no on-disk main.js to reload), so the plugin never
	// comes back and the no-debris assertions can't run.
	it.skip("re-enables cleanly after a disable/enable cycle", async function () {
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
