/**
 * Sync check for the generated MCP schema reference doc.
 *
 * Default mode: regenerate in memory and compare against
 * `docs/reference/mcp-schemas.md`. Fail with a clear message on drift.
 *
 * Update mode (`UPDATE_SCHEMAS=1` or `npm run docs:gen`): rewrite the on-disk
 * file in place.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => null),
	prepareFuzzySearch: vi.fn(() => () => null),
	FileSystemAdapter: class {},
	TFile: class {},
	moment: () => ({ isValid: () => true, format: () => "x" }),
}));

import { collectToolDocs, renderMcpSchemasMarkdown } from "../mcp-schemas-gen";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(HERE, "../../../docs/reference/mcp-schemas.md");

describe("MCP schema reference doc", () => {
	it("stays in sync with buildTools() — run `npm run docs:gen` to update", () => {
		const generated = renderMcpSchemasMarkdown(collectToolDocs());

		if (process.env.UPDATE_SCHEMAS === "1") {
			mkdirSync(dirname(DOC_PATH), { recursive: true });
			writeFileSync(DOC_PATH, generated, "utf8");
		}

		if (!existsSync(DOC_PATH)) {
			throw new Error(`${DOC_PATH} does not exist. Run \`npm run docs:gen\` to create it.`);
		}
		const onDisk = readFileSync(DOC_PATH, "utf8");
		if (onDisk !== generated) {
			throw new Error(
				`${DOC_PATH} is out of sync with the live tool schemas.\n` +
					`Run \`npm run docs:gen\` to regenerate it and commit the result.`,
			);
		}
		expect(onDisk).toBe(generated);
	});
});
