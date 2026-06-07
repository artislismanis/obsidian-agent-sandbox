import { browser, expect } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import { createServer, type Server } from "net";

// QA plan 1.7b — MCP reactive port-bind failure.
//
// When the MCP server's listen() fails because the port is already taken, the
// plugin shows a "MCP server failed to start: …" Notice and tears down the
// half-started server, but LEAVES mcpEnabled untouched — the toggle records user
// intent, not runtime state, so a transient bind failure must not silently flip
// and persist it off. We occupy the port from the test process (same host
// loopback as Electron), reconfigure the plugin's MCP server onto it, ask it to
// start, and assert the Notice + the enabled-stays-true invariant.
//
// Own spec file so it gets a fresh Obsidian instance and never perturbs the
// shared MCP state in bridge.e2e.ts.

const FAIL_PORT = 28099; // not the 28080 default nor the 39080 bridge port

interface PluginShim {
	settings: { mcpEnabled: boolean; mcpPort: number; mcpBindAddress: string };
	applyMcpEnabled: (enabled: boolean) => Promise<void>;
	mcpLifecycle?: { isRunning: () => boolean };
}

interface AppShim {
	plugins: { plugins: Record<string, PluginShim> };
}

async function noticeTexts(): Promise<string[]> {
	return browser.executeObsidian(() =>
		Array.from(document.querySelectorAll(".notice")).map((n) => n.textContent ?? ""),
	);
}

/** Drive the MCP server enabled-state through the plugin's own lifecycle. */
async function applyMcpEnabled(enabled: boolean, port?: number): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, { on, p }) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
			if (p !== undefined) {
				plugin.settings.mcpPort = p;
				plugin.settings.mcpBindAddress = "127.0.0.1";
			}
			plugin.settings.mcpEnabled = on;
			await plugin.applyMcpEnabled(on);
		},
		{ on: enabled, p: port },
	);
}

async function mcpEnabledSetting(): Promise<boolean> {
	return browser.executeObsidian(
		({ app }) =>
			(app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"].settings
				.mcpEnabled,
	);
}

async function mcpRunning(): Promise<boolean> {
	return browser.executeObsidian(
		({ app }) =>
			(app as unknown as AppShim).plugins.plugins[
				"obsidian-agent-sandbox"
			].mcpLifecycle?.isRunning() ?? false,
	);
}

describe("MCP reactive port-bind failure (QA 1.7b)", function () {
	let occupier: Server;

	before(async function () {
		await obsidianPage.resetVault();
		// Stop the default MCP server (port 28080) so we control the next start.
		await applyMcpEnabled(false);
		// Occupy FAIL_PORT from the test process; Electron shares this loopback.
		occupier = createServer();
		await new Promise<void>((resolve, reject) => {
			occupier.once("error", reject);
			occupier.listen(FAIL_PORT, "127.0.0.1", resolve);
		});
		await browser.executeObsidian(() =>
			document.querySelectorAll(".notice").forEach((n) => n.remove()),
		);
	});

	after(async function () {
		await new Promise<void>((resolve) => occupier.close(() => resolve()));
	});

	it("1.7b: a start onto an occupied port surfaces a Notice and leaves mcpEnabled ON", async function () {
		await applyMcpEnabled(true, FAIL_PORT);

		await browser.waitUntil(
			async () => (await noticeTexts()).some((t) => t.includes("MCP server failed to start")),
			{ timeout: 6000, timeoutMsg: "no 'MCP server failed to start' Notice appeared" },
		);

		// The invariant under test: a transient bind failure does NOT flip the
		// user-intent toggle off, and the half-started server is torn down.
		expect(await mcpEnabledSetting()).toBe(true);
		expect(await mcpRunning()).toBe(false);
	});
});
