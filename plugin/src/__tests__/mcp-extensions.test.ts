import { describe, it, expect, vi } from "vitest";
import type { TFile } from "obsidian";

vi.mock("obsidian", async () => {
	class TFile {}
	const momentModule = (await import("moment")) as unknown as {
		default: (input?: Date | string | number) => { format: (fmt: string) => string };
	};
	return {
		prepareSimpleSearch: vi.fn(() => () => null),
		prepareFuzzySearch: vi.fn(() => () => null),
		FileSystemAdapter: class {},
		TFile,
		moment: momentModule.default,
	};
});

import { buildTools } from "../mcp-tools";
import type { McpToolDef } from "../mcp-tools";

function canvasFile(path: string): TFile {
	return {
		path,
		name: path.split("/").pop(),
		basename: path
			.replace(/\.canvas$/, "")
			.split("/")
			.pop(),
		extension: "canvas",
		stat: { ctime: 1, mtime: 2, size: 100 },
		vault: {} as never,
		parent: null as never,
	} as unknown as TFile;
}

function mockApp(canvasContent: string) {
	const file = canvasFile("board.canvas");
	const modify = vi.fn(async () => {});
	return {
		app: {
			vault: {
				getFiles: vi.fn(() => [file]),
				getMarkdownFiles: vi.fn(() => []),
				getFileByPath: vi.fn((p: string) => (p === file.path ? file : null)),
				getAbstractFileByPath: vi.fn((p: string) => (p === file.path ? file : null)),
				read: vi.fn(async () => canvasContent),
				cachedRead: vi.fn(async () => canvasContent),
				modify,
				create: vi.fn(async () => {}),
				append: vi.fn(async () => {}),
				trash: vi.fn(async () => {}),
				createFolder: vi.fn(async () => {}),
			},
			metadataCache: {
				getFileCache: vi.fn(() => null),
				getFirstLinkpathDest: vi.fn(() => null),
				resolvedLinks: {},
				unresolvedLinks: {},
			},
			fileManager: {
				renameFile: vi.fn(async () => {}),
				processFrontMatter: vi.fn(async () => {}),
			},
			workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })) },
		},
		modify,
	};
}

function getTool(tools: McpToolDef[], name: string): McpToolDef {
	const t = tools.find((x) => x.name === name);
	if (!t) throw new Error(`Missing tool ${name}`);
	return t;
}

describe("Canvas tools", () => {
	const initial = JSON.stringify({
		nodes: [{ id: "n1", type: "text", text: "hello" }],
		edges: [],
	});

	it("vault_canvas_read returns parsed JSON", async () => {
		const { app } = mockApp(initial);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_canvas_read").handler({
			path: "board.canvas",
		});
		expect(result.isError ?? false).toBe(false);
		const content = (result.content[0] as { text: string }).text;
		expect(JSON.parse(content)).toEqual({
			nodes: [{ id: "n1", type: "text", text: "hello" }],
			edges: [],
		});
	});

	it("vault_canvas_read rejects non-canvas files", async () => {
		const { app } = mockApp(initial);
		// Return an existing non-canvas file so the handler reaches the
		// extension check rather than short-circuiting on file-not-found.
		const mdFile = {
			path: "not.md",
			name: "not.md",
			basename: "not",
			extension: "md",
			stat: { ctime: 1, mtime: 2, size: 1 },
			vault: {} as never,
			parent: null as never,
		} as unknown as TFile;
		app.vault.getFileByPath = vi.fn((p: string) => (p === "not.md" ? mdFile : null));
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_canvas_read").handler({
			path: "not.md",
		});
		expect(result.isError).toBe(true);
		const errText = (result.content[0] as { text: string }).text;
		expect(errText.toLowerCase()).toMatch(/canvas|extension/);
	});

	it("vault_canvas_modify adds and removes nodes + cascades edges", async () => {
		const withEdge = JSON.stringify({
			nodes: [
				{ id: "n1", type: "text" },
				{ id: "n2", type: "text" },
			],
			edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
		});
		const { app, modify } = mockApp(withEdge);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_canvas_modify").handler({
			path: "board.canvas",
			changes: JSON.stringify({
				addNodes: [{ id: "n3", type: "text" }],
				removeNodeIds: ["n2"],
			}),
		});
		expect(result.isError ?? false).toBe(false);
		const writtenCall = modify.mock.calls[0] as unknown as [TFile, string];
		const doc = JSON.parse(writtenCall[1]);
		expect(doc.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["n1", "n3"]);
		expect(doc.edges).toEqual([]); // edge cascaded out
	});

	it("vault_canvas_modify rejects malformed JSON in `changes`", async () => {
		const { app } = mockApp(initial);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_canvas_modify").handler({
			path: "board.canvas",
			changes: "not-json",
		});
		expect(result.isError).toBe(true);
	});

	it("both canvas tools are registered under the 'extensions' tier", () => {
		const { app } = mockApp(initial);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		expect(getTool(tools, "vault_canvas_read").tier).toBe("extensions");
		expect(getTool(tools, "vault_canvas_modify").tier).toBe("extensions");
	});

	it("vault_canvas_read distinguishes missing from wrong-extension", async () => {
		const { app } = mockApp(initial);
		// Wrong extension: the path itself doesn't end in .canvas
		app.vault.getFileByPath = vi.fn((_p: string) => null);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const wrongExt = await getTool(tools, "vault_canvas_read").handler({
			path: "notes/foo.md",
		});
		expect(wrongExt.isError).toBe(true);
		expect((wrongExt.content[0] as { text: string }).text).toBe("Path is not a .canvas file.");

		// Missing: shape is right (.canvas) but no file at that path.
		const missing = await getTool(tools, "vault_canvas_read").handler({
			path: "notes/gone.canvas",
		});
		expect(missing.isError).toBe(true);
		expect((missing.content[0] as { text: string }).text).toBe("Canvas file not found.");
	});

	it("vault_canvas_modify creates canvas when create:true and missing", async () => {
		const { app } = mockApp(initial);
		// Force a "missing" resolve for the new path.
		app.vault.getFileByPath = vi.fn((_p: string) => null);
		const created = vi.fn(async () => ({ path: "new.canvas" }) as TFile);
		(app.vault as unknown as { create: typeof created }).create = created;
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_canvas_modify").handler({
			path: "new.canvas",
			changes: JSON.stringify({ addNodes: [{ id: "seed", type: "text" }] }),
			create: true,
		});
		expect(result.isError ?? false).toBe(false);
		expect(created).toHaveBeenCalledTimes(1);
		const [, body] = created.mock.calls[0] as unknown as [string, string];
		const doc = JSON.parse(body);
		expect(doc.nodes).toEqual([{ id: "seed", type: "text" }]);
		expect(doc.edges).toEqual([]);
	});

	it("vault_canvas_modify errors without create flag when missing", async () => {
		const { app } = mockApp(initial);
		app.vault.getFileByPath = vi.fn((_p: string) => null);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_canvas_modify").handler({
			path: "new.canvas",
			changes: JSON.stringify({}),
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toBe("Canvas file not found.");
	});
});

