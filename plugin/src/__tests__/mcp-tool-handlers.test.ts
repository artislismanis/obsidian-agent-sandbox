import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TFile } from "obsidian";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	prepareFuzzySearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	FileSystemAdapter: class {},
}));

import { buildTools, isPathAllowedByFilter } from "../mcp-tools";
import type { McpToolDef, PathFilter } from "../mcp-tools";
import { previewTemplaterFolderTemplate } from "../templater-adapter";
import { makeTFile, makeTFolder, createMockApp, getTool } from "./fixtures";

function getResult(result: { content: Array<{ text: string }>; isError?: boolean }) {
	return { text: result.content[0].text, isError: result.isError ?? false };
}

describe("MCP tool handlers", () => {
	const testFiles = [
		makeTFile("notes/hello.md"),
		makeTFile("notes/world.md"),
		makeTFile("agent-workspace/draft.md"),
		makeTFile("config.json"),
	];

	const caches: Record<string, unknown> = {
		"notes/hello.md": {
			tags: [{ tag: "#project" }, { tag: "#important" }],
			frontmatter: { title: "Hello", status: "active", position: {} },
			headings: [
				{ heading: "Introduction", level: 1 },
				{ heading: "Details", level: 2 },
			],
		},
		"notes/world.md": {
			tags: [{ tag: "#project" }],
			frontmatter: { tags: ["travel", "notes"] },
			headings: [],
		},
	};

	let app: ReturnType<typeof createMockApp>;
	let tools: McpToolDef[];

	beforeEach(() => {
		app = createMockApp(testFiles, {
			caches,
			folders: [makeTFolder("notes"), makeTFolder("agent-workspace")],
		});
		app.metadataCache.resolvedLinks = {
			"notes/hello.md": { "notes/world.md": 2 },
			"notes/world.md": {},
		};
		app.metadataCache.unresolvedLinks = {
			"notes/hello.md": { nonexistent: 1 },
		};
		tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: async () => ({ approved: true }),
		});
	});

	describe("tool registration", () => {
		it("registers all expected tools", () => {
			const names = tools.map((t) => t.name);
			expect(names).toContain("vault_read");
			expect(names).toContain("vault_list");
			expect(names).toContain("vault_search");
			expect(names).toContain("vault_tags");
			expect(names).toContain("vault_frontmatter");
			expect(names).toContain("vault_links");
			expect(names).toContain("vault_backlinks");
			expect(names).toContain("vault_headings");
			expect(names).toContain("vault_orphans");
			expect(names).toContain("vault_unresolved");
			expect(names).toContain("vault_create");
			expect(names).toContain("vault_modify");
			expect(names).toContain("vault_append");
			expect(names).toContain("vault_frontmatter_set");
			expect(names).toContain("vault_frontmatter_delete");
			expect(names).toContain("vault_search_replace");
			expect(names).toContain("vault_prepend");
			expect(names).toContain("vault_patch");
			expect(names).toContain("vault_create_anywhere");
			expect(names).toContain("vault_frontmatter_delete_anywhere");
			expect(names).toContain("vault_search_replace_anywhere");
			expect(names).toContain("vault_prepend_anywhere");
			expect(names).toContain("vault_patch_anywhere");
			expect(names).toContain("vault_recent");
			expect(names).toContain("vault_properties");
			expect(names).toContain("vault_graph_neighborhood");
			expect(names).toContain("vault_graph_path");
			expect(names).toContain("vault_graph_clusters");
			expect(names).toContain("vault_open");
			expect(names).toContain("vault_rename");
			expect(names).toContain("vault_move");
			expect(names).toContain("vault_delete");
			expect(names).toContain("vault_create_folder");
			expect(names).toContain("vault_context");
			expect(names).toContain("vault_suggest_links");
			expect(names).toContain("vault_batch_frontmatter");
			expect(names).toContain("vault_create_reviewed");
			expect(names).toContain("vault_modify_reviewed");
		});

		it("assigns correct tiers", () => {
			expect(getTool(tools, "vault_read").tier).toBe("read");
			expect(getTool(tools, "vault_create").tier).toBe("writeScoped");
			expect(getTool(tools, "vault_create_anywhere").tier).toBe("writeVault");
			expect(getTool(tools, "vault_open").tier).toBe("navigate");
			expect(getTool(tools, "vault_rename").tier).toBe("manage");
		});
	});

	describe("vault_read", () => {
		it("reads file by path", async () => {
			const r = getResult(
				await getTool(tools, "vault_read").handler({ path: "notes/hello.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("content of notes/hello.md");
		});

		it("reads file by wikilink name", async () => {
			const r = getResult(await getTool(tools, "vault_read").handler({ file: "hello" }));
			expect(r.isError).toBe(false);
			expect(r.text).toContain("hello.md");
		});

		it("returns error for nonexistent file", async () => {
			const r = getResult(await getTool(tools, "vault_read").handler({ path: "nope.md" }));
			expect(r.isError).toBe(true);
			expect(r.text).toBe("File not found.");
		});

		it("rejects wrong-type path with Invalid arguments", async () => {
			const r = getResult(await getTool(tools, "vault_read").handler({ path: 123 } as never));
			expect(r.isError).toBe(true);
			expect(r.text.startsWith("Invalid arguments")).toBe(true);
		});

		it("rejects missing file/path as McpError -32602", async () => {
			await expect(getTool(tools, "vault_read").handler({})).rejects.toMatchObject({
				code: ErrorCode.InvalidParams,
				message: expect.stringContaining("Input validation error"),
			});
		});
	});

	describe("vault_list", () => {
		it("lists all files", async () => {
			const r = getResult(await getTool(tools, "vault_list").handler({}));
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("config.json");
		});

		it("filters by folder", async () => {
			const r = getResult(await getTool(tools, "vault_list").handler({ folder: "notes" }));
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).not.toContain("config.json");
		});

		it("accepts path as alias for folder", async () => {
			const r = getResult(await getTool(tools, "vault_list").handler({ path: "notes" }));
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).not.toContain("config.json");
		});

		it("errors when folder does not exist", async () => {
			const r = getResult(
				await getTool(tools, "vault_list").handler({ folder: "nonexistent" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("Folder not found");
		});

		it("errors when path points to a file not a folder", async () => {
			const r = getResult(
				await getTool(tools, "vault_list").handler({ folder: "notes/hello.md" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("Not a folder");
		});

		it("filters by extension", async () => {
			const r = getResult(await getTool(tools, "vault_list").handler({ extension: "json" }));
			expect(r.text).toBe("config.json");
		});
	});

	describe("vault_file_info", () => {
		it("returns file metadata", async () => {
			const r = getResult(
				await getTool(tools, "vault_file_info").handler({ path: "notes/hello.md" }),
			);
			expect(r.text).toContain("path: notes/hello.md");
			expect(r.text).toContain("name: hello");
			expect(r.text).toContain("extension: md");
		});
	});

	describe("vault_tags", () => {
		it("returns tags for a specific file", async () => {
			const r = getResult(
				await getTool(tools, "vault_tags").handler({ path: "notes/hello.md" }),
			);
			expect(r.text).toContain("#project");
			expect(r.text).toContain("#important");
		});

		it("returns vault-wide tag counts", async () => {
			const r = getResult(await getTool(tools, "vault_tags").handler({}));
			expect(r.text).toContain("#project: 2");
		});

		it("normalizes frontmatter tags with # prefix", async () => {
			const r = getResult(
				await getTool(tools, "vault_tags").handler({ path: "notes/world.md" }),
			);
			expect(r.text).toContain("#travel");
			expect(r.text).toContain("#notes");
		});
	});

	describe("vault_frontmatter", () => {
		it("returns full frontmatter", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter").handler({ path: "notes/hello.md" }),
			);
			const parsed = JSON.parse(r.text);
			expect(parsed.title).toBe("Hello");
			expect(parsed.status).toBe("active");
			expect(parsed.position).toBeUndefined();
		});

		it("returns specific property", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter").handler({
					path: "notes/hello.md",
					property: "status",
				}),
			);
			expect(r.text).toBe('"active"');
		});

		it("returns error for missing property", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter").handler({
					path: "notes/hello.md",
					property: "nonexistent",
				}),
			);
			expect(r.text).toContain("not found");
		});

		it("handles file without frontmatter", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter").handler({
					path: "agent-workspace/draft.md",
				}),
			);
			expect(r.text).toBe("(no frontmatter)");
		});
	});

	describe("vault_links", () => {
		it("returns outgoing links", async () => {
			const r = getResult(
				await getTool(tools, "vault_links").handler({ path: "notes/hello.md" }),
			);
			expect(r.text).toContain("notes/world.md (2)");
		});

		it("returns empty for file with no links", async () => {
			const r = getResult(
				await getTool(tools, "vault_links").handler({ path: "notes/world.md" }),
			);
			expect(r.text).toBe("(no outgoing links)");
		});
	});

	describe("vault_backlinks", () => {
		it("returns files linking to target", async () => {
			const r = getResult(
				await getTool(tools, "vault_backlinks").handler({ path: "notes/world.md" }),
			);
			expect(r.text).toContain("notes/hello.md");
		});
	});

	describe("vault_headings", () => {
		it("returns indented outline", async () => {
			const r = getResult(
				await getTool(tools, "vault_headings").handler({ path: "notes/hello.md" }),
			);
			expect(r.text).toContain("Introduction");
			expect(r.text).toContain("  Details");
		});
	});

	describe("vault_orphans", () => {
		it("returns files with no incoming links", async () => {
			const r = getResult(await getTool(tools, "vault_orphans").handler({}));
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("agent-workspace/draft.md");
			expect(r.text).not.toContain("notes/world.md");
		});
	});

	describe("vault_unresolved", () => {
		it("returns broken wikilinks", async () => {
			const r = getResult(await getTool(tools, "vault_unresolved").handler({}));
			expect(r.text).toContain("nonexistent");
			expect(r.text).toContain("notes/hello.md");
		});
	});

	describe("vault_create (scoped)", () => {
		it("creates file within write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/new.md",
					content: "hello",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.create).toHaveBeenCalledWith("agent-workspace/new.md", "hello");
		});

		it("rejects file outside write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "notes/evil.md",
					content: "hack",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("write directory");
			expect(app.vault.create).not.toHaveBeenCalled();
		});

		it("rejects path traversal", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/../secret.md",
				}),
			);
			expect(r.isError).toBe(true);
			expect(app.vault.create).not.toHaveBeenCalled();
		});

		it("rejects if file already exists", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/draft.md",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("already exists");
		});

		it("rejects dotfile basename", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/.hidden.md",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("dotfile");
			expect(app.vault.create).not.toHaveBeenCalled();
		});

		it("creates missing parent folders", async () => {
			const localApp = createMockApp(testFiles, {
				caches,
				folders: [makeTFolder("agent-workspace")],
			});
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				review: async () => ({ approved: true }),
			});
			const r = getResult(
				await getTool(localTools, "vault_create").handler({
					path: "agent-workspace/newdir/file.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(localApp.vault.createFolder).toHaveBeenCalledWith("agent-workspace/newdir");
			expect(localApp.vault.create).toHaveBeenCalledWith(
				"agent-workspace/newdir/file.md",
				"",
			);
		});
	});

	describe("vault_create + Templater folder templates", () => {
		interface FolderTemplate {
			folder?: string;
			template?: string;
		}
		function installTemplater(opts: {
			enabled?: boolean;
			folderTemplates?: FolderTemplate[];
			templateFiles?: TFile[];
			writeImpl?: (tpl: TFile, target: TFile) => Promise<void>;
			triggerOnFileCreation?: boolean;
		}): {
			write: ReturnType<typeof vi.fn>;
			settings: {
				enable_folder_templates: boolean;
				trigger_on_file_creation: boolean;
				folder_templates: FolderTemplate[];
			};
		} {
			const write = vi.fn(opts.writeImpl ?? (async () => {}));
			const settings = {
				enable_folder_templates: opts.enabled ?? true,
				trigger_on_file_creation: opts.triggerOnFileCreation ?? true,
				folder_templates: opts.folderTemplates ?? [],
			};
			(app as unknown as { plugins: unknown }).plugins = {
				enabledPlugins: new Set(["templater-obsidian"]),
				plugins: {
					"templater-obsidian": {
						settings,
						templater: { write_template_to_file: write },
					},
				},
			};
			// Make any template files resolvable via getFileByPath.
			const original = app.vault.getFileByPath.getMockImplementation();
			app.vault.getFileByPath = vi.fn((path: string) => {
				const tpl = (opts.templateFiles ?? []).find((f) => f.path === path);
				return tpl ?? (original ? original(path) : null);
			}) as never;
			return { write, settings };
		}

		it("no-op when Templater is not installed", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("Created agent-workspace/n.md");
			expect(app.vault.create).toHaveBeenCalledWith("agent-workspace/n.md", "");
		});

		it("no-op when folder templates are disabled", async () => {
			const tplFile = makeTFile("Templates/Default.md");
			const { write } = installTemplater({
				enabled: false,
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Default.md" }],
				templateFiles: [tplFile],
			});
			const r = getResult(
				await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" }),
			);
			expect(r.isError).toBe(false);
			expect(write).not.toHaveBeenCalled();
		});

		it("applies the matching folder template and reports it in the success message", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			const { write } = installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
			});
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/2026-05-06.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0][0].path).toBe("Templates/Daily.md");
			expect(write.mock.calls[0][1].path).toBe("agent-workspace/2026-05-06.md");
			expect(r.text).toContain("applied template Templates/Daily.md");
		});

		it("longest-prefix folder match wins", async () => {
			const root = makeTFile("Templates/Root.md");
			const nested = makeTFile("Templates/Nested.md");
			const { write } = installTemplater({
				folderTemplates: [
					{ folder: "/", template: "Templates/Root.md" },
					{ folder: "agent-workspace", template: "Templates/Nested.md" },
				],
				templateFiles: [root, nested],
			});
			await getTool(tools, "vault_create").handler({ path: "agent-workspace/sub/n.md" });
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0][0].path).toBe("Templates/Nested.md");
		});

		it("does not apply a template when the agent supplied content", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			const { write } = installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
			});
			await getTool(tools, "vault_create").handler({
				path: "agent-workspace/n.md",
				content: "agent wrote this",
			});
			expect(write).not.toHaveBeenCalled();
			expect(app.vault.create).toHaveBeenCalledWith(
				"agent-workspace/n.md",
				"agent wrote this",
			);
		});

		it("does not apply a template to non-markdown files", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			const { write } = installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
			});
			await getTool(tools, "vault_create").handler({ path: "agent-workspace/data.json" });
			expect(write).not.toHaveBeenCalled();
		});

		it("no-op when no folder template matches the target path", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			const { write } = installTemplater({
				folderTemplates: [{ folder: "elsewhere", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
			});
			const r = getResult(
				await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("Created agent-workspace/n.md");
			expect(write).not.toHaveBeenCalled();
		});

		it("suppresses the create-hook during apply and restores it afterwards", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			let observedDuringCreate: boolean | undefined;
			const { settings } = installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
				triggerOnFileCreation: true,
			});
			(app.vault.create as ReturnType<typeof vi.fn>).mockImplementationOnce(
				async (path: string) => {
					observedDuringCreate = settings.trigger_on_file_creation;
					return makeTFile(path);
				},
			);
			await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" });
			expect(observedDuringCreate).toBe(false);
			expect(settings.trigger_on_file_creation).toBe(true);
		});

		it("surfaces an error when write_template_to_file throws — the on-disk file is empty but the reviewed body didn't land", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
				writeImpl: async () => {
					throw new Error("boom");
				},
			});
			const r = getResult(
				await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" }),
			);
			// Template-apply failure surfaces as an error so the agent and user
			// know the on-disk state doesn't match the reviewed preview.
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/template application failed/i);
			// The file is still created on disk; the template apply is what
			// failed.
			expect(app.vault.create).toHaveBeenCalledWith("agent-workspace/n.md", "");
		});
	});

	describe("vault_create_anywhere (vault-wide)", () => {
		it("creates file at any path", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_anywhere").handler({
					path: "notes/new.md",
					content: "hello",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.create).toHaveBeenCalledWith("notes/new.md", "hello");
		});
	});

	describe("vault_modify (scoped)", () => {
		it("modifies file within write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_modify").handler({
					path: "agent-workspace/draft.md",
					content: "updated",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalled();
		});

		it("rejects file outside write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_modify").handler({
					path: "notes/hello.md",
					content: "evil",
				}),
			);
			expect(r.isError).toBe(true);
		});
	});

	describe("vault_frontmatter_set", () => {
		it("sets property on file in write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "status",
					value: "done",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.processFrontMatter).toHaveBeenCalled();
		});

		it("accepts native arrays", async () => {
			await getTool(tools, "vault_frontmatter_set").handler({
				path: "agent-workspace/draft.md",
				property: "categories",
				value: ["a", "b"],
			});
			const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
			const fm: Record<string, unknown> = {};
			callback(fm);
			expect(fm.categories).toEqual(["a", "b"]);
		});

		it("accepts native numbers, booleans, and objects", async () => {
			const tool = getTool(tools, "vault_frontmatter_set");
			const cases: Array<{ property: string; value: unknown }> = [
				{ property: "count", value: 42 },
				{ property: "published", value: true },
				{ property: "meta", value: { author: "me", year: 2026 } },
			];
			for (const { property, value } of cases) {
				app.fileManager.processFrontMatter.mockClear();
				await tool.handler({
					path: "agent-workspace/draft.md",
					property,
					value,
				});
				const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
				const fm: Record<string, unknown> = {};
				callback(fm);
				expect(fm[property]).toEqual(value);
			}
		});

		it("rejects missing value with Invalid arguments", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "tags",
				} as never),
			);
			expect(r.isError).toBe(true);
			expect(r.text.startsWith("Invalid arguments")).toBe(true);
			expect(r.text).toContain("value");
		});

		it("coerces JSON-string array to native array", async () => {
			await getTool(tools, "vault_frontmatter_set").handler({
				path: "agent-workspace/draft.md",
				property: "tags",
				value: '["x","y"]',
			});
			const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
			const fm: Record<string, unknown> = {};
			callback(fm);
			// JSON-string coercion + tag # stripping applied together
			expect(fm.tags).toEqual(["x", "y"]);
		});

		it("coerces JSON-string object to native object", async () => {
			await getTool(tools, "vault_frontmatter_set").handler({
				path: "agent-workspace/draft.md",
				property: "meta",
				value: '{"key":"val"}',
			});
			const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
			const fm: Record<string, unknown> = {};
			callback(fm);
			expect(fm.meta).toEqual({ key: "val" });
		});

		it("leaves non-JSON strings unchanged", async () => {
			await getTool(tools, "vault_frontmatter_set").handler({
				path: "agent-workspace/draft.md",
				property: "status",
				value: "active",
			});
			const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
			const fm: Record<string, unknown> = {};
			callback(fm);
			expect(fm.status).toBe("active");
		});

		it("leaves invalid JSON array-shaped strings unchanged", async () => {
			await getTool(tools, "vault_frontmatter_set").handler({
				path: "agent-workspace/draft.md",
				property: "status",
				value: "[not valid",
			});
			const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
			const fm: Record<string, unknown> = {};
			callback(fm);
			expect(fm.status).toBe("[not valid");
		});

		describe("tag normalisation", () => {
			const callFm = async (value: unknown) => {
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "tags",
					value,
				});
				const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
				const fm: Record<string, unknown> = {};
				callback(fm);
				return fm.tags;
			};

			it("strips # from tag strings", async () => {
				expect(await callFm("#work")).toBe("work");
			});

			it("leaves already-bare tags unchanged", async () => {
				expect(await callFm("work")).toBe("work");
			});

			it("normalises all elements in an array", async () => {
				expect(await callFm(["project", "#active", "todo"])).toEqual([
					"project",
					"active",
					"todo",
				]);
			});

			it("does not normalise non-tag properties", async () => {
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "category",
					value: ["a", "b"],
				});
				const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
				const fm: Record<string, unknown> = {};
				callback(fm);
				expect(fm.category).toEqual(["a", "b"]);
			});
		});

		describe("append mode", () => {
			it("appends to an existing array", async () => {
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "categories",
					value: ["c"],
					append: true,
				});
				const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
				const fm: Record<string, unknown> = { categories: ["a", "b"] };
				callback(fm);
				expect(fm.categories).toEqual(["a", "b", "c"]);
			});

			it("deduplicates when appending", async () => {
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "categories",
					value: ["b", "c"],
					append: true,
				});
				const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
				const fm: Record<string, unknown> = { categories: ["a", "b"] };
				callback(fm);
				expect(fm.categories).toEqual(["a", "b", "c"]);
			});

			it("wraps a scalar existing value in an array then appends", async () => {
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "categories",
					value: ["b"],
					append: true,
				});
				const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
				const fm: Record<string, unknown> = { categories: "a" };
				callback(fm);
				expect(fm.categories).toEqual(["a", "b"]);
			});

			it("sets value directly when no existing value", async () => {
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "categories",
					value: ["x"],
					append: true,
				});
				const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
				const fm: Record<string, unknown> = {};
				callback(fm);
				expect(fm.categories).toEqual(["x"]);
			});

			it("appends and normalises tags simultaneously", async () => {
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "tags",
					value: ["#new"],
					append: true,
				});
				const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
				const fm: Record<string, unknown> = { tags: ["existing"] };
				callback(fm);
				expect(fm.tags).toEqual(["existing", "new"]);
			});
		});
	});

	describe("vault_rename", () => {
		it("renames file and preserves extension", async () => {
			const r = getResult(
				await getTool(tools, "vault_rename").handler({
					path: "notes/hello.md",
					name: "greeting",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				"notes/greeting.md",
			);
		});

		it("preserves extension when name contains a mid-string dot (e.g. 'v1.2')", async () => {
			const r = getResult(
				await getTool(tools, "vault_rename").handler({
					path: "notes/hello.md",
					name: "v1.2",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				"notes/v1.2.md",
			);
		});

		it("preserves extension when name has alpha suffix that isn't the file's ext (e.g. 'Mr.Smith')", async () => {
			const r = getResult(
				await getTool(tools, "vault_rename").handler({
					path: "notes/hello.md",
					name: "Mr.Smith",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				"notes/Mr.Smith.md",
			);
		});

		it("does not double-extension when name ends with the file's extension", async () => {
			const r = getResult(
				await getTool(tools, "vault_rename").handler({
					path: "notes/hello.md",
					name: "greeting.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				"notes/greeting.md",
			);
		});

		it("rejects names containing slashes or '..'", async () => {
			const r = getResult(
				await getTool(tools, "vault_rename").handler({
					path: "notes/hello.md",
					name: "../escape",
				}),
			);
			expect(r.isError).toBe(true);
		});
	});

	describe("vault_move", () => {
		it("moves file to new folder", async () => {
			const r = getResult(
				await getTool(tools, "vault_move").handler({
					path: "notes/hello.md",
					to: "archive",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				"archive/hello.md",
			);
		});

		it("rejects destinations containing '..'", async () => {
			const r = getResult(
				await getTool(tools, "vault_move").handler({
					path: "notes/hello.md",
					to: "../escape",
				}),
			);
			expect(r.isError).toBe(true);
		});
	});

	describe("vault_delete", () => {
		it("trashes file", async () => {
			const r = getResult(
				await getTool(tools, "vault_delete").handler({ path: "notes/hello.md" }),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.trash).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				true,
			);
		});

		it("trashes folder recursively", async () => {
			const folder = makeTFolder("notes/old-project");
			const localApp = createMockApp([], { folders: [folder] });
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				review: async () => ({ approved: true }),
			});
			const r = getResult(
				await getTool(localTools, "vault_delete").handler({ path: "notes/old-project" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("Deleted folder notes/old-project");
			expect(localApp.vault.trash).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/old-project" }),
				true,
			);
		});

		it("returns Path not found for missing target", async () => {
			const r = getResult(
				await getTool(tools, "vault_delete").handler({ path: "nope/missing" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toBe("Path not found.");
		});
	});

	describe("vault_create_folder", () => {
		it("creates folder", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_folder").handler({ path: "new-folder" }),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.createFolder).toHaveBeenCalledWith("new-folder");
		});

		it("is idempotent when folder already exists", async () => {
			const localApp = createMockApp([], { folders: [makeTFolder("existing-folder")] });
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				review: async () => ({ approved: true }),
			});
			const r = getResult(
				await getTool(localTools, "vault_create_folder").handler({
					path: "existing-folder",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("Folder already exists at existing-folder");
			expect(localApp.vault.createFolder).not.toHaveBeenCalled();
		});

		it("errors when a file occupies the path", async () => {
			const collide = makeTFile("notes/clash");
			const localApp = createMockApp([collide]);
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				review: async () => ({ approved: true }),
			});
			const r = getResult(
				await getTool(localTools, "vault_create_folder").handler({ path: "notes/clash" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toBe("Path notes/clash exists as a file; refusing to create folder.");
			expect(localApp.vault.createFolder).not.toHaveBeenCalled();
		});

		it("rejects dotfile basename", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_folder").handler({ path: ".hidden" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("dotfile");
			expect(app.vault.createFolder).not.toHaveBeenCalled();
		});
	});

	describe("vault_recent", () => {
		it("returns files sorted by mtime", async () => {
			const r = getResult(await getTool(tools, "vault_recent").handler({ limit: 2 }));
			expect(r.isError).toBe(false);
			expect(r.text).toContain("notes/hello.md");
		});
	});

	describe("vault_properties", () => {
		it("lists all property keys with counts", async () => {
			const r = getResult(await getTool(tools, "vault_properties").handler({}));
			expect(r.isError).toBe(false);
			expect(r.text).toContain("title:");
			expect(r.text).toContain("status:");
		});

		it("lists distinct values for a specific property", async () => {
			const r = getResult(
				await getTool(tools, "vault_properties").handler({ property: "title" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain('"Hello"');
		});
	});

	describe("vault_graph_neighborhood", () => {
		it("returns 1-hop neighbors", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_neighborhood").handler({
					path: "notes/hello.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("notes/world.md");
		});

		it("returns empty for disconnected node", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_neighborhood").handler({
					path: "config.json",
				}),
			);
			expect(r.text).toContain("no linked notes");
		});
	});

	describe("vault_graph_path", () => {
		it("finds direct path", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_path").handler({
					source: "notes/hello.md",
					target: "notes/world.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("hello.md");
			expect(r.text).toContain("world.md");
			expect(r.text).toContain("→");
		});

		it("returns no path for disconnected nodes", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_path").handler({
					source: "notes/hello.md",
					target: "config.json",
				}),
			);
			expect(r.text).toContain("No path found");
		});
	});

	describe("vault_graph_clusters", () => {
		it("finds connected components", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_clusters").handler({ minSize: 2 }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("Cluster 1");
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("notes/world.md");
		});

		it("returns empty when no clusters meet minSize", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_clusters").handler({ minSize: 100 }),
			);
			expect(r.text).toContain("no clusters");
		});
	});

	describe("vault_context", () => {
		it("returns combined context for a file", async () => {
			const r = getResult(
				await getTool(tools, "vault_context").handler({ path: "notes/hello.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("Frontmatter");
			expect(r.text).toContain("Content");
			expect(r.text).toContain("content of notes/hello.md");
		});
	});

	describe("vault_suggest_links", () => {
		it("returns suggestions excluding already-linked files", async () => {
			app.vault.cachedRead.mockResolvedValue("hello world notes");
			const r = getResult(
				await getTool(tools, "vault_suggest_links").handler({ path: "notes/hello.md" }),
			);
			expect(r.isError).toBe(false);
		});
	});

	describe("vault_batch_frontmatter", () => {
		it("dry run lists matching files", async () => {
			const r = getResult(
				await getTool(tools, "vault_batch_frontmatter").handler({
					query: "content",
					property: "reviewed",
					value: "true",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("Dry run");
		});

		it("matches every file in a folder when query is omitted", async () => {
			const r = getResult(
				await getTool(tools, "vault_batch_frontmatter").handler({
					folder: "notes",
					property: "reviewed",
					value: "true",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("notes/world.md");
			expect(r.text).not.toContain("agent-workspace/draft.md");
		});

		it("requires at least one of folder or query", async () => {
			await expect(
				getTool(tools, "vault_batch_frontmatter").handler({
					property: "reviewed",
					value: "true",
				}),
			).rejects.toMatchObject({
				code: ErrorCode.InvalidParams,
				message: expect.stringContaining("Input validation error"),
			});
		});

		it("intersects folder + query", async () => {
			const r = getResult(
				await getTool(tools, "vault_batch_frontmatter").handler({
					folder: "notes",
					query: "content",
					property: "reviewed",
					value: "true",
				}),
			);
			expect(r.isError).toBe(false);
			// Both notes/* files exist; with the (mocked) always-match search
			// they should all be listed. agent-workspace/draft.md must not.
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).not.toContain("agent-workspace/draft.md");
		});

		it("coerces JSON-string array to native array when applying (with tag normalisation)", async () => {
			await getTool(tools, "vault_batch_frontmatter").handler({
				folder: "agent-workspace",
				property: "tags",
				value: '["#a","#b"]',
				dryRun: false,
			});
			const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
			const fm: Record<string, unknown> = {};
			callback(fm);
			expect(fm.tags).toEqual(["a", "b"]);
		});
	});

	describe("vault_frontmatter_delete", () => {
		it("deletes existing property", async () => {
			app.metadataCache.getFileCache.mockReturnValueOnce({
				frontmatter: { title: "Hello", status: "active", position: {} },
			});
			const r = getResult(
				await getTool(tools, "vault_frontmatter_delete").handler({
					path: "agent-workspace/draft.md",
					property: "status",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("Deleted status");
		});

		it("errors on missing property", async () => {
			app.metadataCache.getFileCache.mockReturnValueOnce({
				frontmatter: { title: "Hello" },
			});
			const r = getResult(
				await getTool(tools, "vault_frontmatter_delete").handler({
					path: "agent-workspace/draft.md",
					property: "nonexistent",
				}),
			);
			expect(r.isError).toBe(true);
		});
	});

	describe("vault_search_replace", () => {
		it("replaces literal text", async () => {
			app.vault.read.mockResolvedValueOnce("hello world hello");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "hello",
					replace: "hi",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("2 occurrence(s)");
			expect(app.vault.modify).toHaveBeenCalledWith(expect.anything(), "hi world hi");
		});

		it("replaces with regex", async () => {
			app.vault.read.mockResolvedValueOnce("foo123 bar456");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "([a-z]+)(\\d+)",
					replace: "$2-$1",
					regex: true,
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(expect.anything(), "123-foo 456-bar");
		});

		it("case-insensitive match", async () => {
			app.vault.read.mockResolvedValueOnce("Hello HELLO hello");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "hello",
					replace: "hi",
					caseSensitive: false,
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("3 occurrence(s)");
		});

		it("errors on invalid regex", async () => {
			app.vault.read.mockResolvedValueOnce("test");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "[invalid",
					replace: "x",
					regex: true,
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("Invalid regex");
		});

		it("errors when no matches found", async () => {
			app.vault.read.mockResolvedValueOnce("nothing here");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "missing",
					replace: "x",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("No matches");
		});

		it("treats $N literally when regex is off", async () => {
			app.vault.read.mockResolvedValueOnce("price tag");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "tag",
					replace: "$1-label",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(expect.anything(), "price $1-label");
		});

		it("honours $$ as literal $ in regex mode", async () => {
			app.vault.read.mockResolvedValueOnce("foo");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "(foo)",
					replace: "$$1=$1",
					regex: true,
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(expect.anything(), "$1=foo");
		});
	});

	describe("vault_prepend", () => {
		it("prepends to file without frontmatter", async () => {
			app.vault.read.mockResolvedValueOnce("existing content");
			app.metadataCache.getFileCache.mockReturnValueOnce(null);
			const r = getResult(
				await getTool(tools, "vault_prepend").handler({
					path: "agent-workspace/draft.md",
					content: "NEW LINE",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"NEW LINE\nexisting content",
			);
		});

		it("prepends after frontmatter", async () => {
			// Closing `---` is 3 chars on line 2; end.offset is exclusive (position
			// after the last `-`, i.e. the trailing `\n` at byte 19).
			app.vault.read.mockResolvedValueOnce("---\ntitle: Test\n---\nbody");
			app.metadataCache.getFileCache.mockReturnValueOnce({
				frontmatterPosition: {
					start: { line: 0, col: 0, offset: 0 },
					end: { line: 2, col: 3, offset: 19 },
				},
			});
			const r = getResult(
				await getTool(tools, "vault_prepend").handler({
					path: "agent-workspace/draft.md",
					content: "INSERTED",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toContain("---\ntitle: Test\n---\nINSERTED\nbody");
		});

		it("prepends after frontmatter when file has no body", async () => {
			// Frontmatter-only file: closing `---` plus a trailing newline at EOF,
			// no body content after. The newline-skip loop walks `insertPos` to
			// existing.length; we must still produce a valid prepend that lands
			// after the closing fence rather than splicing into it.
			const existing = "---\ntitle: Test\n---\n";
			app.vault.read.mockResolvedValueOnce(existing);
			app.metadataCache.getFileCache.mockReturnValueOnce({
				frontmatterPosition: {
					start: { line: 0, col: 0, offset: 0 },
					end: { line: 2, col: 3, offset: 19 },
				},
			});
			const r = getResult(
				await getTool(tools, "vault_prepend").handler({
					path: "agent-workspace/draft.md",
					content: "INSERTED",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			// Result must start with the original frontmatter block intact
			// (closing fence not perturbed), then the inserted content.
			expect(modified.startsWith("---\ntitle: Test\n---\n")).toBe(true);
			expect(modified).toContain("INSERTED");
			// The inserted content must come AFTER the closing fence, never
			// spliced inside the YAML block.
			const fenceEnd = modified.indexOf("---\n", 4);
			expect(modified.indexOf("INSERTED")).toBeGreaterThan(fenceEnd);
		});

		it("prepends after frontmatter with no trailing newline", async () => {
			// Edge case: closing `---` immediately at EOF (no terminator).
			// insertPos lands at existing.length; the newline-skip loop is a
			// no-op. The prepended content should still produce a well-formed
			// file with the inserted content separated by a newline.
			const existing = "---\ntitle: Test\n---";
			app.vault.read.mockResolvedValueOnce(existing);
			app.metadataCache.getFileCache.mockReturnValueOnce({
				frontmatterPosition: {
					start: { line: 0, col: 0, offset: 0 },
					end: { line: 2, col: 3, offset: 19 },
				},
			});
			const r = getResult(
				await getTool(tools, "vault_prepend").handler({
					path: "agent-workspace/draft.md",
					content: "INSERTED",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified.startsWith("---\ntitle: Test\n---")).toBe(true);
			expect(modified).toContain("INSERTED");
			// Inserted content must be separated from the closing fence by a
			// newline so the YAML block doesn't visually merge with the body.
			expect(modified).toMatch(/---\n+INSERTED/);
		});
	});

	describe("vault_patch", () => {
		it("inserts after a specific line", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2\nline3");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "INSERTED",
					line: 2,
					position: "after",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"line1\nline2\nINSERTED\nline3",
			);
		});

		it("inserts before a specific line", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2\nline3");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "INSERTED",
					line: 2,
					position: "before",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"line1\nINSERTED\nline2\nline3",
			);
		});

		it("replaces a specific line", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2\nline3");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "REPLACED",
					line: 2,
					position: "replace",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"line1\nREPLACED\nline3",
			);
		});

		it("errors when no target specified", async () => {
			app.vault.read.mockResolvedValueOnce("test");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("heading");
		});

		it("errors on out-of-range line", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
					line: 99,
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("out of range");
		});

		it("inserts after heading", async () => {
			app.vault.read.mockResolvedValueOnce("# Title\nIntro\n## Details\nBody\n## Next");
			app.metadataCache.getFileCache.mockReturnValueOnce({
				headings: [
					{ heading: "Title", level: 1, position: { start: { line: 0 } } },
					{ heading: "Details", level: 2, position: { start: { line: 2 } } },
					{ heading: "Next", level: 2, position: { start: { line: 4 } } },
				],
			});
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "ADDED",
					heading: "## Details",
					position: "after",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toContain("Body\nADDED\n## Next");
		});

		it("errors on nonexistent heading", async () => {
			app.vault.read.mockResolvedValueOnce("no headings");
			app.metadataCache.getFileCache.mockReturnValueOnce({ headings: [] });
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
					heading: "Missing",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("not found");
		});

		// Helper: build heading metadata for a multi-section file
		// "# Title\nIntro\n## Details\nBody\n## Next\nTail"
		// Line 0: # Title, Line 2: ## Details, Line 4: ## Next
		const multiSectionFile = "# Title\nIntro\n## Details\nBody\n## Next\nTail";
		const multiSectionHeadings = [
			{ heading: "Title", level: 1, position: { start: { line: 0 } } },
			{ heading: "Details", level: 2, position: { start: { line: 2 } } },
			{ heading: "Next", level: 2, position: { start: { line: 4 } } },
		];

		it("end_of_block with heading inserts at end of section (same as after)", async () => {
			app.vault.read.mockResolvedValueOnce(multiSectionFile);
			app.metadataCache.getFileCache.mockReturnValueOnce({ headings: multiSectionHeadings });
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "ADDED",
					heading: "## Details",
					position: "end_of_block",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toBe("# Title\nIntro\n## Details\nBody\nADDED\n## Next\nTail");
		});

		it("start_of_block with heading inserts immediately after heading line", async () => {
			app.vault.read.mockResolvedValueOnce(multiSectionFile);
			app.metadataCache.getFileCache.mockReturnValueOnce({ headings: multiSectionHeadings });
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "PREPENDED",
					heading: "## Details",
					position: "start_of_block",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toBe("# Title\nIntro\n## Details\nPREPENDED\nBody\n## Next\nTail");
		});

		it("before with heading inserts before the heading line", async () => {
			app.vault.read.mockResolvedValueOnce(multiSectionFile);
			app.metadataCache.getFileCache.mockReturnValueOnce({ headings: multiSectionHeadings });
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "BEFORE",
					heading: "## Details",
					position: "before",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toBe("# Title\nIntro\nBEFORE\n## Details\nBody\n## Next\nTail");
		});

		it("end_of_block on a single-section file (last heading) inserts at document end", async () => {
			// Single section: heading is the last one — endLine falls back to lines.length
			app.vault.read.mockResolvedValueOnce("## Only\nContent");
			app.metadataCache.getFileCache.mockReturnValueOnce({
				headings: [{ heading: "Only", level: 2, position: { start: { line: 0 } } }],
			});
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "APPENDED",
					heading: "## Only",
					position: "end_of_block",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toBe("## Only\nContent\nAPPENDED");
		});

		it("start_of_block on a heading with no body inserts between heading and next heading", async () => {
			app.vault.read.mockResolvedValueOnce("## Empty\n## Next");
			app.metadataCache.getFileCache.mockReturnValueOnce({
				headings: [
					{ heading: "Empty", level: 2, position: { start: { line: 0 } } },
					{ heading: "Next", level: 2, position: { start: { line: 1 } } },
				],
			});
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "BODY",
					heading: "## Empty",
					position: "start_of_block",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toBe("## Empty\nBODY\n## Next");
		});

		it("replace is rejected for heading targets", async () => {
			app.vault.read.mockResolvedValueOnce("## H\nBody");
			app.metadataCache.getFileCache.mockReturnValueOnce({
				headings: [{ heading: "H", level: 2, position: { start: { line: 0 } } }],
			});
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
					heading: "## H",
					position: "replace",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("replace");
		});

		it("start_of_block is rejected for line targets", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
					line: 1,
					position: "start_of_block",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("start_of_block");
		});

		it("end_of_block is rejected for line targets", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
					line: 1,
					position: "end_of_block",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("end_of_block");
		});
	});

	describe("vault_search chunked early-exit", () => {
		it("stops reading once limit is reached and never returns more than limit", async () => {
			const manyFiles = Array.from({ length: 100 }, (_, i) => makeTFile(`notes/f${i}.md`));
			const localApp = createMockApp(manyFiles, {});
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
			});
			const r = getResult(
				await getTool(localTools, "vault_search").handler({ query: "x", limit: 5 }),
			);
			expect(r.isError).toBe(false);
			expect(r.text.split("\n")).toHaveLength(5);
			// chunk size is 20 — with limit 5 every file matches (mocked), so
			// one chunk is enough. We should not have read the full 100.
			expect(localApp.vault.cachedRead.mock.calls.length).toBeLessThanOrEqual(20);
		});
	});

	describe("writeScoped out-of-scope fast-fail", () => {
		const outOfScopePath = "notes/hello.md";
		const inScopePath = "agent-workspace/draft.md";
		const writeDir = "agent-workspace";

		it("vault_create rejects a path outside the write directory synchronously", async () => {
			const t0 = Date.now();
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: outOfScopePath,
					content: "x",
				}),
			);
			expect(Date.now() - t0).toBeLessThan(50);
			expect(r.isError).toBe(true);
			expect(r.text).toContain(writeDir);
			expect(app.vault.create).not.toHaveBeenCalled();
		});

		it.each([
			["vault_modify", { content: "x" }],
			["vault_append", { content: "x" }],
			["vault_prepend", { content: "x" }],
			["vault_search_replace", { search: "a", replace: "b" }],
			["vault_frontmatter_set", { property: "k", value: '"v"' }],
			["vault_frontmatter_delete", { property: "k" }],
			["vault_patch", { content: "x", heading: "Introduction" }],
		])("%s rejects a path outside the write directory", async (name, extra) => {
			const t0 = Date.now();
			const r = getResult(
				await getTool(tools, name).handler({ path: outOfScopePath, ...extra }),
			);
			expect(Date.now() - t0).toBeLessThan(50);
			expect(r.isError).toBe(true);
			expect(r.text).toContain(writeDir);
		});

		it("vault_create accepts a path within the write directory", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: `${inScopePath}.new`,
					content: "x",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.create).toHaveBeenCalled();
		});

		it("writeScoped tool descriptions point at the configured write directory", () => {
			// Description text deliberately doesn't embed the path (it would go stale if
			// the user changes vaultWriteDir without restarting the MCP server). Agents
			// call mcp_capabilities for the live path; the description just signals scope.
			const createTool = getTool(tools, "vault_create");
			expect(createTool.config.description).toContain("write directory");
		});
	});

	describe("tier filtering contract", () => {
		it("only builds tools registered across tiers; filtering is the server's job", () => {
			// buildTools does not filter — writeVault/manage/reviewed variants
			// exist in the raw list. The server filter at mcp-server.ts:210
			// gates them.
			const names = tools.map((t) => t.name);
			expect(names).toContain("vault_create");
			expect(names).toContain("vault_create_anywhere");
			expect(names).toContain("vault_create_reviewed");
			expect(names).toContain("vault_rename");
			expect(names).toContain("vault_delete");
		});

		it("reviewed variants are absent when no reviewFn is provided", () => {
			const localApp = createMockApp(testFiles, { caches });
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
			});
			const names = localTools.map((t) => t.name);
			expect(names).not.toContain("vault_create_reviewed");
			expect(names).not.toContain("vault_modify_reviewed");
		});
	});

	describe("path-filter output gating (info-disclosure boundary)", () => {
		// pathFilter restricts visibility to `notes/`; link/graph/backlink
		// outputs must not leak `secret/` paths even when allowed files'
		// resolved-link metadata references them.
		const filteredFiles = [
			makeTFile("notes/visible.md"),
			makeTFile("notes/sibling.md"),
			makeTFile("secret/hidden.md"),
		];
		let localApp: ReturnType<typeof createMockApp>;
		let filteredTools: McpToolDef[];

		beforeEach(() => {
			localApp = createMockApp(filteredFiles);
			localApp.metadataCache.resolvedLinks = {
				"notes/visible.md": { "notes/sibling.md": 1, "secret/hidden.md": 1 },
				"notes/sibling.md": { "notes/visible.md": 1 },
				"secret/hidden.md": { "notes/visible.md": 1 },
			};
			localApp.metadataCache.unresolvedLinks = {
				"notes/visible.md": { "secret/missing": 1 },
				"secret/hidden.md": { "secret/missing": 1 },
			};
			filteredTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				pathFilter: { allowlist: ["notes/"], blocklist: [] },
			});
		});

		it("vault_links omits targets outside the allowlist", async () => {
			const r = getResult(
				await getTool(filteredTools, "vault_links").handler({ path: "notes/visible.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("notes/sibling.md");
			expect(r.text).not.toContain("secret/hidden.md");
		});

		it("vault_backlinks omits sources outside the allowlist", async () => {
			const r = getResult(
				await getTool(filteredTools, "vault_backlinks").handler({
					path: "notes/visible.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).not.toContain("secret/hidden.md");
		});

		it("vault_orphans omits files outside the allowlist", async () => {
			const r = getResult(await getTool(filteredTools, "vault_orphans").handler({}));
			expect(r.text).not.toContain("secret/");
		});

		it("vault_unresolved omits unresolved-links from blocked source files", async () => {
			const r = getResult(await getTool(filteredTools, "vault_unresolved").handler({}));
			expect(r.text).not.toContain("from secret/hidden.md");
		});
	});

	describe("vault_create_folder traversal guards", () => {
		it("rejects '..' path segments up-front", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_folder").handler({ path: "../escape" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/may not contain a '\.\.'/);
		});

		it("rejects leading-slash absolute paths up-front", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_folder").handler({ path: "/etc" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/may not contain a '\.\.'/);
		});

		it("rejects Windows drive-letter paths", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_folder").handler({ path: "C:foo" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/drive letter|alt-data-stream/);
		});

		it("rejects paths containing ':' (NTFS alt-data-stream)", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_folder").handler({ path: "notes:hidden" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/drive letter|alt-data-stream/);
		});
	});

	describe("vault_move destination gating (writeDir escape boundary)", () => {
		// vault_move must gate the DESTINATION through gateVaultWrite, not the
		// source. A writeScoped+manage agent could otherwise lift a file from
		// inside writeDir to anywhere — pathFilter only enforces allow/block,
		// not writeDir scoping.

		it("scoped-only mode rejects moves whose destination escapes writeDir", async () => {
			const localApp = createMockApp(
				[makeTFile("agent-workspace/draft.md"), makeTFile("notes/hello.md")],
				{ caches: {} },
			);
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				review: undefined,
				enabledTiers: new Set(["read", "writeScoped", "manage"]),
			});
			const r = getResult(
				await getTool(localTools, "vault_move").handler({
					path: "agent-workspace/draft.md",
					to: "notes",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/outside the write directory|reviewed writes/);
			expect(localApp.fileManager.renameFile).not.toHaveBeenCalled();
		});

		it("scoped-only mode rejects moves whose source is outside writeDir", async () => {
			const localApp = createMockApp(
				[makeTFile("notes/hello.md"), makeTFile("agent-workspace/draft.md")],
				{ caches: {} },
			);
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				review: undefined,
				enabledTiers: new Set(["read", "writeScoped", "manage"]),
			});
			const r = getResult(
				await getTool(localTools, "vault_move").handler({
					path: "notes/hello.md",
					to: "agent-workspace",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/Source.*outside the write directory/);
			expect(localApp.fileManager.renameFile).not.toHaveBeenCalled();
		});

		it("scoped-only mode allows moves where BOTH endpoints sit inside writeDir", async () => {
			const localApp = createMockApp(
				[makeTFile("agent-workspace/a.md"), makeTFile("agent-workspace/sub/.keep")],
				{ caches: {} },
			);
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				review: undefined,
				enabledTiers: new Set(["read", "writeScoped", "manage"]),
			});
			const r = getResult(
				await getTool(localTools, "vault_move").handler({
					path: "agent-workspace/a.md",
					to: "agent-workspace/sub",
				}),
			);
			expect(r.isError).toBe(false);
			expect(localApp.fileManager.renameFile).toHaveBeenCalled();
		});

		it("full vault-write mode allows moves anywhere", async () => {
			const localApp = createMockApp(
				[makeTFile("agent-workspace/draft.md"), makeTFile("notes/hello.md")],
				{ caches: {} },
			);
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
				review: undefined,
				enabledTiers: new Set(["read", "writeScoped", "writeVault", "manage"]),
			});
			const r = getResult(
				await getTool(localTools, "vault_move").handler({
					path: "agent-workspace/draft.md",
					to: "notes",
				}),
			);
			expect(r.isError).toBe(false);
			expect(localApp.fileManager.renameFile).toHaveBeenCalled();
		});
	});

	describe("frontmatter property safety", () => {
		it("vault_frontmatter_set rejects __proto__ property name", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "__proto__",
					value: "evil",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/not allowed/i);
		});

		it("vault_frontmatter_delete rejects constructor property name", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter_delete").handler({
					path: "agent-workspace/draft.md",
					property: "constructor",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/not allowed/i);
		});

		it("vault_batch_frontmatter rejects prototype property name", async () => {
			const r = getResult(
				await getTool(tools, "vault_batch_frontmatter").handler({
					query: "anything",
					property: "prototype",
					value: "x",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/not allowed/i);
		});

		it("vault_properties rejects __proto__ as the property to look up", async () => {
			const r = getResult(
				await getTool(tools, "vault_properties").handler({ property: "__proto__" }),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toMatch(/not allowed/i);
		});
	});

	describe("vault_search_replace backref grammar", () => {
		// Verify the regex backref parser matches String.replace semantics for
		// $& / $` / $' and degrades safely on out-of-range $N references.
		const sources: Record<string, string> = {
			"agent-workspace/sample.md": "FOO bar BAZ",
		};
		let localApp: ReturnType<typeof createMockApp>;
		let localTools: McpToolDef[];

		beforeEach(() => {
			const file = makeTFile(
				"agent-workspace/sample.md",
				sources["agent-workspace/sample.md"],
			);
			localApp = createMockApp([file], {
				readBody: (f) => sources[f.path] ?? "",
			});
			localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
			});
		});

		it("$& expands to the whole match", async () => {
			const r = getResult(
				await getTool(localTools, "vault_search_replace").handler({
					path: "agent-workspace/sample.md",
					search: "b\\w+",
					replace: "[$&]",
					regex: true,
				}),
			);
			expect(r.isError).toBe(false);
			expect(localApp.vault.modify).toHaveBeenCalledWith(expect.anything(), "FOO [bar] BAZ");
		});

		it("out-of-range numeric backref is passed through literally", async () => {
			const r = getResult(
				await getTool(localTools, "vault_search_replace").handler({
					path: "agent-workspace/sample.md",
					search: "(b)(a)(r)",
					replace: "$1-$2-$3-$9",
					regex: true,
				}),
			);
			expect(r.isError).toBe(false);
			expect(localApp.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"FOO b-a-r-$9 BAZ",
			);
		});
	});
});

