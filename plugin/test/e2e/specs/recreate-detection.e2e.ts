import { browser, expect } from "@wdio/globals";
import { describe, it, afterEach } from "mocha";

// QA plan 2.12 / 2.4 — container-recreate detection + handling.
//
// The plugin polls docker.getContainerId() and, when the id changes out from
// under it, warns the user and detaches stale terminal leaves (2.12); an
// explicit config-change restart recreates the container and rebaselines the id
// (2.4). Both are driven against a stubbed DockerManager — the real
// `docker compose down/up` round-trip and named-volume persistence are covered
// by the integration tier (test/integration/container-restart.test.ts). This
// asserts the plugin's reaction logic.

interface DockerShim {
	getContainerId: () => Promise<string>;
	restart: () => Promise<string>;
	isBusy: () => boolean;
}

interface StatusBarShim {
	getState: () => string;
}

interface PluginShim {
	docker: DockerShim;
	statusBar: StatusBarShim;
	lastKnownContainerId: string;
	checkContainerIdDrift: () => Promise<void>;
	restartContainer: () => Promise<void>;
	applyFirewallAfterStart: () => Promise<void>;
	checkTtydReachability: () => Promise<void>;
	startHealthPoll: () => void;
}

interface AppShim {
	plugins: { plugins: Record<string, PluginShim> };
	workspace: { detachLeavesOfType: (t: string) => void };
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

describe("Container recreate detection (QA 2.12 / 2.4)", function () {
	afterEach(async function () {
		await clearNotices();
	});

	it("2.12: an out-of-band container-id change warns and detaches stale terminals", async function () {
		const result = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
			let detachCount = 0;
			const realDetach = (app as unknown as AppShim).workspace.detachLeavesOfType.bind(
				(app as unknown as AppShim).workspace,
			);
			(app as unknown as AppShim).workspace.detachLeavesOfType = (t: string) => {
				detachCount++;
				realDetach(t);
			};
			plugin.lastKnownContainerId = "old-id-111";
			plugin.docker.getContainerId = async () => "new-id-222";

			await plugin.checkContainerIdDrift();

			(app as unknown as AppShim).workspace.detachLeavesOfType = realDetach;
			return { detachCount, lastId: plugin.lastKnownContainerId };
		});

		expect((await noticeTexts()).some((t) => t.includes("recreated outside the plugin"))).toBe(
			true,
		);
		expect(result.detachCount).toBe(1);
		// The baseline rebases to the new id so the warning fires once, not every poll.
		expect(result.lastId).toBe("new-id-222");
	});

	it("2.12: an unchanged container id is a no-op (no warning, no detach)", async function () {
		const result = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
			let detachCount = 0;
			const realDetach = (app as unknown as AppShim).workspace.detachLeavesOfType.bind(
				(app as unknown as AppShim).workspace,
			);
			(app as unknown as AppShim).workspace.detachLeavesOfType = (t: string) => {
				detachCount++;
				realDetach(t);
			};
			plugin.lastKnownContainerId = "steady-id-999";
			plugin.docker.getContainerId = async () => "steady-id-999";

			await plugin.checkContainerIdDrift();

			(app as unknown as AppShim).workspace.detachLeavesOfType = realDetach;
			return { detachCount, lastId: plugin.lastKnownContainerId };
		});

		expect((await noticeTexts()).some((t) => t.includes("recreated outside the plugin"))).toBe(
			false,
		);
		expect(result.detachCount).toBe(0);
		expect(result.lastId).toBe("steady-id-999");
	});

	it("2.4: a config-change restart recreates the container and rebaselines the id", async function () {
		const result = await browser.executeObsidian(async ({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
			plugin.docker.isBusy = () => false;
			plugin.docker.restart = async () => "";
			plugin.docker.getContainerId = async () => "recreated-333";
			plugin.applyFirewallAfterStart = async () => {};
			plugin.checkTtydReachability = async () => {};
			plugin.startHealthPoll = () => {};
			plugin.lastKnownContainerId = "before-000";

			await plugin.restartContainer();
			return { lastId: plugin.lastKnownContainerId, state: plugin.statusBar.getState() };
		});

		expect(result.state).toBe("running");
		expect(result.lastId).toBe("recreated-333");
		expect((await noticeTexts()).some((t) => t.includes("Sandbox container restarted."))).toBe(
			true,
		);
	});
});
