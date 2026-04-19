import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
	Modal: class {},
	PluginSettingTab: class {},
	Setting: class {},
}));

import {
	ALWAYS_ON_TIERS,
	GATED_TIERS,
	DEFAULT_SETTINGS,
	enabledTiersFromSettings,
} from "../settings";

describe("enabledTiersFromSettings", () => {
	it("always includes capability tiers (read, writeScoped, agent)", () => {
		const tiers = enabledTiersFromSettings({ ...DEFAULT_SETTINGS });
		for (const t of ALWAYS_ON_TIERS) expect(tiers.has(t)).toBe(true);
		expect(tiers.has("agent")).toBe(true);
	});

	it("capability tiers stay on even when every gated toggle is false", () => {
		const settings = { ...DEFAULT_SETTINGS };
		for (const def of GATED_TIERS) {
			(settings[def.settingKey] as boolean) = false;
		}
		const tiers = enabledTiersFromSettings(settings);
		expect(tiers.has("read")).toBe(true);
		expect(tiers.has("writeScoped")).toBe(true);
		for (const def of GATED_TIERS) expect(tiers.has(def.tier)).toBe(false);
	});

	it("includes gated tier when its setting key is true", () => {
		const settings = { ...DEFAULT_SETTINGS, mcpTierManage: true };
		const tiers = enabledTiersFromSettings(settings);
		expect(tiers.has("manage")).toBe(true);
		expect(tiers.has("writeVault")).toBe(false);
	});

	it("includes every gated tier when all toggles are on", () => {
		const settings = { ...DEFAULT_SETTINGS };
		for (const def of GATED_TIERS) {
			(settings[def.settingKey] as boolean) = true;
		}
		const tiers = enabledTiersFromSettings(settings);
		for (const def of GATED_TIERS) expect(tiers.has(def.tier)).toBe(true);
	});
});
