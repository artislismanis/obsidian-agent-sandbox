import { browser, expect } from "@wdio/globals";
import { describe, it, before, beforeEach, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

// QA plan 5.6 / 5.8 / 5.9 — AgentOutputNotifier live wiring.
//
// The notifier's debounce / rate-limit / toggle logic is unit-tested with fake
// timers (src/__tests__/activity.test.ts). What that can't prove is the LIVE
// chain: a real vault create/modify event → the registered vault listener →
// AgentOutputNotifier → a real Notice in the DOM. These specs drive genuine
// vault operations (app.vault.create / modify) and assert the rendered Notice.
//
// 5.7 (rate-limit requeue) needs two bursts spaced >5 s apart; its exact timing
// is covered deterministically by the unit test, so it is intentionally NOT
// reproduced here as a real-timer e2e (it would be CI-flaky).

interface SettingsShim {
	notifyCreated: boolean;
	notifyEdited: boolean;
	notifyDeleted: boolean;
	notifyRenamed: boolean;
	notifyVaultWide: boolean;
}

interface AppShim {
	plugins: { plugins: Record<string, { settings: SettingsShim }> };
	vault: {
		create: (path: string, data: string) => Promise<unknown>;
		modify: (file: unknown, data: string) => Promise<void>;
		getFileByPath: (path: string) => unknown;
		getMarkdownFiles: () => Array<{ path: string }>;
	};
}

async function setNotifyToggles(s: Partial<SettingsShim>): Promise<void> {
	await browser.executeObsidian(({ app }, patch: Partial<SettingsShim>) => {
		const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
		Object.assign(plugin.settings, patch);
	}, s);
}

async function noticeTexts(): Promise<string[]> {
	return browser.executeObsidian(() =>
		Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""),
	);
}

async function clearNotices(): Promise<void> {
	await browser.executeObsidian(() =>
		document.querySelectorAll(".notice").forEach((n) => n.remove()),
	);
}

async function createFiles(paths: string[]): Promise<void> {
	await browser.executeObsidian(async ({ app }, ps: string[]) => {
		const vault = (app as unknown as AppShim).vault;
		// Fire the burst near-simultaneously so all events land in one debounce
		// window and aggregate into a single notice.
		await Promise.all(ps.map((p) => vault.create(p, "x")));
	}, paths);
}

async function modifyFirstMarkdown(content: string): Promise<void> {
	await browser.executeObsidian(async ({ app }, data: string) => {
		const vault = (app as unknown as AppShim).vault;
		const file = vault.getMarkdownFiles()[0];
		if (file) await vault.modify(file, data);
	}, content);
}

describe("AgentOutputNotifier live wiring (QA 5.6 / 5.8 / 5.9)", function () {
	before(async function () {
		// The vault create/modify listeners are registered ~2 s after
		// layout-ready (main.ts defers them so the initial vault scan doesn't
		// raise notices). Wait once so the first event-firing test below sees
		// them attached — otherwise the first burst is silently dropped.
		await browser.pause(2500);
	});

	beforeEach(async function () {
		await obsidianPage.resetVault();
		// Vault-wide so synthetic files at the vault root count as in-scope
		// regardless of the write-directory setting.
		await setNotifyToggles({
			notifyCreated: true,
			notifyEdited: false,
			notifyDeleted: false,
			notifyRenamed: false,
			notifyVaultWide: true,
		});
		await clearNotices();
	});

	afterEach(async function () {
		await clearNotices();
	});

	it("5.6: a burst of creates aggregates into one debounced Notice", async function () {
		await createFiles(["aout-a.md", "aout-b.md", "aout-c.md"]);
		// DEBOUNCE_MS is 2000; wait past it for the single aggregated notice.
		await browser.waitUntil(
			async () => (await noticeTexts()).some((t) => t.includes("Agent output: 3 created")),
			{ timeout: 8000, timeoutMsg: "aggregated '3 created' notice never appeared" },
		);
		// Exactly one agent-output notice, not three.
		const agentNotices = (await noticeTexts()).filter((t) => t.includes("Agent output:"));
		expect(agentNotices.length).toBe(1);
	});

	it("5.8: with notifyEdited on, a modify fires a Notice", async function () {
		await setNotifyToggles({ notifyCreated: false, notifyEdited: true });
		await modifyFirstMarkdown("changed by test");
		await browser.waitUntil(
			async () => (await noticeTexts()).some((t) => t.includes("Agent modified")),
			{ timeout: 6000, timeoutMsg: "modify notice never appeared" },
		);
	});

	it("5.9: all toggles off → no Notice fires", async function () {
		await setNotifyToggles({
			notifyCreated: false,
			notifyEdited: false,
			notifyDeleted: false,
			notifyRenamed: false,
		});
		await createFiles(["aout-silent.md"]);
		// Wait well past the debounce window; nothing should fire.
		await browser.pause(3000);
		expect((await noticeTexts()).some((t) => t.startsWith("Agent"))).toBe(false);
	});
});
