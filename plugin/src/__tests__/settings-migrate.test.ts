import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
	Modal: class {},
	PluginSettingTab: class {},
	Setting: class {},
	SecretComponent: class {},
}));

import { DEFAULT_SETTINGS, migrateSettings } from "../settings";

const stubToken = () => "stub-token";

// Unit coverage for the load-time merge + one-shot migrations that
// main.ts.loadSettings() delegates here. A mis-copied migration condition
// would otherwise only surface in production.
describe("migrateSettings", () => {
	it("returns defaults plus a generated token on first install (no saved data)", () => {
		const { settings, changed } = migrateSettings(null, stubToken);
		expect(changed).toBe(true);
		expect(settings.mcpToken).toBe("stub-token");
		expect({ ...settings, mcpToken: "" }).toEqual(DEFAULT_SETTINGS);
	});

	it("merges saved values over defaults", () => {
		const { settings } = migrateSettings({ ttydPort: 9999, mcpToken: "t" }, stubToken);
		expect(settings.ttydPort).toBe(9999);
		expect(settings.vaultWriteDir).toBe(DEFAULT_SETTINGS.vaultWriteDir);
	});

	it("migrates the legacy 'none' write mode to 'scoped' and flags a save", () => {
		const { settings, changed } = migrateSettings(
			{ mcpVaultWrites: "none", mcpToken: "t" },
			stubToken,
		);
		expect(settings.mcpVaultWrites).toBe("scoped");
		expect(changed).toBe(true);
	});

	it("leaves current write modes untouched", () => {
		for (const mode of ["scoped", "reviewed", "full"]) {
			const { settings } = migrateSettings(
				{ mcpVaultWrites: mode, mcpToken: "t" },
				stubToken,
			);
			expect(settings.mcpVaultWrites).toBe(mode);
		}
	});

	it("preserves an existing token and reports no change for migrated data", () => {
		const generate = vi.fn(stubToken);
		const { settings, changed } = migrateSettings({ mcpToken: "existing" }, generate);
		expect(settings.mcpToken).toBe("existing");
		expect(changed).toBe(false);
		expect(generate).not.toHaveBeenCalled();
	});

	it("generates a token when the saved one is empty", () => {
		const { settings, changed } = migrateSettings({ mcpToken: "" }, stubToken);
		expect(settings.mcpToken).toBe("stub-token");
		expect(changed).toBe(true);
	});
});
