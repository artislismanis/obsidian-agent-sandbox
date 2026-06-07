import { browser, expect } from "@wdio/globals";
import { describe, it, before, after, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	waitForHealth,
	TTYD_PORT,
} from "../../integration/helpers";

// QA plan 2.7 (live terminal attach/render) + 12.4 (many concurrent terminals).
// The font-fallback / auto-copy predicate logic is unit-tested
// (terminal-view.test.ts); what stays manual there is the LIVE xterm attach over
// a WebSocket to a running ttyd. These point the plugin at the oas-test
// container's ttyd, open TerminalView(s), and assert each xterm buffer fills with
// shell output — the attach + render round-trip. Visual fidelity ("no flicker /
// no garbled escapes") stays a manual spot-check.

const dockerReady = isDockerAvailable() && isImageBuilt();
const VIEW_TYPE_TERMINAL = "agent-sandbox-terminal-view";

interface AppShim {
	workspace: {
		getLeavesOfType: (t: string) => Array<{ view?: unknown; detach: () => void }>;
	};
}

interface TerminalViewShim {
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

/** Count terminal leaves whose xterm buffer has rendered some non-whitespace output. */
function renderedTerminalCount(): Promise<number> {
	return browser.executeObsidian(({ app }, viewType: string) => {
		const leaves = (app as unknown as AppShim).workspace.getLeavesOfType(viewType);
		let rendered = 0;
		for (const leaf of leaves) {
			const term = (leaf.view as TerminalViewShim | undefined)?.term;
			if (!term) continue;
			const buf = term.buffer.active;
			let out = "";
			for (let i = 0; i < buf.length; i++)
				out += buf.getLine(i)?.translateToString(true) ?? "";
			if (out.replace(/\s/g, "").length > 0) rendered++;
		}
		return rendered;
	}, VIEW_TYPE_TERMINAL);
}

async function openTerminals(n: number): Promise<void> {
	await browser.executeObsidian(async ({ app }, count: number) => {
		const plugin = (
			app as unknown as {
				plugins: {
					plugins: Record<
						string,
						{ activateTerminalView: (name?: string) => Promise<unknown> }
					>;
				};
			}
		).plugins.plugins["obsidian-agent-sandbox"];
		for (let i = 0; i < count; i++) await plugin.activateTerminalView();
	}, n);
}

(dockerReady ? describe : describe.skip)(
	"Terminal attach + render against real ttyd (QA 2.7 / 12.4)",
	function () {
		before(async function () {
			this.timeout(180000);
			await obsidianPage.resetVault();
			containerUp();
			await waitForHealth(`http://127.0.0.1:${TTYD_PORT}/`, 60000);

			// Point the plugin's terminal at the test container's remapped ttyd.
			await browser.executeObsidian(({ app }, port: number) => {
				const plugin = (
					app as unknown as {
						plugins: {
							plugins: Record<
								string,
								{
									settings: { ttydPort: number; ttydBindAddress: string };
									isContainerRunning: () => boolean;
								}
							>;
						};
					}
				).plugins.plugins["obsidian-agent-sandbox"];
				plugin.settings.ttydPort = port;
				plugin.settings.ttydBindAddress = "127.0.0.1";
				plugin.isContainerRunning = () => true;
			}, TTYD_PORT);
		});

		afterEach(async function () {
			this.timeout(30000);
			await browser.executeObsidian(({ app }, viewType: string) => {
				(app as unknown as AppShim).workspace
					.getLeavesOfType(viewType)
					.forEach((l) => l.detach());
			}, VIEW_TYPE_TERMINAL);
			await browser.pause(300);
		});

		after(function () {
			this.timeout(60000);
			containerDown();
		});

		it("2.7: a terminal renders shell output from the live ttyd connection", async function () {
			this.timeout(40000);
			await openTerminals(1);
			// A non-empty buffer proves the WebSocket attached to the real ttyd and
			// xterm rendered the bytes.
			await browser.waitUntil(async () => (await renderedTerminalCount()) >= 1, {
				timeout: 30000,
				interval: 1000,
				timeoutMsg: "terminal buffer stayed empty — no ttyd attach / render",
			});
		});

		it("12.4: five concurrent terminals all connect and render (ttyd multiplexes)", async function () {
			this.timeout(60000);
			await openTerminals(5);
			await browser.waitUntil(async () => (await renderedTerminalCount()) === 5, {
				timeout: 45000,
				interval: 1000,
				timeoutMsg: "not all five terminals attached/rendered",
			});
			expect(await renderedTerminalCount()).toBe(5);
		});
	},
);
