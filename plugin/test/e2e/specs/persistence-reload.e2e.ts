import { browser, expect } from "@wdio/globals";
import { describe, it, before } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { promises as fs } from "node:fs";
import path from "node:path";
import { openPluginSettings, switchTab, closeSettings, settingInput } from "../settings-helpers";

// QA plan 1.6 (stored-escape) and 6.4 (templates after reload). Both depend on
// the on-disk-persistence capability proven in harness-probe.e2e.ts: a value
// written to data.json / a file seeded under the vault survives reloadObsidian()
// and is read by the freshly-loaded plugin.

function basePath(): Promise<string> {
	return browser.executeObsidian(({ app }) => {
		const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
		return adapter.getBasePath?.() ?? "";
	});
}

async function setVaultWriteDirAndSave(value: string): Promise<void> {
	await browser.executeObsidian(async ({ app }, v: string) => {
		const plugin = (
			app as unknown as {
				plugins: {
					plugins: Record<
						string,
						{
							settings: { vaultWriteDir: string };
							saveData: (d: unknown) => Promise<void>;
						}
					>;
				};
			}
		).plugins.plugins["agent-sandbox"];
		plugin.settings.vaultWriteDir = v;
		await plugin.saveData(plugin.settings);
	}, value);
}

describe("Persistence-dependent reload behaviour (QA 1.6 / 6.4)", function () {
	before(async function () {
		await obsidianPage.resetVault();
	});

	it("6.4: prompt templates seeded on disk are available after a reload", async function () {
		const base = await basePath();
		const promptsDir = path.join(base, ".oas", "prompts");
		await fs.mkdir(promptsDir, { recursive: true });
		await fs.writeFile(path.join(promptsDir, "summarize.md"), "Summarise\n\n{{file}}\n");
		await fs.writeFile(path.join(promptsDir, "critique.md"), "Critique\n\n{{file}}\n");

		await browser.reloadObsidian();

		// After reload the plugin re-runs prewarm(); loadTemplates() returns the
		// cached list (or loads it), which is what the right-click submenu reads.
		const labels = await browser.executeObsidian(async ({ app }) => {
			const plugin = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{ analyse: { loadTemplates: () => Promise<Array<{ label: string }>> } }
						>;
					};
				}
			).plugins.plugins["agent-sandbox"];
			const templates = await plugin.analyse.loadTemplates();
			return templates.map((t) => t.label).sort();
		});

		expect(labels).toContain("Critique");
		expect(labels).toContain("Summarise");
	});

	it("1.6: a stored escaping write directory renders in the error state on load", async function () {
		await setVaultWriteDirAndSave("../escape");
		await browser.reloadObsidian();

		await openPluginSettings();
		await switchTab("General");
		const writeDirInput = settingInput("Vault write directory");
		// The field flags the stored value WITHOUT any keystroke — the validator
		// runs at render time (addValidatedTextSetting).
		expect(await writeDirInput.getAttribute("class")).toContain("sandbox-input-error");
		await closeSettings();

		// Restore a valid value so the persisted bad path doesn't leak elsewhere.
		await setVaultWriteDirAndSave("agent-workspace");
	});
});
