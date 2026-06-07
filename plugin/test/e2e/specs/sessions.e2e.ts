import { browser, expect, $ } from "@wdio/globals";
import { describe, it, beforeEach, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

// QA plan 5.10/5.11/5.12 — session switcher + detached-session cleanup. Both UIs
// are pure Obsidian (no container): the switcher enumerates open terminal tabs
// and the cleanup modal takes an injected SessionCleanupApi. activateTerminalView
// has no container guard (it just setViewState()s a leaf), so we can build named
// terminal tabs headlessly; the WebSocket attach fails harmlessly with no ttyd.
// For 5.12 we stub docker.listDetachedSessions/killSession + isContainerRunning
// on the live plugin so the modal + aggregate Notice run without real tmux (the
// real kill stays manual — see docs/qa-test-plan.md 5.12).

const PLUGIN_ID = "obsidian-agent-sandbox";
const SWITCH_CMD = `${PLUGIN_ID}:sandbox-switch-session`;
const CLEANUP_CMD = `${PLUGIN_ID}:sandbox-cleanup-sessions`;
const VIEW_TYPE_TERMINAL = "agent-sandbox-terminal-view";

interface PluginShim {
	activateTerminalView: (name?: string) => Promise<unknown>;
	isContainerRunning: () => boolean;
	docker: {
		listDetachedSessions: () => Promise<string[]>;
		killSession: (name: string) => Promise<void>;
	};
	__killed?: string[];
}

interface AppShim {
	plugins: { plugins: Record<string, PluginShim> };
	workspace: {
		getLeavesOfType: (t: string) => Array<{ view: { getSessionName?: () => string | null } }>;
	};
}

/** Open one terminal tab per name; `undefined` makes an unnamed tab. */
async function openTerminals(names: Array<string | undefined>): Promise<void> {
	await browser.executeObsidian(async ({ app }, ns: Array<string | undefined>) => {
		const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
		for (const n of ns) await plugin.activateTerminalView(n);
	}, names);
	await browser.pause(300);
}

/** Detach every open sandbox-terminal leaf so each test starts clean. */
async function closeTerminals(): Promise<void> {
	await browser.executeObsidian(({ app }, viewType: string) => {
		const ws = (
			app as unknown as {
				workspace: { getLeavesOfType: (t: string) => Array<{ detach: () => void }> };
			}
		).workspace;
		ws.getLeavesOfType(viewType).forEach((l) => l.detach());
	}, VIEW_TYPE_TERMINAL);
	await browser.pause(100);
}

async function closeAllModals(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		const open = await browser.executeObsidian(
			() => document.querySelectorAll(".modal-container").length,
		);
		if (open === 0) return;
		await browser.keys("Escape");
		await browser.pause(150);
	}
}

/** Visible row labels in the switcher modal (div.sandbox-modal-row-clickable). */
async function switcherRows(): Promise<string[]> {
	return browser.executeObsidian(() =>
		Array.from(document.querySelectorAll(".sandbox-modal-row-clickable")).map(
			(r) => r.textContent ?? "",
		),
	);
}

async function noticeTexts(): Promise<string[]> {
	return browser.executeObsidian(() =>
		Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""),
	);
}

/** Session name of the currently active leaf's view, if it's a terminal. */
async function activeSessionName(): Promise<string | null> {
	return browser.executeObsidian(({ app }) => {
		const ws = (
			app as unknown as {
				workspace: { activeLeaf?: { view?: { getSessionName?: () => string | null } } };
			}
		).workspace;
		return ws.activeLeaf?.view?.getSessionName?.() ?? null;
	});
}

describe("Session switcher (QA 5.10/5.11)", function () {
	beforeEach(async function () {
		await obsidianPage.resetVault();
		await closeTerminals();
	});

	afterEach(async function () {
		await closeAllModals();
		await closeTerminals();
	});

	it("lists open terminal tabs by session name, with (unnamed) for the anonymous one", async function () {
		await openTerminals(["work", "research", undefined]);
		await browser.executeObsidianCommand(SWITCH_CMD);
		await $(".sandbox-modal-filter").waitForExist({ timeout: 3000 });

		const rows = await switcherRows();
		expect(rows).toContain("Session: work");
		expect(rows).toContain("Session: research");
		expect(rows).toContain("Session: (unnamed)");
	});

	it("filters the list as you type", async function () {
		await openTerminals(["work", "research"]);
		await browser.executeObsidianCommand(SWITCH_CMD);
		const filter = $(".sandbox-modal-filter");
		await filter.waitForExist({ timeout: 3000 });
		await filter.setValue("work");
		await browser.pause(200);

		const rows = await switcherRows();
		expect(rows).toEqual(["Session: work"]);
	});

	it("selecting a row activates the matching tab", async function () {
		await openTerminals(["work", "research"]);
		await browser.executeObsidianCommand(SWITCH_CMD);
		await $(".sandbox-modal-filter").waitForExist({ timeout: 3000 });

		await browser.executeObsidian((_app, label: string) => {
			const rows = Array.from(document.querySelectorAll(".sandbox-modal-row-clickable"));
			const row = rows.find((r) => (r.textContent ?? "").includes(label));
			(row as HTMLElement | undefined)?.click();
		}, "Session: research");
		await browser.pause(300);

		expect(await activeSessionName()).toBe("research");
	});

	it("5.11: clicking a row whose tab closed mid-modal shows 'That session has closed.'", async function () {
		await openTerminals(["work", "research"]);
		await browser.executeObsidianCommand(SWITCH_CMD);
		await $(".sandbox-modal-filter").waitForExist({ timeout: 3000 });

		// Close the 'research' tab from under the open modal, then click its
		// still-rendered row. The click handler revalidates the leaf and bails.
		await browser.executeObsidian(({ app }, viewType: string) => {
			const ws = (
				app as unknown as {
					workspace: {
						getLeavesOfType: (t: string) => Array<{
							detach: () => void;
							view: { getSessionName?: () => string | null };
						}>;
					};
				}
			).workspace;
			const leaf = ws
				.getLeavesOfType(viewType)
				.find((l) => l.view.getSessionName?.() === "research");
			leaf?.detach();
		}, VIEW_TYPE_TERMINAL);
		await browser.pause(150);

		await browser.executeObsidian((_app, label: string) => {
			const rows = Array.from(document.querySelectorAll(".sandbox-modal-row-clickable"));
			const row = rows.find((r) => (r.textContent ?? "").includes(label));
			(row as HTMLElement | undefined)?.click();
		}, "Session: research");
		await browser.pause(200);

		expect((await noticeTexts()).some((t) => t.includes("That session has closed."))).toBe(
			true,
		);
	});
});

