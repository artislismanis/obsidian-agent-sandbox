// Typings for the plugin instance when accessed via browser.executeObsidian.
// Lets us write: plugins["agent-sandbox"].settings.mcpEnabled
import type AgentSandboxPlugin from "../../src/main";

declare module "wdio-obsidian-service" {
	interface InstalledPlugins {
		"agent-sandbox": AgentSandboxPlugin;
	}
}