describe("Dataview integration", () => {
	const initial = JSON.stringify({ nodes: [], edges: [] });

	function appWithDataview(query: (s: string) => unknown) {
		const { app } = mockApp(initial);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) => (id === "dataview" ? { api: { query } } : null),
			enabledPlugins: new Set(["dataview"]),
		};
		return app;
	}

	it("is absent when Dataview is not installed", () => {
		const { app } = mockApp(initial);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		expect(tools.find((t) => t.name === "vault_dataview_query")).toBeUndefined();
	});

	it("is absent when Dataview is installed but disabled", () => {
		const { app } = mockApp(initial);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) => (id === "dataview" ? { api: { query: () => null } } : null),
			enabledPlugins: new Set(), // not enabled
		};
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		expect(tools.find((t) => t.name === "vault_dataview_query")).toBeUndefined();
	});

	it("registers + returns serialized query value on success", async () => {
		const app = appWithDataview(() => ({
			successful: true,
			value: { headers: ["file"], values: [["a.md"]] },
		}));
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const tool = getTool(tools, "vault_dataview_query");
		expect(tool.tier).toBe("extensions");
		const result = await tool.handler({ query: "TABLE FROM #x" });
		expect(result.isError ?? false).toBe(false);
		const body = JSON.parse((result.content[0] as { text: string }).text);
		expect(body).toEqual({ headers: ["file"], values: [["a.md"]] });
	});

	it("surfaces Dataview failure as error result", async () => {
		const app = appWithDataview(() => ({ successful: false, error: "parse error" }));
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_dataview_query").handler({
			query: "GARBAGE",
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("parse error");
	});

	it("surfaces thrown exceptions as error result", async () => {
		const app = appWithDataview(() => {
			throw new Error("boom");
		});
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_dataview_query").handler({
			query: "TABLE",
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("boom");
	});
});

