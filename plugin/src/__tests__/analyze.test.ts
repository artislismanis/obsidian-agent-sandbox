import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { AnalyzeManager } from "../analyze";

function tmpPromptsDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "oas-prompts-"));
	const prompts = join(dir, ".claude", "prompts");
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

describe("AnalyzeManager template loading", () => {
	let tmpBase: string;

	beforeEach(() => {
		// nothing to reset
	});

	it("returns an empty list when the prompts directory is missing", async () => {
		tmpBase = mkdtempSync(join(tmpdir(), "oas-empty-"));
		const host = makeHost(tmpBase);
		const mgr = new AnalyzeManager(host);
		expect(await mgr.loadTemplates()).toEqual([]);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("reads templates and parses labels + bodies", async () => {
		tmpBase = tmpPromptsDir({
			"summarize.md": "Summarize\n---\nPlease summarize @{{file}}.",
			"critique.md": "Critique\n---\nCritique @{{file}} honestly.",
		});
		const host = makeHost(tmpBase);
		const mgr = new AnalyzeManager(host);
		const templates = await mgr.loadTemplates();
		expect(templates).toHaveLength(2);
		expect(templates.map((t) => t.name).sort()).toEqual(["critique", "summarize"]);
		const summarize = templates.find((t) => t.name === "summarize");
		expect(summarize?.label).toBe("Summarize");
		expect(summarize?.body).toContain("@{{file}}");
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("prewarm() populates the cache so attachFileMenu sees entries synchronously", async () => {
		tmpBase = tmpPromptsDir({
			"explain.md": "Explain\n---\nExplain @{{file}}",
		});
		const host = makeHost(tmpBase);
		const mgr = new AnalyzeManager(host);
		// Before prewarm the cache is empty — loadTemplates does disk I/O.
		await mgr.prewarm();
		const cached = await mgr.loadTemplates();
		expect(cached.map((t) => t.name)).toEqual(["explain"]);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("refreshTemplates() invalidates the cache", async () => {
		tmpBase = tmpPromptsDir({
			"a.md": "A\n---\nbody A",
		});
		const host = makeHost(tmpBase);
		const mgr = new AnalyzeManager(host);
		await mgr.prewarm();
		expect(await mgr.loadTemplates()).toHaveLength(1);

		// Add a new template on disk — cache hides it until refresh.
		writeFileSync(join(tmpBase, ".claude", "prompts", "b.md"), "B\n---\nbody B", "utf-8");
		expect(await mgr.loadTemplates()).toHaveLength(1);

		mgr.refreshTemplates();
		const fresh = await mgr.loadTemplates();
		expect(fresh).toHaveLength(2);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("runAnalyze with an unknown template produces no terminal activation", async () => {
		tmpBase = tmpPromptsDir({});
		const host = makeHost(tmpBase);
		const mgr = new AnalyzeManager(host);
		await mgr.runAnalyze("notes/foo.md", "nonexistent");
		expect(host.activateTerminalView).not.toHaveBeenCalled();
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("runAnalyze with no template uses the default prompt", async () => {
		tmpBase = tmpPromptsDir({});
		const host = makeHost(tmpBase);
		const mgr = new AnalyzeManager(host);
		await mgr.runAnalyze("notes/foo.md");
		expect(host.activateTerminalView).toHaveBeenCalledWith(
			undefined,
			"Please analyze @notes/foo.md.",
		);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("runAnalyze substitutes {{file}} in the template body", async () => {
		tmpBase = tmpPromptsDir({
			"summarize.md": "Summarize\n---\nSummarize @{{file}} in 3 points.",
		});
		const host = makeHost(tmpBase);
		const mgr = new AnalyzeManager(host);
		await mgr.prewarm();
		await mgr.runAnalyze("notes/foo.md", "summarize");
		expect(host.activateTerminalView).toHaveBeenCalledWith(
			undefined,
			"Summarize @notes/foo.md in 3 points.",
		);
		rmSync(tmpBase, { recursive: true, force: true });
	});

	it("skips terminal activation when container is not running", async () => {
		tmpBase = tmpPromptsDir({});
		const host = makeHost(tmpBase);
		host.isContainerRunning = vi.fn(() => false);
		const mgr = new AnalyzeManager(host);
		await mgr.runAnalyze("notes/foo.md");
		expect(host.activateTerminalView).not.toHaveBeenCalled();
		rmSync(tmpBase, { recursive: true, force: true });
	});
});
