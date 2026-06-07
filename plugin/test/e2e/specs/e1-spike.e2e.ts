import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { existsSync } from "node:fs";
import path from "node:path";

// E1 SPIKE (QA plan 2.5a / 2.6 / 1.6 / 6.4) — does this wdio-obsidian-service
// version install the plugin on disk, and does a saved setting survive a reload?
//
// harness-probe.e2e.ts (Obsidian 1.12.7) recorded that the plugin loads
// OUT-OF-TREE (<vault>/.obsidian/plugins/<id>/main.js absent), so settings don't
// persist and disable/enable can't round-trip. This spike re-checks that empirically
// on whatever Obsidian version CI runs. The result decides whether the four
// persistence/reload items above can be automated or stay manual. This file is a
// throwaway diagnostic — it is removed before the PR merges (replaced by either the
// un-skipped probes or a re-confirmed-limitation docs update).

const PLUGIN_ID = "obsidian-agent-sandbox";

function basePath(): Promise<string> {
	return browser.executeObsidian(({ app }) => {
		const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
		return adapter.getBasePath?.() ?? "";
	});
}

describe("E1 spike: on-disk install + persistence", function () {
	it("the built plugin's main.js exists on disk in the vault", async function () {
		const base = await basePath();
		const mainJs = path.join(base, ".obsidian", "plugins", PLUGIN_ID, "main.js");
		console.log(`[E1-SPIKE] vault base: ${base}`);
		console.log(`[E1-SPIKE] main.js path: ${mainJs} exists=${existsSync(mainJs)}`);
		expect(existsSync(mainJs)).toBe(true);
	});

	it("a saved setting survives reloadObsidian()", async function () {
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

		const size = await browser.executeObsidian(
			({ app }) =>
				(
					app as unknown as {
						plugins: {
							plugins: Record<string, { settings?: { terminalFontSize?: number } }>;
						};
					}
				).plugins.plugins["obsidian-agent-sandbox"]?.settings?.terminalFontSize ?? null,
		);
		console.log(`[E1-SPIKE] terminalFontSize after reload: ${size}`);
		expect(size).toBe(18);
	});
});
