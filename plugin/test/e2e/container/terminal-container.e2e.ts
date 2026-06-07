import { browser } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	waitForHealth,
	TTYD_PORT,
} from "../../integration/helpers";

// QA plan 2.7 — a real terminal attaches to the container's ttyd and renders its
// output. The font-fallback / auto-copy predicate logic is unit-tested
// (terminal-view.test.ts); what stays manual there is the LIVE xterm attach over
// a WebSocket to a running ttyd. This drives exactly that: point the plugin at
// the oas-test container's ttyd, open a TerminalView, and assert the xterm buffer
// fills with shell output (the attach + render round-trip). Visual fidelity
// ("no flicker / no garbled escapes") stays a manual spot-check.

const dockerReady = isDockerAvailable() && isImageBuilt();
const VIEW_TYPE_TERMINAL = "agent-sandbox-terminal-view";

/** Read the full visible xterm buffer text from the (first) open terminal view. */
function readTerminalBuffer(): Promise<string | null> {
	return browser.executeObsidian(({ app }, viewType: string) => {
		const leaves = (
			app as unknown as {
				workspace: { getLeavesOfType: (t: string) => Array<{ view?: unknown }> };
			}
		).workspace.getLeavesOfType(viewType);
		const view = leaves[0]?.view as
			| {
					term?: {
						buffer: {
							active: {
								length: number;
								getLine: (
									n: number,
								) => { translateToString: (trim?: boolean) => string } | undefined;
							};
						};
					};
			  }
			| undefined;
		const term = view?.term;
		if (!term) return null;
		const buf = term.buffer.active;
		let out = "";
		for (let i = 0; i < buf.length; i++)
			out += (buf.getLine(i)?.translateToString(true) ?? "") + "\n";
		return out;
	}, VIEW_TYPE_TERMINAL);
}

(dockerReady ? describe : describe.skip)(
	"Terminal attach + render against real ttyd (QA 2.7)",
	function () {
		before(async function () {
			this.timeout(180000);
			await obsidianPage.resetVault();
			containerUp();
			await waitForHealth(`http://127.0.0.1:${TTYD_PORT}/`, 60000);

			// Point the plugin's terminal at the test container's remapped ttyd, then
			// open a terminal leaf (its WebSocket attaches to the real ttyd).
			await browser.executeObsidian(async ({ app }, port: number) => {
				const plugin = (
					app as unknown as {
						plugins: {
							plugins: Record<
								string,
								{
									settings: { ttydPort: number; ttydBindAddress: string };
									isContainerRunning: () => boolean;
									activateTerminalView: (name?: string) => Promise<unknown>;
								}
							>;
						};
					}
				).plugins.plugins["obsidian-agent-sandbox"];
				plugin.settings.ttydPort = port;
				plugin.settings.ttydBindAddress = "127.0.0.1";
				plugin.isContainerRunning = () => true;
				await plugin.activateTerminalView();
			}, TTYD_PORT);
		});

		after(async function () {
			this.timeout(60000);
			await browser.executeObsidian(({ app }, viewType: string) => {
				(
					app as unknown as {
						workspace: {
							getLeavesOfType: (t: string) => Array<{ detach: () => void }>;
						};
					}
				).workspace
					.getLeavesOfType(viewType)
					.forEach((l) => l.detach());
			}, VIEW_TYPE_TERMINAL);
			containerDown();
		});

		it("renders shell output from the live ttyd connection", async function () {
			this.timeout(40000);
			// Poll the xterm buffer until the attach handshake completes and the shell
			// streams its prompt/banner. A non-empty buffer proves the WebSocket
			// attached to the real ttyd and xterm rendered the bytes.
			await browser.waitUntil(
				async () => {
					const text = await readTerminalBuffer();
					return !!text && text.replace(/\s/g, "").length > 0;
				},
				{
					timeout: 30000,
					interval: 1000,
					timeoutMsg: "terminal buffer stayed empty — no ttyd attach / render",
				},
			);
		});
	},
);