describe("previewTemplaterFolderTemplate — no-match and no-plugin paths", () => {
	it("returns null when Templater plugin is not installed", async () => {
		const mockApp = createMockApp([]);
		// No plugins property → getInstalledPlugin returns null.
		const result = await previewTemplaterFolderTemplate(mockApp as never, "notes/new.md");
		expect(result).toBeNull();
	});

	it("returns null when folder templates are disabled in Templater settings", async () => {
		const mockApp = createMockApp([]);
		(mockApp as unknown as { plugins: unknown }).plugins = {
			enabledPlugins: new Set(["templater-obsidian"]),
			plugins: {
				"templater-obsidian": {
					settings: {
						enable_folder_templates: false,
						folder_templates: [{ folder: "notes", template: "Templates/T.md" }],
					},
				},
			},
		};
		const result = await previewTemplaterFolderTemplate(mockApp as never, "notes/new.md");
		expect(result).toBeNull();
	});

	it("returns null when no folder template matches the target path", async () => {
		const mockApp = createMockApp([]);
		(mockApp as unknown as { plugins: unknown }).plugins = {
			enabledPlugins: new Set(["templater-obsidian"]),
			plugins: {
				"templater-obsidian": {
					settings: {
						enable_folder_templates: true,
						folder_templates: [{ folder: "elsewhere", template: "Templates/T.md" }],
					},
				},
			},
		};
		// Target is in "notes/" which doesn't match "elsewhere" folder template.
		const result = await previewTemplaterFolderTemplate(mockApp as never, "notes/new.md");
		expect(result).toBeNull();
	});

	it("returns the template body when a matching folder template is found", async () => {
		const tplFile = makeTFile("Templates/T.md");
		const mockApp = createMockApp([tplFile], { readBody: "# Template content" });
		(mockApp as unknown as { plugins: unknown }).plugins = {
			enabledPlugins: new Set(["templater-obsidian"]),
			plugins: {
				"templater-obsidian": {
					settings: {
						enable_folder_templates: true,
						folder_templates: [{ folder: "notes", template: "Templates/T.md" }],
					},
				},
			},
		};
		const result = await previewTemplaterFolderTemplate(mockApp as never, "notes/new.md");
		expect(result).toBe("# Template content");
	});
});