describe("Tasks integration", () => {
	function mdFile(path: string): TFile {
		return {
			path,
			name: path.split("/").pop(),
			basename: path.replace(/\.md$/, "").split("/").pop(),
			extension: "md",
			stat: { ctime: 1, mtime: 2, size: 100 },
			vault: {} as never,
			parent: null as never,
		} as unknown as TFile;
	}

	function appWithTasks(opts: {
		files: Record<string, string>;
		toggle?: (line: string, path: string) => string;
	}) {
		const files = Object.keys(opts.files).map(mdFile);
		const modify = vi.fn(async () => {});
		const app = {
			vault: {
				getFiles: vi.fn(() => files),
				getMarkdownFiles: vi.fn(() => files),
				getFileByPath: vi.fn((p: string) => files.find((f) => f.path === p) ?? null),
				getAbstractFileByPath: vi.fn(
					(p: string) => files.find((f) => f.path === p) ?? null,
				),
				read: vi.fn(async (f: TFile) => opts.files[f.path]),
				cachedRead: vi.fn(async (f: TFile) => opts.files[f.path]),
				modify,
				create: vi.fn(async () => {}),
				append: vi.fn(async () => {}),
				trash: vi.fn(async () => {}),
				createFolder: vi.fn(async () => {}),
			},
			metadataCache: {
				getFileCache: vi.fn(() => null),
				getFirstLinkpathDest: vi.fn(() => null),
				resolvedLinks: {},
				unresolvedLinks: {},
			},
			fileManager: {
				renameFile: vi.fn(async () => {}),
				processFrontMatter: vi.fn(async () => {}),
			},
			workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })) },
			plugins: {
				getPlugin: (id: string) =>
					id === "obsidian-tasks-plugin"
						? { apiV1: { executeToggleTaskDoneCommand: opts.toggle } }
						: null,
				enabledPlugins: new Set(["obsidian-tasks-plugin"]),
			},
		};
		return { app, modify };
	}

	it("is absent when Tasks plugin is not installed", () => {
		const { app } = mockApp("{}");
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		expect(tools.find((t) => t.name === "vault_tasks_query")).toBeUndefined();
		expect(tools.find((t) => t.name === "vault_tasks_toggle")).toBeUndefined();
	});

	it("vault_tasks_query returns only open items by default", async () => {
		const { app } = appWithTasks({
			files: {
				"notes.md": "- [ ] open task\n- [x] done task\n- plain bullet",
			},
		});
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_tasks_query").handler({});
		const body = (r.content[0] as { text: string }).text;
		expect(body).toContain("open task");
		expect(body).not.toContain("done task");
	});

	it("vault_tasks_query filters by tag, due date, and priority", async () => {
		const { app } = appWithTasks({
			files: {
				"x.md":
					"- [ ] A 📅 2026-04-15 #work\n" +
					"- [ ] B 📅 2026-04-20 #home\n" +
					"- [ ] C ⏫ #work\n",
			},
		});
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const byTag = await getTool(tools, "vault_tasks_query").handler({ tag: "#work" });
		expect((byTag.content[0] as { text: string }).text).toMatch(/A/);
		expect((byTag.content[0] as { text: string }).text).not.toMatch(/ B /);
		const byDue = await getTool(tools, "vault_tasks_query").handler({
			dueOnOrBefore: "2026-04-16",
		});
		expect((byDue.content[0] as { text: string }).text).toMatch(/A/);
		expect((byDue.content[0] as { text: string }).text).not.toMatch(/ B /);
		const byPri = await getTool(tools, "vault_tasks_query").handler({
			priorityAtLeast: "high",
		});
		expect((byPri.content[0] as { text: string }).text).toMatch(/C/);
		expect((byPri.content[0] as { text: string }).text).not.toMatch(/A/);
	});

	it("vault_tasks_toggle delegates to apiV1 and writes updated content", async () => {
		const toggle = vi.fn((line: string) => line.replace("[ ]", "[x]"));
		const { app, modify } = appWithTasks({
			files: { "t.md": "header\n- [ ] thing\n" },
			toggle,
		});
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_tasks_toggle").handler({
			path: "t.md",
			line: 2,
		});
		expect(r.isError ?? false).toBe(false);
		expect(toggle).toHaveBeenCalledTimes(1);
		const written = (modify.mock.calls[0] as unknown as [TFile, string])[1];
		expect(written).toContain("- [x] thing");
	});

	it("vault_tasks_toggle rejects a non-task line", async () => {
		const toggle = vi.fn((line: string) => line);
		const { app } = appWithTasks({
			files: { "t.md": "just a header\n" },
			toggle,
		});
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_tasks_toggle").handler({
			path: "t.md",
			line: 1,
		});
		expect(r.isError).toBe(true);
		expect(toggle).not.toHaveBeenCalled();
	});
});

describe("Templater integration", () => {
	it("is absent when Templater is not installed", () => {
		const { app } = mockApp("{}");
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		expect(tools.find((t) => t.name === "vault_templater_create")).toBeUndefined();
	});

	it("resolves the template path to a TFile and delegates to create_new_note_from_template", async () => {
		const { app } = mockApp("{}");
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily.md",
			name: "daily.md",
			basename: "daily",
			extension: "md",
		}) as unknown as TFile;
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn((p: string) =>
			p === "Templates/daily.md" ? templateFile : null,
		);
		// Templater's normal behaviour: write to the path the gate predicted.
		// Returning a different path simulates `tp.file.move` and is rejected
		// by the post-validate check (covered by its own test below).
		const create = vi.fn(async () => ({ path: "Notes/2026-04-19.md" }) as TFile);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? {
							settings: { templates_folder: "Templates" },
							templater: { create_new_note_from_template: create },
						}
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "Notes",
			filename: "2026-04-19",
		});
		expect(r.isError ?? false).toBe(false);
		expect(create).toHaveBeenCalledWith(templateFile, "Notes", "2026-04-19", false);
	});

	it("returns an error when the template path does not exist", async () => {
		const { app } = mockApp("{}");
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn(() => null);
		const create = vi.fn();
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? {
							settings: { templates_folder: "Templates" },
							templater: { create_new_note_from_template: create },
						}
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/missing.md",
		});
		expect(r.isError).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});
});

