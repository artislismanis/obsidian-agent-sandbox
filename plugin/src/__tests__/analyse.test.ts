import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("obsidian", () => {
	class FakeFileSystemAdapter {
		constructor(public basePath: string) {}
		getBasePath(): string {
			return this.basePath;
		}
	}
	return {
		FileSystemAdapter: FakeFileSystemAdapter,
		Modal: class {
			titleEl = { setText: vi.fn() };
			contentEl = {
				createEl: vi.fn(() => ({ setText: vi.fn(), addEventListener: vi.fn() })),
				createDiv: vi.fn(),
			};
			open() {}
			close() {}
		},
		Notice: class {},
	};
});

import { FileSystemAdapter } from "obsidian";

import { AnalyseManager } from "../analyse";

function tmpOasPromptsDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "oas-prompts-"));
	const prompts = join(dir, ".oas", "prompts");
	mkdirSync(prompts, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(prompts, name), body, "utf-8");
	}
	return dir;
}

function makeHost(vaultBase: string) {
	const adapter = new (FileSystemAdapter as unknown as new (p: string) => {
		getBasePath: () => string;
	})(vaultBase);
	return {
		app: { vault: { adapter } } as never,
		isContainerRunning: vi.fn(() => true),
		activateTerminalView: vi.fn(async () => undefined),
	};
}

