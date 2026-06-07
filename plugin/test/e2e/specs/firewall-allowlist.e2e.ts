import { browser, expect, $ } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import { openPluginSettings, switchTab, closeSettings } from "../settings-helpers";

// QA plan 8.5 — the "Effective allowlist" Refresh control (Advanced → Security).
// The button calls plugin.firewallSources() (a `docker compose exec
// init-firewall.sh --list-sources` against the live container) and renders the
// result into the <pre>. The container round-trip itself is covered by the
// integration firewall tier; here we stub firewallSources on the live plugin to
// assert the UI wiring: Refresh renders the fetched allowlist, and a failed fetch
// surfaces a readable error instead of a blank box.

interface PluginShim {
	firewallSources: () => Promise<string>;
}

interface AppShim {
	plugins: { plugins: Record<string, PluginShim> };
}

async function stubFirewallSources(mode: "ok" | "error"): Promise<void> {
	await browser.executeObsidian(({ app }, m: "ok" | "error") => {
		const plugin = (app as unknown as AppShim).plugins.plugins["obsidian-agent-sandbox"];
		plugin.firewallSources =
			m === "ok"
				? async () =>
						"[baseline] api.anthropic.com\n[plugin] example.com\n[file] extra.example.org\n"
				: async () => {
						throw new Error("connect ECONNREFUSED");
					};
	}, mode);
}

describe("Effective allowlist refresh (QA 8.5)", function () {
	before(async function () {
		await openPluginSettings();
		await switchTab("Advanced");
	});

	after(async function () {
		await closeSettings();
	});

	it("8.5: Refresh renders the fetched allowlist with its source tags", async function () {
		await stubFirewallSources("ok");

		await $(".sandbox-settings-sources-header button").click();

		const output = $("pre.sandbox-settings-sources-output");
		await browser.waitUntil(
			async () => ((await output.getText()) ?? "").includes("[plugin] example.com"),
			{ timeout: 5000, timeoutMsg: "allowlist output never rendered the fetched entries" },
		);
		const text = await output.getText();
		expect(text).toContain("[baseline] api.anthropic.com");
		expect(text).toContain("[file] extra.example.org");
	});

	it("8.5: a failed fetch surfaces a readable error, not a blank box", async function () {
		await stubFirewallSources("error");

		await $(".sandbox-settings-sources-header button").click();

		const output = $("pre.sandbox-settings-sources-output");
		await browser.waitUntil(async () => ((await output.getText()) ?? "").includes("Error:"), {
			timeout: 5000,
			timeoutMsg: "error path never surfaced an Error: message",
		});
		expect(await output.getText()).toContain("Is the container running?");
	});
});
