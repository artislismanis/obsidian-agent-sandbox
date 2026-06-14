import { browser, expect } from "@wdio/globals";
import { describe, it, beforeEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

// QA plan 2.13 (running tooltip content) + 5.1–5.4 (awaiting-input tooltip text).
//
// The tooltip-composition logic is unit-tested (status-bar.test.ts). What stays
// manual there is that the composed string actually lands in the live DOM (the
// pill's aria-label) and that the running-state path composes at all (it only
// runs when state === "running"). These drive the real StatusBarManager and read
// the live aria-label.
//
// Each scenario sets state + reads the aria-label inside a SINGLE executeObsidian
// call, so the plugin's background health poll can't race in and overwrite the
// tooltip between the set and the read.

interface StatusBarShim {
	setState: (s: "stopped" | "starting" | "running" | "error" | "checking") => void;
	setRunningTooltipContext: (ctx: {
		port: number;
		firewall: "enabled" | "disabled" | "hidden";
		mcp: { running: boolean; port: number; toolCount: number };
		pendingRestart?: boolean;
	}) => void;
	setAttention: (count: number, names?: string[]) => void;
}

interface AppShim {
	plugins: { plugins: Record<string, { statusBar: StatusBarShim }> };
}

describe("Status-bar tooltip text (QA 2.13 / 5.1–5.4)", function () {
	beforeEach(async function () {
		await obsidianPage.resetVault();
	});

	it("2.13: the running tooltip lists container / port / firewall / MCP", async function () {
		const tooltip = await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.statusBar.setState("running");
			plugin.statusBar.setAttention(0, []);
			plugin.statusBar.setRunningTooltipContext({
				port: 7681,
				firewall: "enabled",
				mcp: { running: true, port: 28080, toolCount: 42 },
			});
			return document.querySelector(".sandbox-status-bar")?.getAttribute("aria-label") ?? "";
		});

		expect(tooltip).toContain("Container: running");
		expect(tooltip).toContain("Port: 7681");
		expect(tooltip).toContain("Firewall: enabled");
		expect(tooltip).toContain("MCP: port 28080, 42 tools");
	});

	it("5.1–5.4: an awaiting-input session names the session, and clears cleanly", async function () {
		const result = await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.statusBar.setState("running");
			plugin.statusBar.setRunningTooltipContext({
				port: 7681,
				firewall: "disabled",
				mcp: { running: true, port: 28080, toolCount: 10 },
			});
			const read = () =>
				document.querySelector(".sandbox-status-bar")?.getAttribute("aria-label") ?? "";

			plugin.statusBar.setAttention(1, ["work"]);
			const awaiting = read();
			const awaitingText = document.querySelector(".sandbox-status-bar")?.textContent ?? "";

			plugin.statusBar.setAttention(0, []);
			const cleared = read();
			const clearedText = document.querySelector(".sandbox-status-bar")?.textContent ?? "";

			return { awaiting, awaitingText, cleared, clearedText };
		});

		// Awaiting: the tooltip names the waiting session and the pill grows a bell.
		expect(result.awaiting).toContain("1 session(s) awaiting input: work");
		expect(result.awaitingText).toContain("🔔"); // 🔔
		// Cleared: back to the default running tooltip, no stale awaiting string, no bell.
		expect(result.cleared).toContain("Container: running");
		expect(result.cleared).not.toContain("awaiting input");
		expect(result.clearedText).not.toContain("🔔");
	});
});
