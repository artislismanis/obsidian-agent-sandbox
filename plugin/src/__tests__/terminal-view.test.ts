import { describe, it, expect, vi } from "vitest";

// terminal-view.ts imports the Obsidian API and xterm at module load; stub both
// so the pure exports (connection-log formatting) import in node.
vi.mock("obsidian", () => ({
	ItemView: class {},
	Notice: class {},
	Scope: class {},
}));
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

import { formatConnectionLog } from "../terminal-view";
import type { TerminalConnectionEvent } from "../terminal-view";

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
