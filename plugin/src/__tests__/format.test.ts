import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatUptime } from "../format";

const NOW = new Date("2024-06-15T12:00:00.000Z").getTime();

describe("formatUptime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns minutes only", () => {
		expect(formatUptime(new Date(NOW - 90_000).toISOString())).toBe("1m");
	});

	it("returns hours and minutes", () => {
		expect(formatUptime(new Date(NOW - 3_700_000).toISOString())).toBe("1h 1m");
	});

	it("returns days, hours, and minutes", () => {
		expect(formatUptime(new Date(NOW - (86400 + 3600 + 60) * 1000).toISOString())).toBe(
			"1d 1h 1m",
		);
	});

	it("returns 0m at exactly now", () => {
		expect(formatUptime(new Date(NOW).toISOString())).toBe("0m");
	});

	it("returns unknown for a future timestamp", () => {
		expect(formatUptime(new Date(NOW + 1000).toISOString())).toBe("unknown");
	});

	it("returns unknown for a malformed string", () => {
		expect(formatUptime("not a date")).toBe("unknown");
	});
});