describe("AnalyseManager template loading", () => {
	let tmpBase: string;

	it("returns an empty list when .oas/prompts is missing", async () => {
		tmpBase = mkdtempSync(join(tmpdir(), "oas-empty-"));
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		expect(await mgr.loadTemplates()).toEqual([]);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("reads templates from .oas/prompts and parses labels + bodies", async () => {
		tmpBase = tmpOasPromptsDir({
			"summarize.md": "Summarize\n---\nPlease summarize @{{file}}.",
			"critique.md": "Critique\n---\nCritique @{{file}} honestly.",
		});
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		const templates = await mgr.loadTemplates();
		expect(templates).toHaveLength(2);
		expect(templates.map((t) => t.name).sort()).toEqual(["critique", "summarize"]);
		const summarize = templates.find((t) => t.name === "summarize");
		expect(summarize?.label).toBe("Summarize");
		expect(summarize?.body).toContain("@{{file}}");
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("prewarm() populates the cache so attachFileMenu sees entries synchronously", async () => {
		tmpBase = tmpOasPromptsDir({
			"explain.md": "Explain\n---\nExplain @{{file}}",
		});
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		// Before prewarm the cache is empty - loadTemplates does disk I/O.
		await mgr.prewarm();
		const cached = await mgr.loadTemplates();
		expect(cached.map((t) => t.name)).toEqual(["explain"]);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("runAnalyse with an unknown template produces no terminal activation", async () => {
		tmpBase = tmpOasPromptsDir({});
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		await mgr.runAnalyse("notes/foo.md", "nonexistent");
		expect(host.activateTerminalView).not.toHaveBeenCalled();
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("runAnalyse with no template uses the default prompt", async () => {
		tmpBase = tmpOasPromptsDir({});
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		await mgr.runAnalyse("notes/foo.md");
		expect(host.activateTerminalView).toHaveBeenCalledWith(
			undefined,
			"Please analyse @notes/foo.md.",
		);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("runAnalyse substitutes {{file}} in the template body", async () => {
		tmpBase = tmpOasPromptsDir({
			"summarize.md": "Summarize\n---\nSummarize @{{file}} in 3 points.",
		});
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		await mgr.prewarm();
		await mgr.runAnalyse("notes/foo.md", "summarize");
		expect(host.activateTerminalView).toHaveBeenCalledWith(
			undefined,
			"Summarize @notes/foo.md in 3 points.",
		);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("skips terminal activation when container is not running", async () => {
		tmpBase = tmpOasPromptsDir({});
		const host = makeHost(tmpBase);
		host.isContainerRunning = vi.fn(() => false);
		const mgr = new AnalyseManager(host);
		await mgr.runAnalyse("notes/foo.md");
		expect(host.activateTerminalView).not.toHaveBeenCalled();
		rmSync(tmpBase, { recursive: true, force: true });
	});
});

// QA plan 6.3 / 6.5 — the "Analyse in Sandbox" file-menu submenu. attachFileMenu
// only reads the cached template list + the host, so a fake Menu/MenuItem that
// records the structure exercises the real builder without Obsidian's Menu DOM.
interface FakeMenuRow {
	title: string;
	onClick?: () => void;
}

class FakeMenu {
	items: FakeMenuRow[] = [];
	childSubmenu: FakeMenu | null = null;

	addItem(cb: (item: FakeMenuItem) => void): this {
		const row: FakeMenuRow = { title: "" };
		// Arrow methods so `this` stays the FakeMenu without aliasing it.
		const item: FakeMenuItem = {
			setTitle: (t: string) => {
				row.title = t;
				return item;
			},
			setIcon: () => item,
			onClick: (fn: () => void) => {
				row.onClick = fn;
				return item;
			},
			// tryOpenSubmenu() calls this; returning a Menu routes the template
			// items into the submenu (the real Obsidian behaviour).
			setSubmenu: () => {
				this.childSubmenu = new FakeMenu();
				return this.childSubmenu;
			},
		};
		cb(item);
		this.items.push(row);
		return this;
	}
}

interface FakeMenuItem {
	setTitle: (t: string) => FakeMenuItem;
	setIcon: () => FakeMenuItem;
	onClick: (fn: () => void) => FakeMenuItem;
	setSubmenu: () => FakeMenu;
}

describe("AnalyseManager file menu (QA 6.3 / 6.5)", () => {
	const FOUR_TEMPLATES = {
		"summarize.md": "Summarise\n---\nSummarise @{{file}}.",
		"critique.md": "Critique\n---\nCritique @{{file}}.",
		"explain.md": "Explain\n---\nExplain @{{file}}.",
		"extract-todos.md": "Extract TODOs\n---\nExtract TODOs from @{{file}}.",
	};

	function submenuTitles(menu: FakeMenu): string[] {
		return (menu.childSubmenu?.items ?? []).map((i) => i.title);
	}

	it("6.3: lists the templates sorted alphabetically plus a trailing Custom prompt entry", async () => {
		const tmpBase = tmpOasPromptsDir(FOUR_TEMPLATES);
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		await mgr.prewarm();

		const menu = new FakeMenu();
		mgr.attachFileMenu(menu as never, { path: "notes/foo.md" } as never);

		// Top-level menu has the single "Analyse in Sandbox" entry; the rest
		// live in its submenu.
		expect(menu.items.map((i) => i.title)).toEqual(["Analyse in Sandbox"]);
		expect(submenuTitles(menu)).toEqual([
			"Critique",
			"Explain",
			"Extract TODOs",
			"Summarise",
			"Custom prompt…",
		]);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("6.3: clicking a template entry opens a terminal seeded with the substituted prompt", async () => {
		const tmpBase = tmpOasPromptsDir(FOUR_TEMPLATES);
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		await mgr.prewarm();

		const menu = new FakeMenu();
		mgr.attachFileMenu(menu as never, { path: "notes/foo.md" } as never);

		const critique = menu.childSubmenu?.items.find((i) => i.title === "Critique");
		critique?.onClick?.();
		await vi.waitFor(() =>
			expect(host.activateTerminalView).toHaveBeenCalledWith(
				undefined,
				"Critique @notes/foo.md.",
			),
		);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("6.5: with no templates the submenu collapses to just Custom prompt", async () => {
		const tmpBase = tmpOasPromptsDir({});
		const host = makeHost(tmpBase);
		const mgr = new AnalyseManager(host);
		await mgr.prewarm();

		const menu = new FakeMenu();
		mgr.attachFileMenu(menu as never, { path: "notes/foo.md" } as never);

		expect(submenuTitles(menu)).toEqual(["Custom prompt…"]);
		rmSync(tmpBase, { recursive: true, force: true });
	});
});