describe("Periodic Notes integration", () => {
	it("is absent when plugin isn't installed", () => {
		const { app } = mockApp("{}");
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		expect(tools.find((t) => t.name === "vault_periodic_note")).toBeUndefined();
	});

	it("formats the daily-note path and reports existence", async () => {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "periodic-notes"
					? {
							instance: {
								settings: {
									daily: { enabled: true, folder: "Daily", format: "YYYY-MM-DD" },
								},
							},
						}
					: null,
			enabledPlugins: new Set(["periodic-notes"]),
		};
		app.vault.getFileByPath = vi.fn((p: string) =>
			p === "Daily/2026-04-19.md" ? ({ path: p } as TFile) : null,
		);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_periodic_note").handler({
			periodicity: "daily",
			date: "2026-04-19",
		});
		expect(r.isError ?? false).toBe(false);
		expect((r.content[0] as { text: string }).text).toContain("Daily/2026-04-19.md");
	});

	it("rejects when the format string produces a path-traversal escape", async () => {
		// User-controlled `format` is processed by moment, which passes
		// through any characters that aren't moment tokens — including
		// `/`, `..`, etc. The isVaultPathSafe gate runs after path
		// computation: a format that resolves outside the vault root
		// must error rather than write/read.
		const { app } = mockApp("{}");
		// Mount a FileSystemAdapter instance on the mock vault so the
		// safety gate's getVaultBasePath returns a real path (rather than
		// null, which would make the gate a no-op for mobile / unit-test
		// adapters). The class comes from the top-level
		// `vi.mock("obsidian", ...)` block.
		const { FileSystemAdapter } = await import("obsidian");
		const adapter = new (FileSystemAdapter as unknown as new () => {
			getBasePath: () => string;
			getFullPath: (p: string) => string;
		})();
		adapter.getBasePath = () => "/tmp/vault-base";
		adapter.getFullPath = (p: string) => `/tmp/vault-base/${p}`;
		(app.vault as unknown as { adapter: typeof adapter }).adapter = adapter;
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "periodic-notes"
					? {
							instance: {
								settings: {
									daily: {
										enabled: true,
										folder: "Daily",
										// Escapes vault: "../../etc/passwd" disguised as a moment format
										// (square brackets are moment's literal-passthrough syntax).
										format: "[../../../etc/passwd]",
									},
								},
							},
						}
					: null,
			enabledPlugins: new Set(["periodic-notes"]),
		};
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_periodic_note").handler({
			periodicity: "daily",
			date: "2026-04-19",
			create: true,
		});
		expect(r.isError).toBe(true);
		// The path-traversal guard fires on the `..` segment before reaching
		// the realpath check; accept either error message so a future change
		// that routes through realpath again doesn't break the test.
		expect((r.content[0] as { text: string }).text).toMatch(
			/(?:outside the vault|'\.\.' segment)/i,
		);
	});

	it("returns not-found when create:false and file absent", async () => {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "periodic-notes"
					? {
							instance: {
								settings: {
									monthly: { enabled: true, folder: "M", format: "YYYY-MM" },
								},
							},
						}
					: null,
			enabledPlugins: new Set(["periodic-notes"]),
		};
		app.vault.getFileByPath = vi.fn((_p: string) => null);
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_periodic_note").handler({
			periodicity: "monthly",
			date: "2026-04-19",
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toContain("M/2026-04.md");
	});
});

describe("Write gate — extensions tier boundary enforcement", () => {
	function appWithTemplater(createImpl: ReturnType<typeof vi.fn>) {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? {
							// Required by isInsideTemplatesFolder — template paths
							// must live inside this folder or the tool refuses
							// (sandbox escape via writeScoped + extensions).
							settings: { templates_folder: "Templates" },
							templater: { create_new_note_from_template: createImpl },
						}
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		return app;
	}

	async function setupTemplaterApp() {
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily.md",
			name: "daily.md",
			basename: "daily",
			extension: "md",
		}) as unknown as TFile;
		// Mock writes to the predicted destination so the post-create
		// path-equality check is satisfied. tp.file.move-style escape is
		// covered by a dedicated test that returns a divergent path.
		const create = vi.fn(async (_tmpl: TFile, folder: string, filename: string) => {
			const dir = (folder ?? "").replace(/^\/+|\/+$/g, "");
			const path = dir ? `${dir}/${filename}.md` : `${filename}.md`;
			return { path } as TFile;
		});
		const app = appWithTemplater(create);
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn((p: string) =>
			p === "Templates/daily.md" ? templateFile : null,
		);
		return { app, create };
	}

	it("scoped-only mode rejects templater writes outside the write directory", async () => {
		const { app, create } = await setupTemplaterApp();
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: undefined,
			enabledTiers: new Set(["read", "writeScoped", "extensions"]),
		});
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "OtherFolder",
			filename: "x",
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toContain("outside the write directory");
		expect(create).not.toHaveBeenCalled();
	});

	it("scoped-only mode allows templater writes inside the write directory", async () => {
		const { app, create } = await setupTemplaterApp();
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: undefined,
			enabledTiers: new Set(["read", "writeScoped", "extensions"]),
		});
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "agent-workspace/journal",
			filename: "x",
		});
		expect(r.isError ?? false).toBe(false);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("reviewed mode routes out-of-scope templater writes through review", async () => {
		const { app, create } = await setupTemplaterApp();
		const review = vi.fn(async () => ({ approved: true }));
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: review,
			enabledTiers: new Set(["read", "writeScoped", "writeReviewed", "extensions"]),
		});
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "OtherFolder",
			filename: "x",
		});
		expect(r.isError ?? false).toBe(false);
		expect(review).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("reviewed mode aborts when the user rejects", async () => {
		const { app, create } = await setupTemplaterApp();
		const review = vi.fn(async () => ({ approved: false }));
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: review,
			enabledTiers: new Set(["read", "writeScoped", "writeReviewed", "extensions"]),
		});
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "OtherFolder",
			filename: "x",
		});
		expect(r.isError).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});

	it("full vault-write mode allows templater writes anywhere without review", async () => {
		const { app, create } = await setupTemplaterApp();
		const review = vi.fn();
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: review,
			enabledTiers: new Set(["read", "writeScoped", "writeVault", "extensions"]),
		});
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "OtherFolder",
			filename: "x",
		});
		expect(r.isError ?? false).toBe(false);
		expect(review).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("rejects templates that relocate the file via tp.file.move", async () => {
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily.md",
			name: "daily.md",
			basename: "daily",
			extension: "md",
		}) as unknown as TFile;
		// Templater returns a path that differs from the gated destPath —
		// simulating `tp.file.move("/elsewhere/x")` inside the template.
		const create = vi.fn(async () => ({ path: "Elsewhere/escaped.md" }) as TFile);
		const trash = vi.fn(async () => undefined);
		const app = appWithTemplater(create);
		(app.vault as unknown as { trash: typeof trash }).trash = trash;
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn((p: string) =>
			p === "Templates/daily.md" ? templateFile : null,
		);
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: undefined,
			enabledTiers: new Set(["read", "writeScoped", "writeVault", "extensions"]),
		});
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "agent-workspace",
			filename: "x",
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toContain("relocated");
		// The escaped file should have been trashed so it doesn't linger
		// outside the gated path.
		expect(trash).toHaveBeenCalledTimes(1);
	});

	it("scoped-only mode rejects canvas writes outside the write directory", async () => {
		const initial = JSON.stringify({ nodes: [], edges: [] });
		const { app, modify } = mockApp(initial);
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: undefined,
			enabledTiers: new Set(["read", "writeScoped", "extensions"]),
		});
		const r = await getTool(tools, "vault_canvas_modify").handler({
			path: "board.canvas",
			changes: JSON.stringify({ addNodes: [{ id: "n2", type: "text" }] }),
		});
		expect(r.isError).toBe(true);
		expect(modify).not.toHaveBeenCalled();
	});

	it("scoped-only mode rejects vault_create_folder outside write directory", async () => {
		const { app } = mockApp("{}");
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: undefined,
			enabledTiers: new Set(["read", "writeScoped", "manage"]),
		});
		const r = await getTool(tools, "vault_create_folder").handler({
			path: "SomeOtherDir/subdir",
		});
		expect(r.isError).toBe(true);
		expect(app.vault.createFolder).not.toHaveBeenCalled();
	});

	it("scoped-only mode allows vault_create_folder inside write directory", async () => {
		const { app } = mockApp("{}");
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: undefined,
			enabledTiers: new Set(["read", "writeScoped", "manage"]),
		});
		const r = await getTool(tools, "vault_create_folder").handler({
			path: "agent-workspace/newdir",
		});
		expect(r.isError ?? false).toBe(false);
		expect(app.vault.createFolder).toHaveBeenCalledWith("agent-workspace/newdir");
	});
});

