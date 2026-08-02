import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";
// NB: keep this top-level import list as-is. Adding further static imports flips
// jiti's module detection and breaks the top-level `await` on line below. The
// sentinel deps are imported dynamically inside the afterTest hook instead.

const cacheDir = path.resolve(".obsidian-cache");

// Test matrix: OBSIDIAN_VERSIONS env var overrides. Default is PINNED, not
// "latest": an unpinned default let Obsidian 1.13 (which moved Settings into a
// separate window) silently break the settings-DOM e2e specs when it shipped.
// Pin to a known-good version for reproducible CI; bump deliberately after
// confirming the suite passes, and run `OBSIDIAN_VERSIONS=latest/latest` to
// probe upstream breakage on purpose.
// Format: "appVersion/installerVersion", space-separated for multiple.
// "earliest" resolves to manifest.json's minAppVersion.
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "1.13.4/1.13.4", {
	cacheDir,
});

if (env.CI) {
	// Consumed by GitHub Actions cache key
	console.log("obsidian-cache-key:", JSON.stringify(versions));
}

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./test/e2e/specs/**/*.e2e.ts"],

	maxInstances: Number(env.WDIO_MAX_INSTANCES || 2),

	capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
		browserName: "obsidian",
		"wdio:obsidianOptions": {
			appVersion,
			installerVersion,
			// Path to built plugin artifacts (manifest.json, main.js, styles.css).
			// The service copies these into the test vault and enables the plugin.
			plugins: ["./dist"],
			// Ephemeral copy of this vault per Obsidian launch.
			vault: "./test/e2e/vaults/simple",
		},
	})),

	services: ["obsidian"],
	reporters: ["obsidian"],

	mochaOpts: {
		ui: "bdd",
		timeout: 60 * 1000,
	},

	waitforInterval: 250,
	waitforTimeout: 5 * 1000,
	logLevel: "warn",

	cacheDir,

	// Require explicit imports of describe/it/expect (plays nicely with ESLint).
	injectGlobals: false,

	// Console-error sentinel (QA 12.7): fail any test that left an un-allowlisted
	// SEVERE console entry. OAS_SENTINEL_REPORT=1 prints offenders instead of
	// failing (used to regenerate the allowlist).
	afterTest: async function (
		test: { parent: string; title: string },
		_ctx: unknown,
		result: { passed: boolean },
	) {
		// Don't pile a sentinel failure onto an already-failing test — it would
		// mask the real assertion error.
		if (!result.passed) return;
		const { browser } = await import("@wdio/globals");
		const { collectSevere } = await import("./test/e2e/console-sentinel.js");
		const offenders = await collectSevere(browser);
		if (offenders.length === 0) return;
		const lines = offenders.map((m) => "  · " + m.split("\n")[0]).join("\n");
		if (env.OAS_SENTINEL_REPORT) {
			console.log(`\n[console-sentinel] ${test.parent} › ${test.title}\n${lines}`);
			return;
		}
		throw new Error(
			`console-sentinel: ${offenders.length} unexpected SEVERE console error(s) in this test:\n${lines}\n` +
				`If intentional, add a tight pattern to CONSOLE_ALLOWLIST in test/e2e/console-sentinel.ts ` +
				`(regenerate with OAS_SENTINEL_REPORT=1).`,
		);
	},
};
