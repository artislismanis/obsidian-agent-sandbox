import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";

// mcp-tools.ts pulls in obsidian + the extensions/templater tool registrars at
// module load. Stub them so we can import the pure schema helpers in a node env.
vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(),
	prepareFuzzySearch: vi.fn(),
	moment: () => ({}),
}));
vi.mock("../mcp-extensions", () => ({ registerExtensionTools: vi.fn() }));
vi.mock("../templater-adapter", () => ({
	applyTemplaterFolderTemplate: vi.fn(),
	previewTemplaterFolderTemplate: vi.fn(),
	withTemplaterHookSuppressed: vi.fn(),
}));

import { coercedBoolean } from "../mcp-tools";

// QA 9.1a/9.1b: string "true"/"false" must coerce to the matching boolean.
// Regression guard against z.coerce.boolean(), which maps any non-empty string
// (including "false") to true.
describe("coercedBoolean", () => {
	const schema = coercedBoolean();

	it('coerces the string "false" to boolean false', () => {
		expect(schema.parse("false")).toBe(false);
	});

	it('coerces the string "true" to boolean true', () => {
		expect(schema.parse("true")).toBe(true);
	});

	it("passes real booleans through unchanged", () => {
		expect(schema.parse(true)).toBe(true);
		expect(schema.parse(false)).toBe(false);
	});

	it("rejects values that are neither a boolean nor 'true'/'false'", () => {
		expect(() => schema.parse("yes")).toThrow();
		expect(() => schema.parse(1)).toThrow();
	});
});

// QA 9.2: numeric tool args (e.g. search `limit`) arrive as strings over MCP and
// are declared with z.coerce.number(); confirm that coercion shape.
describe("limit coercion (z.coerce.number)", () => {
	const schema = z.coerce.number().optional();

	it('coerces a numeric string "3" to the number 3', () => {
		expect(schema.parse("3")).toBe(3);
	});

	it("leaves an omitted optional value undefined", () => {
		expect(schema.parse(undefined)).toBeUndefined();
	});
});