describe("plugin_extensions_list", () => {
	it("reports native-canvas always + per-plugin detection", async () => {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "dataview" ? { api: { query: () => ({ successful: true }) } } : null,
			enabledPlugins: new Set(["dataview"]),
		};
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const tool = getTool(tools, "plugin_extensions_list");
		const r = await tool.handler({});
		const body = (r.content[0] as { text: string }).text;
		expect(body).toContain("canvas: always");
		expect(body).toContain("dataview: enabled");
		expect(body).toContain("tasks: not available");
	});
});

describe("Extensions tier — write-boundary asymmetry fixes", () => {
	function mdAtForCas(path: string): TFile {
		return {
			path,
			name: path.split("/").pop(),
			basename: path.replace(/\.md$/, "").split("/").pop(),
			extension: "md",
			stat: { ctime: 1, mtime: 2, size: 100 },
			vault: {} as never,
			parent: null as never,
		} as unknown as TFile;
	}

	it("vault_templater_create rejects ':' in folder (NTFS alt-data-stream)", async () => {
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily.md",
			name: "daily.md",
			basename: "daily",
			extension: "md",
		}) as unknown as TFile;
		const create = vi.fn();
		const { app } = mockApp("{}");
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn((p: string) =>
			p === "Templates/daily.md" ? templateFile : null,
		);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? {
							settings: { templates_folder: "Templates" },
							templater: { create_new_note_from_template: create },
						}
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "notes:hidden",
			filename: "x",
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/drive letter|alt-data-stream/);
		expect(create).not.toHaveBeenCalled();
	});

	it("vault_templater_create rejects ':' in filename (NTFS alt-data-stream)", async () => {
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily.md",
			name: "daily.md",
			basename: "daily",
			extension: "md",
		}) as unknown as TFile;
		const create = vi.fn();
		const { app } = mockApp("{}");
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn((p: string) =>
			p === "Templates/daily.md" ? templateFile : null,
		);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? {
							settings: { templates_folder: "Templates" },
							templater: { create_new_note_from_template: create },
						}
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			filename: "foo:bar",
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/alt-data-stream/);
		expect(create).not.toHaveBeenCalled();
	});

	it("vault_periodic_note uses Templater's returned TFile to detect relocation", async () => {
		// A basename-only fallback would match (and trash) an UNRELATED file
		// sharing the basename when Templater calls `tp.file.move`; the
		// implementation uses Templater's returned TFile directly.
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily-template.md",
			name: "daily-template.md",
			basename: "daily-template",
			extension: "md",
		}) as unknown as TFile;
		// The created note ends up at "Elsewhere/relocated.md" — distinct from
		// the gated path. Also place an unrelated file with the same basename
		// to confirm the relocation detector won't trash it.
		const unrelatedSameBasename = Object.assign(new (TFileClass as new () => object)(), {
			path: "completely-unrelated/2026-04-19.md",
			name: "2026-04-19.md",
			basename: "2026-04-19",
			extension: "md",
		}) as unknown as TFile;
		const createdFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Elsewhere/relocated.md",
			name: "relocated.md",
			basename: "relocated",
			extension: "md",
		}) as unknown as TFile;
		const create = vi.fn(async () => createdFile);
		const trash = vi.fn(async () => undefined);
		const { app } = mockApp("{}");
		app.vault.trash = trash;
		app.vault.getFileByPath = vi.fn((p: string) =>
			p === "Templates/daily-template.md" ? templateFile : null,
		);
		(app.vault as unknown as { getMarkdownFiles: () => TFile[] }).getMarkdownFiles = () => [
			unrelatedSameBasename,
			templateFile,
		];
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) => {
				if (id === "templater-obsidian") {
					return {
						settings: { templates_folder: "Templates" },
						templater: { create_new_note_from_template: create },
					};
				}
				if (id === "periodic-notes") {
					return {
						instance: {
							settings: {
								daily: {
									enabled: true,
									folder: "Daily",
									format: "YYYY-MM-DD",
									template: "Templates/daily-template.md",
								},
							},
						},
					};
				}
				return null;
			},
			enabledPlugins: new Set(["templater-obsidian", "periodic-notes"]),
		};
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: undefined,
			enabledTiers: new Set(["read", "writeScoped", "writeVault", "extensions"]),
		});
		const r = await getTool(tools, "vault_periodic_note").handler({
			periodicity: "daily",
			date: "2026-04-19",
			create: true,
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/relocated/);
		// Only the file Templater returned was trashed; the unrelated
		// same-basename file MUST NOT have been touched.
		expect(trash).toHaveBeenCalledTimes(1);
		expect(trash).toHaveBeenCalledWith(createdFile, true);
		expect(trash).not.toHaveBeenCalledWith(unrelatedSameBasename, true);
	});

	it("vault_periodic_note refuses Templater templates outside the templates folder", async () => {
		const { TFile: TFileClass } = await import("obsidian");
		// Template lives OUTSIDE Templater's configured templates folder; a
		// writeable malicious template there would otherwise smuggle script
		// execution past the templates-folder boundary.
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "agent-workspace/maybe-malicious.md",
			name: "maybe-malicious.md",
			basename: "maybe-malicious",
			extension: "md",
		}) as unknown as TFile;
		const create = vi.fn();
		const { app } = mockApp("{}");
		app.vault.getFileByPath = vi.fn((p: string) =>
			p === "agent-workspace/maybe-malicious.md" ? templateFile : null,
		);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) => {
				if (id === "templater-obsidian") {
					return {
						settings: { templates_folder: "Templates" },
						templater: { create_new_note_from_template: create },
					};
				}
				if (id === "periodic-notes") {
					return {
						instance: {
							settings: {
								daily: {
									enabled: true,
									folder: "Daily",
									format: "YYYY-MM-DD",
									template: "agent-workspace/maybe-malicious.md",
								},
							},
						},
					};
				}
				return null;
			},
			enabledPlugins: new Set(["templater-obsidian", "periodic-notes"]),
		};
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: undefined,
			enabledTiers: new Set(["read", "writeScoped", "writeVault", "extensions"]),
		});
		const r = await getTool(tools, "vault_periodic_note").handler({
			periodicity: "daily",
			date: "2026-04-19",
			create: true,
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/templates folder/);
		expect(create).not.toHaveBeenCalled();
	});

	it("vault_tasks_toggle aborts on concurrent edit during review (CAS)", async () => {
		// Toggle goes through gateVaultWrite's shared CAS check: if the file
		// changes during the review window, the apply is aborted instead of
		// clobbering the editor edit.
		const file = mdAtForCas("notes/tasks.md");
		const original = "- [ ] thing\n";
		const concurrentEdit = "- [ ] thing — edited mid-review\n";
		const reads = [original, concurrentEdit];
		let readIdx = 0;
		const toggle = vi.fn((line: string) => line.replace("[ ]", "[x]"));
		const modify = vi.fn(async () => {});
		const app = {
			vault: {
				getFiles: vi.fn(() => [file]),
				getMarkdownFiles: vi.fn(() => [file]),
				getFileByPath: vi.fn((p: string) => (p === file.path ? file : null)),
				// First read: the snapshot used to build the preview.
				// Second read: the CAS recheck after the user approves.
				read: vi.fn(async () => reads[Math.min(readIdx++, reads.length - 1)]),
				cachedRead: vi.fn(async () => reads[0]),
				modify,
				create: vi.fn(),
				append: vi.fn(),
				trash: vi.fn(),
				createFolder: vi.fn(),
			},
			metadataCache: {
				getFileCache: vi.fn(() => null),
				getFirstLinkpathDest: vi.fn(() => null),
				resolvedLinks: {},
				unresolvedLinks: {},
			},
			fileManager: { renameFile: vi.fn(), processFrontMatter: vi.fn() },
			workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn() })) },
			plugins: {
				getPlugin: (id: string) =>
					id === "obsidian-tasks-plugin"
						? { apiV1: { executeToggleTaskDoneCommand: toggle } }
						: null,
				enabledPlugins: new Set(["obsidian-tasks-plugin"]),
			},
		};
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: async () => ({ approved: true }),
			// Use writeReviewed so the gate goes through the review path
			// (only that path runs the CAS check; direct writes have no race
			// window). The file path is OUTSIDE writeDir to force the
			// reviewed branch.
			enabledTiers: new Set(["read", "writeScoped", "writeReviewed", "extensions"]),
		});
		const r = await getTool(tools, "vault_tasks_toggle").handler({
			path: "notes/tasks.md",
			line: 1,
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/changed during review/);
		expect(modify).not.toHaveBeenCalled();
	});
});