describe("Detached-session cleanup (QA 5.12)", function () {
	beforeEach(async function () {
		await obsidianPage.resetVault();
	});

	afterEach(async function () {
		await closeAllModals();
	});

	/** Stub the container probe + the docker session API on the live plugin. */
	async function stubSessions(detached: string[]): Promise<void> {
		await browser.executeObsidian(({ app }, names: string[]) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
			plugin.__killed = [];
			plugin.isContainerRunning = () => true;
			plugin.docker.listDetachedSessions = async () => names;
			plugin.docker.killSession = async (name: string) => {
				plugin.__killed?.push(name);
			};
		}, detached);
	}

	async function killedNames(): Promise<string[]> {
		return browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
			return plugin.__killed ?? [];
		});
	}

	it("lists only the detached candidates, kills the still-checked ones, and reports the count", async function () {
		await stubSessions(["detached-a", "detached-b"]);
		await browser.executeObsidianCommand(CLEANUP_CMD);
		await $(".sandbox-modal-check-list").waitForExist({ timeout: 3000 });

		const rows = await browser.executeObsidian(() =>
			Array.from(document.querySelectorAll(".sandbox-modal-check-row span")).map(
				(s) => s.textContent ?? "",
			),
		);
		expect(rows.sort()).toEqual(["detached-a", "detached-b"]);

		// Uncheck the first candidate so only one is killed.
		await browser.executeObsidian(() => {
			const cb = document.querySelector(
				".sandbox-modal-check-row input[type=checkbox]",
			) as HTMLInputElement | null;
			if (cb?.checked) cb.click();
		});

		const killBtn = $("button=Kill selected");
		await killBtn.waitForExist({ timeout: 3000 });
		await killBtn.click();
		await browser.pause(300);

		const killed = await killedNames();
		expect(killed).toHaveLength(1);
		expect((await noticeTexts()).some((t) => t.includes("Killed 1/1 session(s)."))).toBe(true);
	});

	it("reports no candidates when nothing is detached", async function () {
		await stubSessions([]);
		await browser.executeObsidianCommand(CLEANUP_CMD);
		await browser.pause(300);

		expect(
			(await noticeTexts()).some((t) => t.includes("No detached tmux sessions to clean up.")),
		).toBe(true);
	});

	// QA 5.13 — a name that fails validation makes its kill reject; the failure is
	// counted (not swallowed) so the aggregate reads 1/2. The real killSession
	// runs assertSafeSessionName first; we mirror that regex in the stub so the
	// invalid name rejects without a container (the regex itself is unit-tested in
	// validation.test.ts).
	it("5.13: an invalid session name fails its kill and the aggregate reports 1/2", async function () {
		await browser.executeObsidian(
			({ app }, names: string[]) => {
				const plugin = (app as unknown as AppShim).plugins.plugins[
					"obsidian-agent-sandbox"
				];
				plugin.__killed = [];
				plugin.isContainerRunning = () => true;
				plugin.docker.listDetachedSessions = async () => names;
				plugin.docker.killSession = async (name: string) => {
					if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid session name: ${name}`);
					plugin.__killed?.push(name);
				};
			},
			["validname", "bad name"],
		);

		await browser.executeObsidianCommand(CLEANUP_CMD);
		await $(".sandbox-modal-check-list").waitForExist({ timeout: 3000 });

		// Both rows stay checked (default); kill the lot.
		const killBtn = $("button=Kill selected");
		await killBtn.waitForExist({ timeout: 3000 });
		await killBtn.click();
		await browser.pause(300);

		const killed = await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
			return plugin.__killed ?? [];
		});
		expect(killed).toEqual(["validname"]);
		expect((await noticeTexts()).some((t) => t.includes("Killed 1/2 session(s)."))).toBe(true);
	});
});
