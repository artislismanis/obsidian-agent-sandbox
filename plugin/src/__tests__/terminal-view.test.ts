import { describe, it, expect, vi } from "vitest";

// terminal-view.ts imports the Obsidian API and xterm at module load; stub both
// so the pure exports (tab-title + connection-log formatting) import in node.
vi.mock("obsidian", () => ({
	ItemView: class {},
	Notice: class {},
	Scope: class {},
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

import {
	composeTabTitle,
	composeFontFamily,
	shouldAutoCopy,
	isAllMouseModes,
	formatConnectionLog,
} from "../terminal-view";
import type { TerminalConnectionEvent } from "../terminal-view";

// QA 5.1: terminal tab title reflects activity state via a symbol prefix.
describe("composeTabTitle", () => {
	it("uses the session name when set", () => {
		expect(composeTabTitle("work", 1, null)).toBe("Session: work");
	});

	it("falls back to the instance id for an unnamed terminal", () => {
		expect(composeTabTitle(null, 3, null)).toBe("Sandbox Terminal 3");
	});

	it("prefixes ⚙ while working, ✓ when idle, ❓ when awaiting input", () => {
		expect(composeTabTitle("work", 1, "working")).toBe("⚙ Session: work");
		expect(composeTabTitle("work", 1, "idle")).toBe("✓ Session: work");
		expect(composeTabTitle("work", 1, "awaiting_input")).toBe("❓ Session: work");
	});

	it("applies the prefix to unnamed terminals too", () => {
		expect(composeTabTitle(null, 2, "working")).toBe("⚙ Sandbox Terminal 2");
	});
});

// QA 2.7: terminal font precedence (user font → Obsidian mono → portable chain).
describe("composeFontFamily", () => {
	it("puts the user font first when set", () => {
		expect(composeFontFamily("Fira Code", "MyMono")).toBe(
			"Fira Code, MyMono, Cascadia Code, Cascadia Mono, Consolas, Menlo, DejaVu Sans Mono, monospace",
		);
	});

	it("drops the user font when undefined, keeping the Obsidian var first", () => {
		expect(composeFontFamily(undefined, "MyMono")).toBe(
			"MyMono, Cascadia Code, Cascadia Mono, Consolas, Menlo, DejaVu Sans Mono, monospace",
		);
	});

	it("drops a blank/whitespace user font and a blank Obsidian var", () => {
		expect(composeFontFamily("   ", "")).toBe(
			"Cascadia Code, Cascadia Mono, Consolas, Menlo, DejaVu Sans Mono, monospace",
		);
	});

	it("trims surrounding whitespace on the user font", () => {
		expect(composeFontFamily("  Fira Code  ", "MyMono").startsWith("Fira Code, MyMono")).toBe(
			true,
		);
	});
});

// QA 2.7: auto-copy-on-selection gating (setting off / empty selection / blurred window).
describe("shouldAutoCopy", () => {
	it("copies when enabled, non-empty selection, and focused", () => {
		expect(shouldAutoCopy({ enabled: true, selection: "abc", documentFocused: true })).toBe(
			true,
		);
	});

	it("skips when auto-copy is disabled", () => {
		expect(shouldAutoCopy({ enabled: false, selection: "abc", documentFocused: true })).toBe(
			false,
		);
	});

	it("skips an empty selection", () => {
		expect(shouldAutoCopy({ enabled: true, selection: "", documentFocused: true })).toBe(false);
	});

	it("skips when the document lost focus (clipboard.writeText would throw)", () => {
		expect(shouldAutoCopy({ enabled: true, selection: "abc", documentFocused: false })).toBe(
			false,
		);
	});
});

// Mouse-tracking DECSET (CSI ? Pm h/l) is swallowed so native selection/copy
// survives a full-screen TUI enabling mouse reporting. Only fully-mouse
// sequences are swallowed; anything else falls through to xterm's default.
describe("isAllMouseModes", () => {
	it("matches a single mouse-tracking mode", () => {
		expect(isAllMouseModes([1000])).toBe(true);
		expect(isAllMouseModes([1002])).toBe(true);
		expect(isAllMouseModes([1006])).toBe(true);
		expect(isAllMouseModes([9])).toBe(true);
	});

	it("matches a combined all-mouse sequence", () => {
		expect(isAllMouseModes([1000, 1006])).toBe(true);
		expect(isAllMouseModes([1002, 1015, 1016])).toBe(true);
	});

	it("does not match non-mouse rendering modes", () => {
		expect(isAllMouseModes([1049])).toBe(false); // alt-screen
		expect(isAllMouseModes([2004])).toBe(false); // bracketed paste
		expect(isAllMouseModes([2026])).toBe(false); // synchronized output
		expect(isAllMouseModes([1004])).toBe(false); // focus events
	});

	it("does not match a mixed mouse + non-mouse sequence", () => {
		expect(isAllMouseModes([1000, 1049])).toBe(false);
		expect(isAllMouseModes([2004, 1006])).toBe(false);
	});

	it("does not match an empty sequence", () => {
		expect(isAllMouseModes([])).toBe(false);
	});

	it("does not match subparameter arrays", () => {
		expect(isAllMouseModes([[1000, 1]])).toBe(false);
	});
});

// QA 2.16: "Copy terminal connection log" output format.
describe("formatConnectionLog", () => {
	const base: TerminalConnectionEvent = { at: 0, instanceId: 1, gen: 1, kind: "open" };

	it("returns an empty string for no events", () => {
		expect(formatConnectionLog([])).toBe("");
	});

	it("renders the timestamp, instance, generation, and kind", () => {
		const line = formatConnectionLog([{ ...base, at: Date.parse("2024-06-15T12:00:00.000Z") }]);
		expect(line).toBe("2024-06-15T12:00:00.000Z  inst=1 gen=1 open");
	});

	it("includes close code, reason, duration, and byte counts when present", () => {
		const line = formatConnectionLog([
			{
				...base,
				kind: "close",
				code: 1006,
				codeName: "abnormal-no-close-frame",
				reason: "dropped",
				durationMs: 1200,
				rxBytes: 42,
				rxMsgs: 3,
				txBytes: 7,
			},
		]);
		expect(line).toContain("close");
		expect(line).toContain("code=1006(abnormal-no-close-frame)");
		expect(line).toContain('reason="dropped"');
		expect(line).toContain("duration=1200ms");
		expect(line).toContain("rx=42b/3msgs");
		expect(line).toContain("tx=7b");
	});

	it("joins multiple events with newlines", () => {
		const out = formatConnectionLog([base, { ...base, kind: "close" }]);
		expect(out.split("\n")).toHaveLength(2);
	});
});
