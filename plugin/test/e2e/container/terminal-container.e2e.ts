import { browser, expect } from "@wdio/globals";
import { describe, it, before, after, afterEach } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";
import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	containerExec,
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
		).plugins.plugins["agent-sandbox"];
		for (let i = 0; i < count; i++) await plugin.activateTerminalView();
	}, n);
}

/** Open one terminal seeded with an initial Claude prompt (the Analyse path). */
async function openTerminalWithPrompt(prompt: string): Promise<void> {
	await browser.executeObsidian(async ({ app }, p: string) => {
		const plugin = (
			app as unknown as {
				plugins: {
					plugins: Record<
						string,
						{
							activateTerminalView: (
								name?: string,
								initialPrompt?: string,
							) => Promise<unknown>;
						}
					>;
				};
			}
		).plugins.plugins["agent-sandbox"];
		await plugin.activateTerminalView(undefined, p);
	}, prompt);
}

(dockerReady ? describe : describe.skip)(
	"Terminal attach + render against real ttyd (QA 2.7 / 12.4 / 6.6)",
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
				).plugins.plugins["agent-sandbox"];
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

		// QA plan 6.6 (security): a seeded prompt is injected as `claude '<escaped>'`,
		// so shell metacharacters must reach claude as a single argument and never
		// execute on open. We seed a payload whose command-substitution and
		// quote-break attempts would each touch a sentinel file IF the single-quote
		// escaping were wrong, attach to the real container shell, and assert the
		// container produced neither file.
		it("6.6: shell metacharacters in a seeded prompt do not execute on open", async function () {
			this.timeout(40000);
			const SUBST = "/tmp/oas_pwn_subst";
			const QUOTE = "/tmp/oas_pwn_quote";
			// $(touch …) → command substitution; '; touch …; ' → quote-break.
			const payload = `hello $(touch ${SUBST}) world'; touch ${QUOTE}; echo '`;

			await openTerminalWithPrompt(payload);
			// Wait for attach/render so the injected `claude '<…>'` line has been sent.
			await browser.waitUntil(async () => (await renderedTerminalCount()) >= 1, {
				timeout: 30000,
				interval: 1000,
				timeoutMsg: "terminal never attached, so the prompt was never injected",
			});
			// Give the injected command time to land and bash to parse it.
			await browser.pause(3000);

			// Probe existence via distinct sentinels (a bare `ls` would echo the
			// missing paths into its error text and false-positive the assertion).
			const out = containerExec(
				`sh -c 'test -e ${SUBST} && echo SUBST_EXISTS; test -e ${QUOTE} && echo QUOTE_EXISTS; echo PROBE_DONE'`,
			);
			expect(out).toContain("PROBE_DONE"); // the probe actually ran
			expect(out).not.toContain("SUBST_EXISTS");
			expect(out).not.toContain("QUOTE_EXISTS");
		});
	},
);
