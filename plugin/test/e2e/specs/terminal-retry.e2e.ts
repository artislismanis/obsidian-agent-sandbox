import { browser, $ } from "@wdio/globals";
import { describe, it, after } from "mocha";

// QA plan 2.11 — connection-retry loading text. The exponential-backoff curve is
// unit-tested (ttyd-client.test.ts); the residual is the LIVE in-terminal
// "Connecting to terminal… (attempt N/15, retry in Xs)" rendering. Pointing the
// terminal at a closed port makes pollUntilReady cycle its onRetry callback, which
// updates the .sandbox-terminal-loading element — no container needed.

const VIEW_TYPE_TERMINAL = "agent-sandbox-terminal-view";
const DEAD_PORT = 65500; // nothing listens here

interface PluginShim {
	settings: { ttydPort: number; ttydBindAddress: string };
	isContainerRunning: () => boolean;
	activateTerminalView: (name?: string) => Promise<unknown>;
}

interface AppShim {
	plugins: { plugins: Record<string, PluginShim> };
	workspace: { getLeavesOfType: (t: string) => Array<{ detach: () => void }> };
}

describe("Terminal connection-retry loading text (QA 2.11)", function () {
	after(async function () {
		await browser.executeObsidian(({ app }, viewType: string) => {
			(app as unknown as AppShim).workspace
				.getLeavesOfType(viewType)
				.forEach((l) => l.detach());
		}, VIEW_TYPE_TERMINAL);
		await browser.pause(200);
	});

	it("2.11: an unreachable ttyd shows 'Connecting to terminal… (attempt N/15, retry in Xs)'", async function () {
		await browser.executeObsidian(async ({ app }, port: number) => {
			const plugin = (app as unknown as AppShim).plugins.plugins["agent-sandbox"];
			plugin.settings.ttydPort = port;
			plugin.settings.ttydBindAddress = "127.0.0.1";
			plugin.isContainerRunning = () => true;
			await plugin.activateTerminalView();
		}, DEAD_PORT);

		// The loading div starts at "Connecting to terminal..." then, after the
		// first failed poll, cycles to the attempt/retry message.
		const loading = $(".sandbox-terminal-loading");
		await loading.waitForExist({ timeout: 5000 });
		await browser.waitUntil(
			async () => /attempt \d+\/15, retry in [\d.]+s/.test((await loading.getText()) ?? ""),
			{
				timeout: 10000,
				timeoutMsg: "loading text never showed the 'attempt N/15, retry in Xs' message",
			},
		);
	});
});
