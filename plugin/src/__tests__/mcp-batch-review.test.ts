import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TFile, TFolder } from "obsidian";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	prepareFuzzySearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	FileSystemAdapter: class {},
}));

import { buildTools } from "../mcp-tools";
import type { McpToolDef } from "../mcp-tools";

function makeTFile(path: string): TFile {
	const parts = path.split("/");
	const name = parts[parts.length - 1];
	const ext = name.includes(".") ? name.split(".").pop()! : "";
	const basename = name.replace(`.${ext}`, "");
	return {
		path,
		name,
		basename,
		extension: ext,
		stat: { ctime: 1, mtime: 2, size: 100 },
		vault: {} as never,
		parent: { path: parts.slice(0, -1).join("/") || "" } as TFolder,
	} as TFile;
}

function createMockApp(files: TFile[]) {
	return {
		vault: {
			getFiles: vi.fn(() => files),
			getMarkdownFiles: vi.fn(() => files.filter((f) => f.extension === "md")),
			getFileByPath: vi.fn((p: string) => files.find((f) => f.path === p) ?? null),
			read: vi.fn(async () => "body"),
			cachedRead: vi.fn(async () => "body"),
			modify: vi.fn(async () => {}),
			create: vi.fn(async () => {}),
			append: vi.fn(async () => {}),
			trash: vi.fn(async () => {}),
			createFolder: vi.fn(async () => {}),
		},
		metadataCache: {
			getFileCache: vi.fn(() => ({ frontmatter: {} })),
			getFirstLinkpathDest: vi.fn(() => null),
			resolvedLinks: {},
			unresolvedLinks: {},
		},
		fileManager: {
			renameFile: vi.fn(async () => {}),
			processFrontMatter: vi.fn(async () => {}),
		},
		workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })) },
	};
}

function getTool(tools: McpToolDef[], name: string): McpToolDef {
	const t = tools.find((x) => x.name === name);
	if (!t) throw new Error(`Missing tool ${name}`);
	return t;
}

describe("vault_batch_frontmatter batch review", () => {
	const files = [makeTFile("a.md"), makeTFile("b.md"), makeTFile("c.md")];
	let app: ReturnType<typeof createMockApp>;

	beforeEach(() => {
		app = createMockApp(files);
	});

	it("invokes reviewBatchFn and applies only to approved paths", async () => {
		const reviewBatch = vi.fn(async () => ({
			approved: true,
			approvedPaths: ["a.md", "c.md"],
		}));
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			undefined,
			undefined,
			reviewBatch,
		);
		const result = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "anything",
			property: "status",
			value: '"draft"',
			dryRun: false,
		});
		expect(result.isError ?? false).toBe(false);
		expect(reviewBatch).toHaveBeenCalledTimes(1);
		const firstCall = reviewBatch.mock.calls[0] as unknown as [
			{ items: Array<{ filePath: string }> },
		];
		expect(firstCall[0].items).toHaveLength(3);
		expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(2);
	});

	it("aborts when user rejects all", async () => {
		const reviewBatch = vi.fn(async () => ({
			approved: false,
			approvedPaths: [],
		}));
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			undefined,
			undefined,
			reviewBatch,
		);
		const result = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "anything",
			property: "status",
			value: '"draft"',
			dryRun: false,
		});
		expect(result.isError).toBe(true);
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});

	it("falls through to direct apply when reviewBatchFn is absent", async () => {
		const tools = buildTools(app as never, () => "agent-workspace");
		const result = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "anything",
			property: "status",
			value: '"draft"',
			dryRun: false,
		});
		expect(result.isError ?? false).toBe(false);
		expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(3);
	});

	it("respects dryRun (no review call, no mutation)", async () => {
		const reviewBatch = vi.fn(async () => ({
			approved: true,
			approvedPaths: ["a.md"],
		}));
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			undefined,
			undefined,
			reviewBatch,
		);
		const result = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "anything",
			property: "status",
			value: '"draft"',
			dryRun: true,
		});
		expect(result.isError ?? false).toBe(false);
		expect(reviewBatch).not.toHaveBeenCalled();
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});
});
