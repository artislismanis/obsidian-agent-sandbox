import { browser, expect } from "@wdio/globals";
import { describe, it, beforeEach, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

// QA plan 1.8 / 6.1 — the obsidian://agent-sandbox/open-terminal handler. We
// can't dispatch a real OS-level URI in the wdio harness, but the handler body
// is extracted to plugin.handleOpenTerminalUri(), so we invoke it directly with
// isContainerRunning() stubbed. 1.8: container down → Notice, no terminal tab.
// 6.1: container up → a terminal tab opens (its WebSocket attach fails with no
// ttyd, but the leaf is created, which is what the URI guarantees).

const VIEW_TYPE_TERMINAL = "agent-sandbox-terminal-view";

interface PluginShim {
	isContainerRunning: () => boolean;
	handleOpenTerminalUri: () => Promise<void>;
}

interface AppShim {
	plugins: { plugins: Record<string, PluginShim> };
	workspace: { getLeavesOfType: (t: string) => Array<{ detach: () => void }> };
}

async function setContainerRunning(running: boolean): Promise<void> {
	await browser.executeObsidian(({ app }, r: boolean) => {
		const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
		plugin.isContainerRunning = () => r;
	}, running);
}

async function fireOpenTerminalUri(): Promise<void> {
	await browser.executeObsidian(async ({ app }) => {
		const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
		await plugin.handleOpenTerminalUri();
	});
	await browser.pause(300);
}

async function terminalLeafCount(): Promise<number> {
	return browser.executeObsidian(({ app }, viewType: string) => {
		return (app as unknown as AppShim).workspace.getLeavesOfType(viewType).length;
	}, VIEW_TYPE_TERMINAL);
}

async function noticeTexts(): Promise<string[]> {
	return browser.executeObsidian(() =>
		Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""),
	);
}

async function closeTerminals(): Promise<void> {
	await browser.executeObsidian(({ app }, viewType: string) => {
		(app as unknown as AppShim).workspace.getLeavesOfType(viewType).forEach((l) => l.detach());
	}, VIEW_TYPE_TERMINAL);
	await browser.pause(100);
}

describe("URI handler: open-terminal (QA 1.8 / 6.1)", function () {
	beforeEach(async function () {
		await obsidianPage.resetVault();
		await closeTerminals();
	});

	afterEach(async function () {
		await closeTerminals();
	});

	it("1.8: with the container stopped, shows a Notice and opens no terminal tab", async function () {
		await setContainerRunning(false);
		await fireOpenTerminalUri();

		expect(await terminalLeafCount()).toBe(0);
		expect(
			(await noticeTexts()).some((t) => t.includes("Sandbox container is not running.")),
		).toBe(true);
	});

	it("6.1: with the container running, opens a terminal tab", async function () {
		await setContainerRunning(true);
		await fireOpenTerminalUri();

		expect(await terminalLeafCount()).toBe(1);
	});
});
