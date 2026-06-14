import { browser, expect } from "@wdio/globals";
import { describe, it, beforeEach, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

// QA plan 1.5 / 2.14 / 2.15 / 8.1 — command → Notice / status-bar surfacing.
//
// These exercise the UI WIRING (command fires → the right Notice text / pill
// state renders), not the real Docker/daemon/firewall path. The runtime layer
// (plugin.docker.*) is stubbed via executeObsidian so the scenarios are
// deterministic and need no container. The underlying classifier / formatter /
// URL-builder logic is unit-tested separately (docker.test.ts classifyCommandError,
// format.test.ts buildContainerStatusLines, ttyd-client.test.ts resolveTtydBrowserUrl).

const PLUGIN_ID = "agent-sandbox";
const START_CMD = `${PLUGIN_ID}:sandbox-start-container`;
const STATUS_CMD = `${PLUGIN_ID}:sandbox-container-status`;
const FIREWALL_CMD = `${PLUGIN_ID}:sandbox-toggle-firewall`;

interface DockerShim {
	start: () => Promise<string>;
	status: () => Promise<string>;
	getContainerInfo: () => Promise<{ id: string; image: string; startedAt: string } | null>;
	getContainerId: () => Promise<string>;
	checkStartupConflicts: (ports: number[], host: string) => Promise<number[]>;
	enableFirewall: () => Promise<string>;
	disableFirewall: () => Promise<string>;
	firewallStatus: () => Promise<string>;
}

interface FirewallBarShim {
	setState: (s: "hidden" | "enabled" | "disabled") => void;
	getState: () => string;
}

interface PluginShim {
	docker: DockerShim;
	firewallBar: FirewallBarShim;
	ensureWriteDir: () => Promise<void>;
	settings: { ttydPort: number; ttydBindAddress: string };
}

interface AppShim {
	plugins: { plugins: Record<string, PluginShim> };
}

async function noticeTexts(): Promise<string[]> {
	return browser.executeObsidian(() =>
		Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""),
	);
}

async function sandboxPillText(): Promise<string> {
	return browser.executeObsidian(() => {
		const items = Array.from(document.querySelectorAll(".status-bar-item"));
		return items.find((e) => e.textContent?.includes("Sandbox"))?.textContent ?? "";
	});
}

async function firewallPillAria(): Promise<string> {
	return browser.executeObsidian(
		() => document.querySelector(".sandbox-firewall-status")?.getAttribute("aria-label") ?? "",
	);
}

async function clearNotices(): Promise<void> {
	await browser.executeObsidian(() =>
		document.querySelectorAll(".notice").forEach((n) => n.remove()),
	);
}

/** Stub the whole docker surface these scenarios touch, plus the write-dir side effect. */
async function stubDocker(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
		plugin.ensureWriteDir = async () => {};
		// No port conflicts so startContainer reaches runDockerCommand.
		plugin.docker.checkStartupConflicts = async () => [];
		plugin.docker.getContainerId = async () => "abc123def456";
	});
}

describe("Command → Notice / pill surfacing (QA 1.5 / 2.14 / 2.15 / 8.1)", function () {
	beforeEach(async function () {
		await obsidianPage.resetVault();
		await stubDocker();
		await clearNotices();
	});

	afterEach(async function () {
		await clearNotices();
	});

	it("1.5: a start failure surfaces a 'Failed to start container' Notice and an error pill", async function () {
		await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.docker.start = async () => {
				throw new Error(
					"Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
				);
			};
		});

		await browser.executeObsidianCommand(START_CMD);
		await browser.waitUntil(
			async () => (await noticeTexts()).some((t) => t.includes("Failed to start container")),
			{ timeout: 4000, timeoutMsg: "'Failed to start container' notice never appeared" },
		);

		// STATE_DISPLAY.error === "Sandbox: ⚠ Error"
		await browser.waitUntil(async () => (await sandboxPillText()).includes("Error"), {
			timeout: 4000,
			timeoutMsg: "status-bar pill never reached the error state",
		});
	});

	it("2.14 (running): Container Status fires a multi-line Notice with ID / image / MCP / firewall", async function () {
		await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.docker.status = async () => '[{"State":"running"}]';
			plugin.docker.getContainerInfo = async () => ({
				id: "abc123def4567890",
				image: "oas-sandbox:latest",
				startedAt: "2026-01-01T00:00:00.000000000Z",
			});
		});

		await browser.executeObsidianCommand(STATUS_CMD);
		await browser.waitUntil(
			async () => (await noticeTexts()).some((t) => t.includes("Sandbox: Running")),
			{ timeout: 4000, timeoutMsg: "'Sandbox: Running' status notice never appeared" },
		);

		const notices = await noticeTexts();
		const status = notices.find((t) => t.includes("Sandbox: Running"));
		expect(status).toBeDefined();
		expect(status).toContain("ID: abc123def456"); // truncated to 12 chars
		expect(status).toContain("Image: oas-sandbox:latest");
		expect(status).toContain("MCP:");
		expect(status).toContain("Firewall:");
	});

	it("2.14 (stopped): Container Status reports a stopped Notice", async function () {
		await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.docker.status = async () => "";
		});

		await browser.executeObsidianCommand(STATUS_CMD);
		await browser.waitUntil(
			async () => (await noticeTexts()).some((t) => t.includes("Sandbox: Stopped")),
			{ timeout: 4000, timeoutMsg: "'Sandbox: Stopped' status notice never appeared" },
		);

		expect((await noticeTexts()).some((t) => t.includes("Sandbox: Stopped"))).toBe(true);
	});

	it("2.15: Open in Browser calls window.open with the resolved ttyd URL", async function () {
		const opened = await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.settings.ttydPort = 7681;
			plugin.settings.ttydBindAddress = "127.0.0.1";
			let captured = "";
			const realOpen = window.open;
			window.open = ((url?: string | URL) => {
				captured = String(url ?? "");
				return null;
			}) as typeof window.open;
			try {
				// fire synchronously while the spy is installed
				(
					app as unknown as {
						commands: { executeCommandById: (id: string) => boolean };
					}
				).commands.executeCommandById("obsidian-agent-sandbox:open-browser");
			} finally {
				window.open = realOpen;
			}
			return captured;
		});

		expect(opened).toBe("http://localhost:7681");
	});

	it("8.1: toggling the firewall flips the pill state and fires a Notice", async function () {
		// Firewall pill must be visible (non-hidden) for the toggle to act.
		await browser.executeObsidian(({ app }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.firewallBar.setState("disabled");
			plugin.docker.enableFirewall = async () => "";
			plugin.docker.disableFirewall = async () => "";
		});

		await browser.executeObsidianCommand(FIREWALL_CMD);
		await browser.waitUntil(
			async () => (await noticeTexts()).some((t) => t.includes("Firewall enabled.")),
			{ timeout: 4000, timeoutMsg: "'Firewall enabled.' notice never appeared" },
		);

		expect(await firewallPillAria()).toContain("Firewall active");
	});
});
