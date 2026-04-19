import { describe, it, expect } from "vitest";
import { parsePromptTemplate, substituteFilePlaceholder } from "../prompt-template";

describe("parsePromptTemplate", () => {
	it("extracts label and body when separator is present", () => {
		const [label, body] = parsePromptTemplate(
			"Summarize\n---\nPlease summarize @{{file}}",
			"fallback",
		);
		expect(label).toBe("Summarize");
		expect(body).toBe("Please summarize @{{file}}");
	});

	it("uses first non-empty line as label when no separator", () => {
		const [label, body] = parsePromptTemplate("\n\nAnalyze this\nmore stuff\n", "fallback");
		expect(label).toBe("Analyze this");
		expect(body).toBe("Analyze this\nmore stuff");
	});

	it("falls back to filename when content is empty or only separator", () => {
		const [label] = parsePromptTemplate("\n---\n", "my-template.md");
		expect(label).toBe("my-template.md");
	});

	it("handles multi-paragraph body after separator", () => {
		const [, body] = parsePromptTemplate(
			"Critique\n---\nPara one.\n\nPara two with @{{file}}.",
			"fallback",
		);
		expect(body).toBe("Para one.\n\nPara two with @{{file}}.");
	});
});

describe("substituteFilePlaceholder", () => {
	it("replaces {{file}} with the vault path", () => {
		expect(substituteFilePlaceholder("Summarize @{{file}}", "notes/foo.md")).toBe(
			"Summarize @notes/foo.md",
		);
	});

	it("handles whitespace variants inside braces", () => {
		expect(substituteFilePlaceholder("@{{ file }}", "x.md")).toBe("@x.md");
	});

	it("replaces all occurrences", () => {
		expect(substituteFilePlaceholder("{{file}} and {{file}}", "a.md")).toBe("a.md and a.md");
	});

	it("leaves content without placeholder untouched", () => {
		expect(substituteFilePlaceholder("no placeholder", "x.md")).toBe("no placeholder");
	});
});
