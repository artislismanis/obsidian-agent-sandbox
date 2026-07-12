import { describe, it, expect } from "vitest";
import {
	composeTabTitle,
	composeFontFamily,
	shouldAutoCopy,
	decodeOsc52,
	isAllMouseModes,
} from "../terminal-format";

// QA 5.1: terminal tab title reflects activity state via a symbol prefix.
describe("composeTabTitle", () => {
	it("uses the session name when set", () => {
		expect(composeTabTitle("work", 1, null)).toBe("Session: work");
	});

	it("falls back to the instance id for an unnamed terminal", () => {
		expect(composeTabTitle(null, 3, null)).toBe("Sandbox Terminal 3");
	});

	it("falls back to the bare label when the instance id is unknown (deferred leaves)", () => {
		expect(composeTabTitle(null, undefined, null)).toBe("Sandbox Terminal");
	});

	it("prefixes ⚙ while working, ✓ when idle, ❓ when awaiting input", () => {
		expect(composeTabTitle("work", 1, "working")).toBe("⚙ Session: work");
		expect(composeTabTitle("work", 1, "idle")).toBe("✓ Session: work");
		expect(composeTabTitle("work", 1, "awaiting_input")).toBe("❓ Session: work");
	});

	it("applies the prefix to unnamed terminals too", () => {
		expect(composeTabTitle(null, 2, "working")).toBe("⚙ Sandbox Terminal 2");
	});

	it("applies the prefix to a deferred (no instance id) terminal too", () => {
		expect(composeTabTitle(null, undefined, "working")).toBe("⚙ Sandbox Terminal");
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

// OSC 52 clipboard-write payloads from TUIs (e.g. Claude Code's "c to copy") are
// base64-decoded into clipboard text; reads/empty/malformed payloads decode to null
// so the handler swallows the sequence without touching the clipboard.
describe("decodeOsc52", () => {
	it("decodes a base64 clipboard-write payload", () => {
		expect(decodeOsc52("c;" + btoa("hello"))).toBe("hello");
	});

	it("decodes regardless of the selection field", () => {
		expect(decodeOsc52("p;" + btoa("primary"))).toBe("primary");
		expect(decodeOsc52(";" + btoa("no-selection"))).toBe("no-selection");
	});

	it("round-trips a UTF-8 URL", () => {
		const url =
			"https://claude.com/cai/oauth/authorize?code=true&state=ysmZB7SJwiZTVRAZ3ZSMC79pZ0aMBqk99Ai5ArOLn9M";
		expect(decodeOsc52("c;" + btoa(url))).toBe(url);
	});

	it("returns null for a clipboard read request", () => {
		expect(decodeOsc52("c;?")).toBe(null);
	});

	it("returns null for an empty data field", () => {
		expect(decodeOsc52("c;")).toBe(null);
	});

	it("returns null when there is no selection/data separator", () => {
		expect(decodeOsc52("no-semicolon")).toBe(null);
	});

	it("returns null for malformed base64", () => {
		expect(decodeOsc52("c;!!!not base64!!!")).toBe(null);
	});
});
