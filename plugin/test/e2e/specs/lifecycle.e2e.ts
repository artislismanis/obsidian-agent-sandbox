import { browser, expect } from "@wdio/globals";
import { describe, it, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

// QA plan 2.1 / 2.2 / 2.3 / 2.5 / 2.11a / 1.7a — container lifecycle wiring.
//
// These exercise the plugin's start/stop ORCHESTRATION against a stubbed
// DockerManager (no real Docker): does auto-start drive the status bar through
// the four startup phases to Running, does the quit hook honour the auto-stop
// setting, does plugin-disable always stop the container, and does a ttyd port
// conflict abort the start with the right Notice. The real `docker compose`
// round-trip is covered by the integration tier; the command-building logic is
// unit-tested (docker-command.test.ts). 1.7b (MCP reactive port failure) lives
// with the MCP specs since it manipulates the live MCP server.

const PLUGIN_ID = "agent-sandbox";

interface DockerShim {
	ensureWslReady: () => Promise<void>;
	probeIsRunning: () => Promise<boolean>;
	hasAnyContainer: () => Promise<boolean>;
	checkStartupConflicts: (ports: number[], host: string) => Promise<number[]>;
	getContainerId: () => Promise<string>;
	start: () => Promise<string>;
	stop: () => Promise<string>;
	stopDetached: () => void;
	isBusy: () => boolean;
}

interface StatusBarShim {
	setDetails: (d: string) => void;
	getState: () => string;
}

interface PluginShim {
	docker: DockerShim;
	statusBar: StatusBarShim;
	settings: { autoStartContainer: boolean; autoStopContainer: boolean; ttydBindAddress: string };
	ensureWriteDir: () => Promise<void>;
	backgroundStartup: () => Promise<void>;
	startContainer: () => Promise<void>;
	applyFirewallAfterStart: () => Promise<void>;
	checkTtydReachability: () => Promise<void>;
	startHealthPoll: () => void;
}

interface AppShim {
	plugins: { plugins: Record<string, PluginShim>; enabledPlugins: Set<string> };
	workspace: { trigger: (name: string, ...args: unknown[]) => void };
}

declare global {
	interface Window {
		__oasStopDetached?: number;
	}
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

function isEnabled(): Promise<boolean> {
	return browser.executeObsidian(({ app }) =>
		(app as unknown as AppShim).plugins.enabledPlugins.has("agent-sandbox"),
	);
}

/** Assert `needles` appear in `haystack` in the given relative order. */
function expectOrdered(haystack: string[], needles: string[]): void {
	let idx = -1;
	for (const needle of needles) {
		const at = haystack.findIndex((h, i) => i > idx && h.includes(needle));
		if (at <= idx) {
			throw new Error(
				`phase "${needle}" not found after index ${idx} in ${JSON.stringify(haystack)}`,
			);
		}
		idx = at;
	}
}

describe("Container lifecycle wiring (QA 2.1 / 2.2 / 2.3 / 2.5 / 2.11a / 1.7a)", function () {
	afterEach(async function () {
		await clearNotices();
	});

	it("2.1 / 2.11a: auto-start drives the status bar to Running through the four startup phases", async function () {
		const result = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			const phases: string[] = [];
			const realSetDetails = plugin.statusBar.setDetails.bind(plugin.statusBar);
			plugin.statusBar.setDetails = (d: string) => {
				phases.push(d);
				realSetDetails(d);
			};
			plugin.docker.ensureWslReady = async () => {};
			plugin.docker.probeIsRunning = async () => false;
			plugin.docker.checkStartupConflicts = async () => [];
			plugin.docker.start = async () => "";
			plugin.docker.getContainerId = async () => "abc123def456";
			plugin.ensureWriteDir = async () => {};
			// Neutralise slow / irrelevant post-start work so the test is
			// deterministic (no real ttyd poll, no firewall probe, no interval).
			plugin.applyFirewallAfterStart = async () => {};
			plugin.checkTtydReachability = async () => {};
			plugin.startHealthPoll = () => {};
			plugin.settings.autoStartContainer = true;

			await plugin.backgroundStartup();
			const state = plugin.statusBar.getState();
			plugin.statusBar.setDetails = realSetDetails;
			return { phases, state };
		});

		expect(result.state).toBe("running");
		expectOrdered(result.phases, [
			"checking Docker availability",
			"probing WSL",
			"probing container status",
			"docker compose up -d (auto-start)",
		]);
	});

	it("2.1: with auto-start off the container stays stopped and never issues the auto-start phase", async function () {
		const result = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			const phases: string[] = [];
			const realSetDetails = plugin.statusBar.setDetails.bind(plugin.statusBar);
			plugin.statusBar.setDetails = (d: string) => {
				phases.push(d);
				realSetDetails(d);
			};
			let startCalls = 0;
			plugin.docker.ensureWslReady = async () => {};
			plugin.docker.probeIsRunning = async () => false;
			plugin.docker.start = async () => {
				startCalls++;
				return "";
			};
			plugin.startHealthPoll = () => {};
			plugin.settings.autoStartContainer = false;

			await plugin.backgroundStartup();
			const state = plugin.statusBar.getState();
			plugin.statusBar.setDetails = realSetDetails;
			return { phases, state, startCalls };
		});

		expect(result.startCalls).toBe(0);
		expect(result.state).toBe("stopped");
		expect(result.phases.some((p) => p.includes("auto-start"))).toBe(false);
	});

	it("2.2: the quit hook stops the container when auto-stop is on", async function () {
		const stopCalls = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			let stop = 0;
			plugin.docker.stop = async () => {
				stop++;
				return "";
			};
			plugin.docker.isBusy = () => false;
			plugin.settings.autoStopContainer = true;

			const collected: Array<() => Promise<void>> = [];
			const tasks = { add: (fn: () => Promise<void>) => collected.push(fn) };
			(app as unknown as AppShim).workspace.trigger("quit", tasks);
			for (const fn of collected) await fn();
			return stop;
		});

		expect(stopCalls).toBe(1);
	});

	it("2.3: the quit hook leaves the container running when auto-stop is off", async function () {
		const stopCalls = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			let stop = 0;
			plugin.docker.stop = async () => {
				stop++;
				return "";
			};
			plugin.docker.isBusy = () => false;
			plugin.settings.autoStopContainer = false;

			const collected: Array<() => Promise<void>> = [];
			const tasks = { add: (fn: () => Promise<void>) => collected.push(fn) };
			(app as unknown as AppShim).workspace.trigger("quit", tasks);
			for (const fn of collected) await fn();
			return stop;
		});

		expect(stopCalls).toBe(0);
	});

	it("1.7a: a ttyd port conflict aborts the start with a Port conflict Notice", async function () {
		const startCalls = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.docker.isBusy = () => false;
			plugin.docker.checkStartupConflicts = async () => [7681];
			plugin.docker.probeIsRunning = async () => false;
			plugin.docker.hasAnyContainer = async () => false;
			let started = 0;
			plugin.docker.start = async () => {
				started++;
				return "";
			};
			plugin.settings.ttydBindAddress = "127.0.0.1";
			await plugin.startContainer();
			return started;
		});

		const notices = await noticeTexts();
		expect(
			notices.some(
				(t) =>
					t.includes("Port conflict: 7681") && t.includes("already in use on 127.0.0.1"),
			),
		).toBe(true);
		// start() must never run when a conflict is detected up front.
		expect(startCalls).toBe(0);
	});

	// Defined last: disabling re-creates the plugin instance on re-enable,
	// wiping the per-test stubs above. No resetVault() — it would drop the
	// on-disk plugin install and make enablePlugin() a no-op.
	it("2.5: disabling the plugin always stops the container", async function () {
		await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			window.__oasStopDetached = 0;
			plugin.docker.stopDetached = () => {
				window.__oasStopDetached = (window.__oasStopDetached ?? 0) + 1;
			};
		});

		await obsidianPage.disablePlugin(PLUGIN_ID);
		await browser.waitUntil(async () => (await isEnabled()) === false, {
			timeout: 5000,
			timeoutMsg: "plugin did not disable",
		});

		// onunload() awaits mcpLifecycle.shutdown() + saveData() before calling
		// stopDetached() - Obsidian's Plugin.unload() doesn't await onunload()'s
		// returned promise, so isEnabled() can flip false before stopDetached() runs.
		await browser.waitUntil(
			async () => (await browser.executeObsidian(() => window.__oasStopDetached ?? -1)) === 1,
			{ timeout: 5000, timeoutMsg: "stopDetached was not called exactly once" },
		);

		// Restore for any later specs in the run.
		await obsidianPage.enablePlugin(PLUGIN_ID);
		await browser.waitUntil(async () => (await isEnabled()) === true, {
			timeout: 5000,
			timeoutMsg: "plugin did not re-enable",
		});
	});
});
