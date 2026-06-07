import { browser, expect, $, $$ } from "@wdio/globals";
import { describe, it, beforeEach, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { openPluginSettings, switchTab, settingInput } from "../settings-helpers";

// QA plan 1.2 — "Restart Container?" modal on settings close. e2e runs Obsidian
// with no real container, so we stub plugin.isContainerRunning()/restartContainer()
// on the live instance (both are called as this.plugin.x(), so reassignment is a
// clean spy seam) and close the settings modal — its real close hook calls the
// tab's hide(), which is what opens the modal. This covers the wiring: modal
// text/buttons, the Later/Restart branches, revert→no-modal, and the
// container-down→Notice branch. The real `docker compose down/up` recreate stays
// manual (see docs/qa-test-plan.md 1.2).

const FIELD = "Vault write directory";
const ORIGINAL = "agent-workspace";
const CHANGED = "agent-workspace-e2e";
const MODAL_TITLE = "Restart Container?";
const MODAL_MSG = "You changed settings that require a container restart.";

interface PluginShim {
	__restartCalls?: number;
	isContainerRunning: () => boolean;
	restartContainer: () => Promise<void>;
	settings: Record<string, unknown>;
}

/**
 * Stub the container probe + restart spy, then close the settings modal. The
 * settings modal's close hook fires the active tab's hide() (the production
 * trigger), which opens the confirm modal when a restart field is dirty.
 */
async function closeSettings(containerRunning: boolean): Promise<void> {
	await browser.executeObsidian(({ app }, running) => {
		const plugin = (app as unknown as { plugins: { plugins: Record<string, PluginShim> } })
			.plugins.plugins["obsidian-agent-sandbox"];
		plugin.__restartCalls = 0;
		plugin.isContainerRunning = () => running;
		plugin.restartContainer = async () => {
			plugin.__restartCalls = (plugin.__restartCalls ?? 0) + 1;
		};
		(app as unknown as { setting: { close: () => void } }).setting.close();
	}, containerRunning);
	await browser.pause(200);
}

async function restartCalls(): Promise<number> {
	return browser.executeObsidian(({ app }) => {
		const plugin = (
			app as unknown as { plugins: { plugins: Record<string, { __restartCalls?: number }> } }
		).plugins.plugins["obsidian-agent-sandbox"];
		return plugin.__restartCalls ?? 0;
	});
}

async function readSetting(key: string): Promise<unknown> {
	return browser.executeObsidian(({ app }, k) => {
		const plugin = (
			app as unknown as {
				plugins: { plugins: Record<string, { settings: Record<string, unknown> }> };
			}
		).plugins.plugins["obsidian-agent-sandbox"];
		return plugin.settings[k];
	}, key);
}

/** True if a "Restart Container?" confirm modal is currently in the DOM. */
async function restartModalOpen(): Promise<boolean> {
	return browser.executeObsidian((_app, title) => {
		return Array.from(document.querySelectorAll(".modal-title")).some((e) =>
			(e.textContent ?? "").includes(title),
		);
	}, MODAL_TITLE);
}

/** Dismiss any open modal(s) so each test starts from a clean slate. */
async function closeAllModals(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		if ((await $$(".modal-container").getElements()).length === 0) return;
		await browser.keys("Escape");
		await browser.pause(150);
	}
}

async function prepareDirty(value: string): Promise<void> {
	await openPluginSettings();
	await switchTab("General");
	const input = settingInput(FIELD);
	await input.waitForExist({ timeout: 3000 });
	await input.setValue(value);
	await browser.pause(300);
}

describe("Settings: restart-required modal (QA 1.2)", function () {
	beforeEach(async function () {
		await obsidianPage.resetVault();
		// Known baseline so the tab-open snapshot is deterministic.
		await browser.executeObsidian(({ app }, original) => {
			const plugin = (
				app as unknown as {
					plugins: { plugins: Record<string, { settings: Record<string, unknown> }> };
				}
			).plugins.plugins["obsidian-agent-sandbox"];
			plugin.settings.vaultWriteDir = original;
		}, ORIGINAL);
	});

	afterEach(async function () {
		await closeAllModals();
	});

	it("shows the Restart Container? modal when a restart field changed and container is running", async function () {
		await prepareDirty(CHANGED);
		await closeSettings(true);

		await expect($(".modal-title")).toHaveText(expect.stringContaining(MODAL_TITLE));
		expect(await $(".modal-content").getText()).toContain(MODAL_MSG);
		await expect($("button=Restart")).toExist();
		await expect($("button=Later")).toExist();
	});

	it("Later: saves without restarting and dismisses the modal", async function () {
		await prepareDirty(CHANGED);
		await closeSettings(true);

		const later = $("button=Later");
		await later.waitForExist({ timeout: 3000 });
		await later.click();
		await browser.pause(200);

		expect(await restartCalls()).toBe(0);
		expect(await readSetting("vaultWriteDir")).toBe(CHANGED);
		expect(await restartModalOpen()).toBe(false);
	});

	it("Restart: dispatches restartContainer() exactly once and dismisses", async function () {
		await prepareDirty(CHANGED);
		await closeSettings(true);

		const restart = $("button=Restart");
		await restart.waitForExist({ timeout: 3000 });
		await restart.click();

		await browser.waitUntil(async () => (await restartCalls()) === 1, {
			timeout: 3000,
			timeoutMsg: "restartContainer() was not called after clicking Restart",
		});
		await browser.pause(200);
		expect(await restartModalOpen()).toBe(false);
	});

	it("reverting the field to its open-time value skips the modal (diff-tracked)", async function () {
		await prepareDirty(CHANGED);
		// Revert to the value captured when the tab opened.
		await settingInput(FIELD).setValue(ORIGINAL);
		await browser.pause(300);
		await closeSettings(true);

		expect(await restartModalOpen()).toBe(false);
		expect(await restartCalls()).toBe(0);
	});

	it("container not running: no modal, sets pendingRestartMarker and saves", async function () {
		await prepareDirty(CHANGED);
		await closeSettings(false);

		expect(await restartModalOpen()).toBe(false);
		expect(await restartCalls()).toBe(0);
		expect(await readSetting("pendingRestartMarker")).toBe(true);
		expect(await readSetting("vaultWriteDir")).toBe(CHANGED);
	});
});
