import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger, setLogLevel } from "../logger";

describe("logger", () => {
	let spy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		setLogLevel("warn");
	});

	afterEach(() => {
		spy.mockRestore();
		setLogLevel("warn");
	});

	describe("sanitize: CRLF stripping (CWE-117)", () => {
		it("strips LF from message", () => {
			logger.warn("comp", "line1\nline2");
			const arg: string = spy.mock.calls[0][0];
			expect(arg).not.toMatch(/\n/);
			expect(arg).toContain("line1");
			expect(arg).toContain("line2");
		});

		it("strips CR from message", () => {
			logger.warn("comp", "line1\rline2");
			const arg: string = spy.mock.calls[0][0];
			expect(arg).not.toMatch(/\r/);
		});

		it("strips CRLF sequence from message", () => {
			logger.warn("comp", "line1\r\nline2\r\nline3");
			const arg: string = spy.mock.calls[0][0];
			expect(arg).not.toMatch(/[\r\n]/);
			expect(arg).toContain("line1");
			expect(arg).toContain("line3");
		});

		it("strips LF from component name", () => {
			logger.warn("comp\ninjected", "msg");
			const arg: string = spy.mock.calls[0][0];
			expect(arg).not.toMatch(/\n/);
			expect(arg).toContain("comp");
		});
	});

	describe("level gating", () => {
		it("suppresses messages below current level", () => {
			setLogLevel("error");
			logger.warn("comp", "should be suppressed");
			expect(spy).not.toHaveBeenCalled();
		});

		it("emits messages at or above current level", () => {
			setLogLevel("warn");
			logger.warn("comp", "visible");
			expect(spy).toHaveBeenCalledOnce();
		});
	});
});
