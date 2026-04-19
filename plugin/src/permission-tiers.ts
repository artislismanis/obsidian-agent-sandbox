import type { PermissionTier } from "./mcp-tools";

/** MCP tiers enabled automatically when the server is on. */
export const ALWAYS_ON_TIERS: readonly PermissionTier[] = ["read", "writeScoped", "agent"];

export interface TierDef {
	tier: PermissionTier;
	/** Key on AgentSandboxSettings (typed loosely here to avoid a circular import). */
	settingKey: string;
	name: string;
	desc: string;
}

/** MCP tiers gated behind per-tier user toggles. */
export const GATED_TIERS: readonly TierDef[] = [
	{
		tier: "writeReviewed",
		settingKey: "mcpTierWriteReviewed",
		name: "Write (reviewed)",
		desc: "Vault-wide writes that require your approval. A diff dialog appears in Obsidian for each change.",
	},
	{
		tier: "writeVault",
		settingKey: "mcpTierWriteVault",
		name: "Write (vault-wide)",
		desc: "Create and modify files anywhere in the vault. Allows Claude to modify any file.",
	},
	{
		tier: "navigate",
		settingKey: "mcpTierNavigate",
		name: "Navigate",
		desc: "Open files and affect what you see in the Obsidian editor.",
	},
	{
		tier: "manage",
		settingKey: "mcpTierManage",
		name: "Manage",
		desc: "Rename, move, and delete files with automatic link updates. Allows structural changes to your vault.",
	},
	{
		tier: "extensions",
		settingKey: "mcpTierExtensions",
		name: "Extensions",
		desc: "Access third-party plugin APIs (Dataview, Templater, Tasks, Canvas). Requires target plugins to be installed.",
	},
];
