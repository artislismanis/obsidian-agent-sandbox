/**
 * Shared test fixtures for MCP tool tests. Per-test divergence (read body,
 * cache contents, etc.) is handled via the `opts` overrides on `createMockApp`.
 */

import type { TAbstractFile, TFile, TFolder } from "obsidian";
import { vi } from "vitest";
import type { McpToolDef } from "../mcp-tools";

export function makeTFile(path: string, content = ""): TFile {
	const parts = path.split("/");
	const name = parts[parts.length - 1];
	const ext = name.includes(".") ? name.split(".").pop()! : "";
	const basename = name.replace(`.${ext}`, "");
	return {
		path,
		name,
		basename,
		extension: ext,
		stat: { ctime: 1700000000000, mtime: 1700001000000, size: content.length || 100 },
		vault: {} as never,
		parent: { path: parts.slice(0, -1).join("/") || "" } as TFolder,
	} as TFile;
}

/** Folder stand-in for tests. The `children` field is the structural marker
 *  callers duck-type against (`"children" in abstract`) to distinguish folders
 *  from files without depending on `instanceof TFolder` (which fails for
 *  test-time plain objects). */
export function makeTFolder(path: string): TFolder {
	const parts = path.split("/");
	const name = parts[parts.length - 1] ?? path;
	return {
		path,
		name,
		vault: {} as never,
		parent: { path: parts.slice(0, -1).join("/") || "" } as TFolder,
		children: [],
	} as unknown as TFolder;
}

export interface MockAppOptions {
	/** Per-path metadata cache entries. */
	caches?: Record<string, unknown>;
	/** Cache returned when no per-path entry is set; defaults to null. */
	defaultCache?: unknown;
	/**
	 * Body returned by `read` / `cachedRead`. String, or a function of the
	 * file. Defaults to `` `content of ${f.path}` ``.
	 */
	readBody?: string | ((f: TFile) => string);
	/** Folders that the mocked `getAbstractFileByPath` should resolve. */
	folders?: TFolder[];
}

export function createMockApp(files: TFile[] = [], opts: MockAppOptions = {}) {
	const readImpl = async (f: TFile): Promise<string> => {
		if (typeof opts.readBody === "function") return opts.readBody(f);
		if (typeof opts.readBody === "string") return opts.readBody;
		return `content of ${f.path}`;
	};
	const caches = opts.caches ?? {};
	const defaultCache = opts.defaultCache ?? null;
	const folders = opts.folders ?? [];
	return {
		vault: {
			getFiles: vi.fn(() => files),
			getMarkdownFiles: vi.fn(() => files.filter((f) => f.extension === "md")),
			getFileByPath: vi.fn((p: string) => files.find((f) => f.path === p) ?? null),
			getAbstractFileByPath: vi.fn(
				(p: string): TAbstractFile | null =>
					files.find((f) => f.path === p) ?? folders.find((d) => d.path === p) ?? null,
			),
			read: vi.fn(readImpl),
			cachedRead: vi.fn(readImpl),
			create: vi.fn(async (path: string, content = "") => makeTFile(path, content)),
			modify: vi.fn(async () => {}),
			append: vi.fn(async () => {}),
			trash: vi.fn(async () => {}),
			createFolder: vi.fn(async () => {}),
		},
		metadataCache: {
			getFileCache: vi.fn((f: TFile) => caches[f.path] ?? defaultCache),
			getFirstLinkpathDest: vi.fn(
				(link: string) => files.find((f) => f.basename === link || f.name === link) ?? null,
			),
			resolvedLinks: {} as Record<string, Record<string, number>>,
			unresolvedLinks: {} as Record<string, Record<string, number>>,
		},
		fileManager: {
			renameFile: vi.fn(async () => {}),
			processFrontMatter: vi.fn(
				async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
					const fm: Record<string, unknown> = {};
					fn(fm);
				},
			),
		},
		workspace: {
			getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })),
		},
	};
}

export function getTool(tools: McpToolDef[], name: string): McpToolDef {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`Tool ${name} not found`);
	return tool;
}
