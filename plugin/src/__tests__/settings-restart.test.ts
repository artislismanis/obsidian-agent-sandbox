import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
	Modal: class {},
	PluginSettingTab: class {},
	Setting: class {},
	SecretComponent: class {},
}));

import { DEFAULT_SETTINGS, RESTART_REQUIRED_KEYS, restartKeysChanged } from "../settings";

// Unit coverage for the diff that gates the "Restart Container?" modal. The
// settings tab's hide() calls restartKeysChanged(currentSettings, snapshot),
// where snapshot is the value captured when the tab opened. This is the logic
// QA plan 1.2 documented wrongly as "no diff tracking" — reverting a field to
// its open-time value DOES clear the prompt. See docs/qa-test-plan.md 1.2.
describe("restartKeysChanged", () => {
	it("returns false when current matches the baseline exactly", () => {
		const baseline = { ...DEFAULT_SETTINGS };
		expect(restartKeysChanged({ ...DEFAULT_SETTINGS }, baseline)).toBe(false);
	});

	it("returns true when a restart-required key differs from the baseline", () => {
		const baseline = { ...DEFAULT_SETTINGS };
		const current = {
			...DEFAULT_SETTINGS,
			vaultWriteDir: `${DEFAULT_SETTINGS.vaultWriteDir}-x`,
		};
		expect(restartKeysChanged(current, baseline)).toBe(true);
	});

	it("returns false once a changed key is reverted to its baseline value", () => {
		const baseline = { ...DEFAULT_SETTINGS };
		const changed = { ...DEFAULT_SETTINGS, ttydPort: DEFAULT_SETTINGS.ttydPort + 1 };
		expect(restartKeysChanged(changed, baseline)).toBe(true);
		const reverted = { ...changed, ttydPort: DEFAULT_SETTINGS.ttydPort };
		expect(restartKeysChanged(reverted, baseline)).toBe(false);
	});

	it("ignores changes to keys that are not restart-required", () => {
		// autoStartContainer is intentionally NOT in RESTART_REQUIRED_KEYS (QA 1.1/1.2).
		expect(RESTART_REQUIRED_KEYS).not.toContain("autoStartContainer");
		const baseline = { ...DEFAULT_SETTINGS };
		const current = {
			...DEFAULT_SETTINGS,
			autoStartContainer: !DEFAULT_SETTINGS.autoStartContainer,
		};
		expect(restartKeysChanged(current, baseline)).toBe(false);
	});

	it("flags every restart-required key individually", () => {
		const baseline = { ...DEFAULT_SETTINGS };
		for (const key of RESTART_REQUIRED_KEYS) {
			const original = DEFAULT_SETTINGS[key];
			const mutated =
				typeof original === "boolean"
					? !original
					: typeof original === "number"
						? original + 1
						: `${String(original)}-changed`;
			const current = { ...DEFAULT_SETTINGS, [key]: mutated };
			expect(restartKeysChanged(current, baseline), `key ${key} should flag`).toBe(true);
		}
	});
});
