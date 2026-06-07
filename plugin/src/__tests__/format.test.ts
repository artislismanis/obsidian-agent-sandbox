import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildContainerStatusLines, formatUptime } from "../format";

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

// QA 2.14: "Sandbox: Container Status" notice body composition.
describe("buildContainerStatusLines", () => {
	const running = { mcpRunning: true, mcpPort: 28080, firewall: "on" as const };

	it("truncates the container id to 12 chars", () => {
		const lines = buildContainerStatusLines(
			{ id: "0123456789abcdef0123", image: "oas-sandbox:latest" },
			running,
		);
		expect(lines).toContain("ID: 0123456789ab");
		expect(lines).toContain("Image: oas-sandbox:latest");
	});

	it("shows the MCP port when running and 'off' when not", () => {
		expect(buildContainerStatusLines(null, running)).toContain("MCP: on (port 28080)");
		expect(
			buildContainerStatusLines(null, { mcpRunning: false, mcpPort: 28080, firewall: "off" }),
		).toContain("MCP: off");
	});

	it("renders each firewall state verbatim", () => {
		for (const fw of ["on", "off", "unknown"] as const) {
			expect(
				buildContainerStatusLines(null, {
					mcpRunning: false,
					mcpPort: 28080,
					firewall: fw,
				}),
			).toContain(`Firewall: ${fw}`);
		}
	});

	it("omits id/image/uptime lines when info is null", () => {
		const lines = buildContainerStatusLines(null, running);
		expect(lines[0]).toBe("Sandbox: Running");
		expect(lines.some((l) => l.startsWith("ID:"))).toBe(false);
		expect(lines.some((l) => l.startsWith("Up:"))).toBe(false);
	});
});
