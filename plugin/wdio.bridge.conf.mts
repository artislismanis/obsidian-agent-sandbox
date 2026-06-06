import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

// Container-tier bridge config (Bridge C2). Mirrors wdio.conf.mts but targets
// the Docker-dependent specs under test/e2e/container/ and runs single-instance
// (one shared oas-test container, no parallelism). Kept separate so the default
// `test:e2e` suite never touches Docker. See docs/testing.md.

const cacheDir = path.resolve(".obsidian-cache");

const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "latest/latest", {
	cacheDir,
});

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./test/e2e/container/**/*.e2e.ts"],

	// One container, one Obsidian instance: never run these in parallel.
	maxInstances: 1,

	capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
		browserName: "obsidian",
		"wdio:obsidianOptions": {
			appVersion,
			installerVersion,
			plugins: ["./dist"],
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

	injectGlobals: false,
};
