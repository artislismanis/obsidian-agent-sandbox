import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
	Modal: class {},
}));

import { computeUnifiedDiff } from "../diff-review-modal";

describe("computeUnifiedDiff", () => {
	it("shows no changes for identical text", () => {
		const diff = computeUnifiedDiff("hello\nworld", "hello\nworld");
		expect(diff).not.toContain("+");
		expect(diff).not.toContain("-");
		expect(diff).toContain("hello");
		expect(diff).toContain("world");
	});

	it("shows added lines", () => {
		const diff = computeUnifiedDiff("hello\nworld", "hello\nnew line\nworld");
		expect(diff).toContain("+ new line");
		expect(diff).toContain("  hello");
		expect(diff).toContain("  world");
	});

	it("shows removed lines", () => {
		const diff = computeUnifiedDiff("hello\nremove me\nworld", "hello\nworld");
		expect(diff).toContain("- remove me");
	});

	it("shows both additions and removals", () => {
		const diff = computeUnifiedDiff("old line\nkeep", "new line\nkeep");
		expect(diff).toContain("- old line");
		expect(diff).toContain("+ new line");
		expect(diff).toContain("  keep");
	});

	it("handles empty old text (new file)", () => {
		const diff = computeUnifiedDiff("", "new content");
		expect(diff).toContain("+ new content");
	});

	it("handles empty new text (delete)", () => {
		const diff = computeUnifiedDiff("old content", "");
		expect(diff).toContain("- old content");
	});
});