describe("isPathAllowedByFilter — workspace-bypass and filter logic", () => {
	it("returns true when no pathFilter is provided", () => {
		expect(isPathAllowedByFilter("any/path.md", undefined)).toBe(true);
	});

	it("path inside writeDir bypasses a restrictive blocklist (workspace bypass)", () => {
		const filter: PathFilter = {
			allowlist: [],
			blocklist: [".obsidian/", "secret/"],
			getWriteDir: () => "agent-workspace",
		};
		// Even though the blocklist is restrictive, paths inside writeDir are always allowed.
		expect(isPathAllowedByFilter("agent-workspace/draft.md", filter)).toBe(true);
	});

	it("path outside writeDir that is in blocklist is blocked", () => {
		const filter: PathFilter = {
			allowlist: [],
			blocklist: [".obsidian/"],
			getWriteDir: () => "agent-workspace",
		};
		expect(isPathAllowedByFilter(".obsidian/plugins/foo.json", filter)).toBe(false);
	});

	it("path outside writeDir with empty allow/blocklist is allowed", () => {
		const filter: PathFilter = {
			allowlist: [],
			blocklist: [],
			getWriteDir: () => "agent-workspace",
		};
		expect(isPathAllowedByFilter("notes/hello.md", filter)).toBe(true);
	});

	it("path outside writeDir matching allowlist is allowed", () => {
		const filter: PathFilter = {
			allowlist: ["notes/"],
			blocklist: [".obsidian/"],
			getWriteDir: () => "agent-workspace",
		};
		expect(isPathAllowedByFilter("notes/hello.md", filter)).toBe(true);
	});

	it("path outside writeDir not in allowlist is blocked when allowlist is non-empty", () => {
		const filter: PathFilter = {
			allowlist: ["notes/"],
			blocklist: [],
			getWriteDir: () => "agent-workspace",
		};
		expect(isPathAllowedByFilter("other/file.md", filter)).toBe(false);
	});

	it("filter without getWriteDir still applies allow/blocklist", () => {
		const filter: PathFilter = {
			allowlist: [],
			blocklist: ["secret/"],
		};
		expect(isPathAllowedByFilter("secret/private.md", filter)).toBe(false);
		expect(isPathAllowedByFilter("notes/ok.md", filter)).toBe(true);
	});
});