describe("Extensions tier — pathFilter coverage (info-leak boundary)", () => {
	// Every extension-tier tool must respect mcpPathAllowlist / mcpPathBlocklist
	// — otherwise an `extensions`-tier agent could read or mutate blocklisted
	// regions via canvas/dataview/tasks/templater/periodic-notes paths even
	// though the equivalent vault_* tools refuse the same path.

	function canvasAt(path: string): TFile {
		return {
			path,
			name: path.split("/").pop(),
			basename: path
				.replace(/\.canvas$/, "")
				.split("/")
				.pop(),
			extension: "canvas",
			stat: { ctime: 1, mtime: 2, size: 100 },
			vault: {} as never,
			parent: null as never,
		} as unknown as TFile;
	}

	function mdAt(path: string): TFile {
		return {
			path,
			name: path.split("/").pop(),
			basename: path.replace(/\.md$/, "").split("/").pop(),
			extension: "md",
			stat: { ctime: 1, mtime: 2, size: 100 },
			vault: {} as never,
			parent: null as never,
		} as unknown as TFile;
	}

	it("vault_canvas_read refuses paths blocked by the filter", async () => {
		const file = canvasAt("secrets/board.canvas");
		const { app } = mockApp("{}");
		app.vault.getFileByPath = vi.fn((p: string) => (p === file.path ? file : null));
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
		});
		const r = await getTool(tools, "vault_canvas_read").handler({
			path: "secrets/board.canvas",
		});
		expect(r.isError).toBe(true);
		// The "Canvas file not found" sentinel matches the resolveCanvasFile
		// null-return shape. The assertion's point is that the read does not
		// succeed; the wording is incidental.
		expect((r.content[0] as { text: string }).text.toLowerCase()).toMatch(
			/(?:not found|blocked|allow)/,
		);
	});

	it("vault_canvas_modify refuses paths blocked by the filter", async () => {
		const file = canvasAt("secrets/board.canvas");
		const { app, modify } = mockApp(JSON.stringify({ nodes: [], edges: [] }));
		app.vault.getFileByPath = vi.fn((p: string) => (p === file.path ? file : null));
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
		});
		const r = await getTool(tools, "vault_canvas_modify").handler({
			path: "secrets/board.canvas",
			changes: JSON.stringify({ addNodes: [{ id: "x", type: "text" }] }),
		});
		expect(r.isError).toBe(true);
		expect(modify).not.toHaveBeenCalled();
	});

	it("vault_dataview_query is refused outright when a path filter is set", async () => {
		const { app } = mockApp("{}");
		const query = vi.fn(() => ({ successful: true, value: { headers: [], values: [] } }));
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) => (id === "dataview" ? { api: { query } } : null),
			enabledPlugins: new Set(["dataview"]),
		};
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			// Either an allowlist or a blocklist counts as "filter set" — using
			// blocklist here matches the canvas tests above.
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
		});
		const r = await getTool(tools, "vault_dataview_query").handler({
			query: 'LIST FROM "secrets"',
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/disabled|allow|block/);
		expect(query).not.toHaveBeenCalled();
	});

	it("vault_tasks_query filters blocklisted files out of the scan", async () => {
		const visible = mdAt("notes/visible.md");
		const hidden = mdAt("secrets/hidden.md");
		const files = [visible, hidden];
		const fileContent: Record<string, string> = {
			"notes/visible.md": "- [ ] visible work",
			"secrets/hidden.md": "- [ ] hidden secret",
		};
		const app = {
			vault: {
				getFiles: vi.fn(() => files),
				getMarkdownFiles: vi.fn(() => files),
				getFileByPath: vi.fn((p: string) => files.find((f) => f.path === p) ?? null),
				read: vi.fn(async (f: TFile) => fileContent[f.path]),
				cachedRead: vi.fn(async (f: TFile) => fileContent[f.path]),
				modify: vi.fn(async () => {}),
				create: vi.fn(async () => {}),
				append: vi.fn(async () => {}),
				trash: vi.fn(async () => {}),
				createFolder: vi.fn(async () => {}),
			},
			metadataCache: {
				getFileCache: vi.fn(() => null),
				getFirstLinkpathDest: vi.fn(() => null),
				resolvedLinks: {},
				unresolvedLinks: {},
			},
			fileManager: {
				renameFile: vi.fn(async () => {}),
				processFrontMatter: vi.fn(async () => {}),
			},
			workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })) },
			plugins: {
				getPlugin: (id: string) =>
					id === "obsidian-tasks-plugin"
						? { apiV1: { executeToggleTaskDoneCommand: () => "" } }
						: null,
				enabledPlugins: new Set(["obsidian-tasks-plugin"]),
			},
		};
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
		});
		const r = await getTool(tools, "vault_tasks_query").handler({});
		const body = (r.content[0] as { text: string }).text;
		expect(body).toContain("visible work");
		expect(body).not.toContain("hidden secret");
	});

	it("vault_tasks_toggle refuses paths blocked by the filter", async () => {
		const file = mdAt("secrets/notes.md");
		const toggle = vi.fn();
		const modify = vi.fn(async () => {});
		const app = {
			vault: {
				getFiles: vi.fn(() => [file]),
				getMarkdownFiles: vi.fn(() => [file]),
				getFileByPath: vi.fn((p: string) => (p === file.path ? file : null)),
				read: vi.fn(async () => "- [ ] hidden\n"),
				cachedRead: vi.fn(async () => "- [ ] hidden\n"),
				modify,
				create: vi.fn(),
				append: vi.fn(),
				trash: vi.fn(),
				createFolder: vi.fn(),
			},
			metadataCache: {
				getFileCache: vi.fn(() => null),
				getFirstLinkpathDest: vi.fn(() => null),
				resolvedLinks: {},
				unresolvedLinks: {},
			},
			fileManager: { renameFile: vi.fn(), processFrontMatter: vi.fn() },
			workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn() })) },
			plugins: {
				getPlugin: (id: string) =>
					id === "obsidian-tasks-plugin"
						? { apiV1: { executeToggleTaskDoneCommand: toggle } }
						: null,
				enabledPlugins: new Set(["obsidian-tasks-plugin"]),
			},
		};
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
		});
		const r = await getTool(tools, "vault_tasks_toggle").handler({
			path: "secrets/notes.md",
			line: 1,
		});
		expect(r.isError).toBe(true);
		expect(toggle).not.toHaveBeenCalled();
		expect(modify).not.toHaveBeenCalled();
	});

	it("vault_templater_create refuses destinations blocked by the filter", async () => {
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily.md",
			name: "daily.md",
			basename: "daily",
			extension: "md",
		}) as unknown as TFile;
		const create = vi.fn();
		const { app } = mockApp("{}");
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn((p: string) =>
			p === "Templates/daily.md" ? templateFile : null,
		);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? {
							settings: { templates_folder: "Templates" },
							templater: { create_new_note_from_template: create },
						}
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
			// Grant a write tier wide enough to reach the destPath check —
			// without writeVault, gateVaultWrite would reject for being
			// outside the write directory before the pathFilter check fires.
			enabledTiers: new Set(["read", "writeScoped", "writeVault", "extensions"]),
		});
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "secrets",
			filename: "x",
		});
		expect(r.isError).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});

	it("vault_periodic_note refuses computed paths blocked by the filter", async () => {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "periodic-notes"
					? {
							instance: {
								settings: {
									daily: {
										enabled: true,
										folder: "secrets/journal",
										format: "YYYY-MM-DD",
									},
								},
							},
						}
					: null,
			enabledPlugins: new Set(["periodic-notes"]),
		};
		app.vault.getFileByPath = vi.fn((_p: string) => null);
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
			enabledTiers: new Set(["read", "writeScoped", "writeVault", "extensions"]),
		});
		const r = await getTool(tools, "vault_periodic_note").handler({
			periodicity: "daily",
			date: "2026-04-19",
			create: true,
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/blocked|allow/);
	});

	it("vault_create_folder refuses paths blocked by the filter", async () => {
		const { app } = mockApp("{}");
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
			enabledTiers: new Set(["read", "writeScoped", "writeVault", "manage"]),
		});
		const r = await getTool(tools, "vault_create_folder").handler({
			path: "secrets/exfil",
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/blocked|allow/);
		expect(app.vault.createFolder).not.toHaveBeenCalled();
	});

	it("vault_batch_frontmatter excludes blocklisted files from dry-run and apply", async () => {
		const visible = mdAt("notes/visible.md");
		const hidden = mdAt("secrets/hidden.md");
		const files = [visible, hidden];
		const fileContent: Record<string, string> = {
			"notes/visible.md": "match",
			"secrets/hidden.md": "match",
		};
		const processFrontMatter = vi.fn(
			async (_file: TFile, _fn: (fm: Record<string, unknown>) => void) => {},
		);
		const { prepareSimpleSearch } = await import("obsidian");
		// Override the default search mock from the top-level vi.mock block:
		// the default returns null for everything, which would short-circuit
		// the iteration before we can verify filtering.
		(
			prepareSimpleSearch as unknown as { mockImplementation: (impl: unknown) => void }
		).mockImplementation(
			() => (content: string) =>
				content.includes("match") ? { score: 1, matches: [] } : null,
		);
		const app = {
			vault: {
				getFiles: vi.fn(() => files),
				getMarkdownFiles: vi.fn(() => files),
				getFileByPath: vi.fn((p: string) => files.find((f) => f.path === p) ?? null),
				read: vi.fn(async (f: TFile) => fileContent[f.path]),
				cachedRead: vi.fn(async (f: TFile) => fileContent[f.path]),
				modify: vi.fn(async () => {}),
				create: vi.fn(),
				append: vi.fn(),
				trash: vi.fn(),
				createFolder: vi.fn(),
			},
			metadataCache: {
				getFileCache: vi.fn(() => null),
				getFirstLinkpathDest: vi.fn(() => null),
				resolvedLinks: {},
				unresolvedLinks: {},
			},
			fileManager: { renameFile: vi.fn(), processFrontMatter },
			workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn() })) },
		};
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			pathFilter: { allowlist: [], blocklist: ["secrets/"] },
			enabledTiers: new Set(["read", "writeScoped", "writeVault", "manage"]),
		});
		// Dry-run: must NOT list secrets/hidden.md
		const dry = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "match",
			property: "tag",
			value: "x",
			dryRun: true,
		});
		const dryText = (dry.content[0] as { text: string }).text;
		expect(dryText).toContain("notes/visible.md");
		expect(dryText).not.toContain("secrets/hidden.md");
		// Apply: must not invoke processFrontMatter on secrets/hidden.md
		const apply = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "match",
			property: "tag",
			value: "x",
			dryRun: false,
		});
		expect(apply.isError ?? false).toBe(false);
		const touched = processFrontMatter.mock.calls.map((c) => (c[0] as TFile).path);
		expect(touched).toContain("notes/visible.md");
		expect(touched).not.toContain("secrets/hidden.md");
	});
});
