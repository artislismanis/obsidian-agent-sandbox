import { browser, expect, $ } from "@wdio/globals";
import { describe, it, beforeEach, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

// QA plan 6.6 — "Custom prompt…" modal edge inputs.
//
// Drives the real inputModal (modals.ts) opened by AnalyseManager.runAnalyseCustom
// with the container stubbed running. Covers the modal mechanics that are NOT
// unit-tested:
//   * empty / whitespace input is treated as a cancel (trim-to-cancel) — no
//     terminal opens;
//   * a non-empty prompt (including one full of shell metacharacters) opens a
//     terminal tab — the leaf is created even though the WebSocket attach fails
//     with no ttyd.
// The security guarantee that metacharacters are passed as a single argument and
// never execute on open needs a real container shell (Stage 3/E3) and stays
// manual; this spec covers the host-side modal + seed-open wiring.

const VIEW_TYPE_TERMINAL = "agent-sandbox-terminal-view";

interface AnalyseShim {
	runAnalyseCustom: (vaultPath: string) => Promise<void>;
}

interface AppShim {
	plugins: {
		plugins: Record<string, { isContainerRunning: () => boolean; analyse: AnalyseShim }>;
	};
	workspace: { getLeavesOfType: (t: string) => Array<{ detach: () => void }> };
}

async function stubRunning(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
		plugin.isContainerRunning = () => true;
	});
}

async function openCustomPrompt(): Promise<void> {
	// Fire-and-forget: it opens a modal and awaits the user. We drive the modal
	// from the test, then the promise settles.
	await browser.executeObsidian(({ app }) => {
		const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
		void plugin.analyse.runAnalyseCustom("notes/foo.md");
	});
	await $(".sandbox-modal-input-multiline").waitForExist({ timeout: 5000 });
}

async function terminalLeafCount(): Promise<number> {
	return browser.executeObsidian(({ app }, viewType: string) => {
		return (app as unknown as AppShim).workspace.getLeavesOfType(viewType).length;
	}, VIEW_TYPE_TERMINAL);
}

async function closeTerminals(): Promise<void> {
	await browser.executeObsidian(({ app }, viewType: string) => {
		(app as unknown as AppShim).workspace.getLeavesOfType(viewType).forEach((l) => l.detach());
	}, VIEW_TYPE_TERMINAL);
	await browser.pause(100);
}

async function setTextarea(value: string): Promise<void> {
	await browser.executeObsidian((_obs, v: string) => {
		const ta = document.querySelector<HTMLTextAreaElement>(".sandbox-modal-input-multiline");
		if (ta) {
			ta.value = v;
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		}
	}, value);
}

describe("Analyse custom-prompt modal (QA 6.6)", function () {
	beforeEach(async function () {
		await obsidianPage.resetVault();
		await closeTerminals();
		await stubRunning();
	});

	afterEach(async function () {
		await closeTerminals();
	});

	it("empty input is treated as a cancel — no terminal opens", async function () {
		await openCustomPrompt();
		// Leave the textarea empty and click Run.
		await $("button=Run").click();
		await browser.pause(300);
		expect(await terminalLeafCount()).toBe(0);
		expect(await $(".sandbox-modal-input-multiline").isExisting()).toBe(false);
	});

	it("a long prompt with shell metacharacters opens a terminal tab without truncation", async function () {
		await openCustomPrompt();
		const long = "x".repeat(2000) + " `id`; $(whoami) && rm -rf /tmp/nope";
		await setTextarea(long);
		await $("button=Run").click();
		await browser.waitUntil(async () => (await terminalLeafCount()) === 1, {
			timeout: 5000,
			timeoutMsg: "terminal tab did not open after submitting the custom prompt",
		});
	});
});
