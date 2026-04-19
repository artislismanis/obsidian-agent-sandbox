import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TFile, TFolder } from "obsidian";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
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
			read: vi.fn(async () => "original body\n"),
			cachedRead: vi.fn(async () => "original body\n"),
			create: vi.fn(async () => {}),
			modify: vi.fn(async () => {}),
			append: vi.fn(async () => {}),
			trash: vi.fn(async () => {}),
			createFolder: vi.fn(async () => {}),
		},
		metadataCache: {
			getFileCache: vi.fn(() => ({
				frontmatter: { existing: "value" },
				headings: [{ heading: "H", level: 1, position: { start: { line: 0 } } }],
			})),
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

describe("write tools honor reviewFn", () => {
	const file = makeTFile("notes/a.md");
	let app: ReturnType<typeof createMockApp>;

	beforeEach(() => {
		app = createMockApp([file]);
	});

	const reviewedWriteCases: {
		name: string;
		args: Record<string, unknown>;
		mutated: "create" | "modify" | "append" | "processFrontMatter";
	}[] = [
		{
			name: "vault_create_reviewed",
			args: { path: "notes/new.md", content: "x" },
			mutated: "create",
		},
		{
			name: "vault_modify_reviewed",
			args: { path: "notes/a.md", content: "new" },
			mutated: "modify",
		},
		{
			name: "vault_append_reviewed",
			args: { path: "notes/a.md", content: "tail" },
			mutated: "append",
		},
		{
			name: "vault_frontmatter_set_reviewed",
			args: { path: "notes/a.md", property: "k", value: "v" },
			mutated: "processFrontMatter",
		},
		{
			name: "vault_frontmatter_delete_reviewed",
			args: { path: "notes/a.md", property: "existing" },
			mutated: "processFrontMatter",
		},
		{
			name: "vault_search_replace_reviewed",
			args: { path: "notes/a.md", search: "original", replace: "revised" },
			mutated: "modify",
		},
		{
			name: "vault_prepend_reviewed",
			args: { path: "notes/a.md", content: "head" },
			mutated: "modify",
		},
		{
			name: "vault_patch_reviewed",
			args: { path: "notes/a.md", content: "ins", line: 1, position: "after" },
			mutated: "modify",
		},
	];

	for (const c of reviewedWriteCases) {
		it(`${c.name} calls review and aborts on rejection`, async () => {
			const review = vi.fn(async () => ({ approved: false }));
			const tools = buildTools(app as never, () => "agent-workspace", undefined, review);
			const result = await getTool(tools, c.name).handler(c.args);
			expect(review).toHaveBeenCalledTimes(1);
			expect(result.isError).toBe(true);
			expect(app.vault.create).not.toHaveBeenCalled();
			expect(app.vault.modify).not.toHaveBeenCalled();
			expect(app.vault.append).not.toHaveBeenCalled();
			expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
		});

		it(`${c.name} proceeds on approval`, async () => {
			const review = vi.fn(async () => ({ approved: true }));
			const tools = buildTools(app as never, () => "agent-workspace", undefined, review);
			const result = await getTool(tools, c.name).handler(c.args);
			expect(review).toHaveBeenCalledTimes(1);
			expect(result.isError ?? false).toBe(false);
			const mutator =
				app.vault[c.mutated as "create" | "modify" | "append"] ??
				app.fileManager.processFrontMatter;
			expect(mutator).toHaveBeenCalled();
		});
	}

	it("non-reviewed tier does not invoke reviewFn even when one is provided", async () => {
		const review = vi.fn(async () => ({ approved: true }));
		const tools = buildTools(app as never, () => "agent-workspace", undefined, review);
		await getTool(tools, "vault_modify").handler({ path: "notes/a.md", content: "x" });
		expect(review).not.toHaveBeenCalled();
	});
});
