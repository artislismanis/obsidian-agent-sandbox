/**
 * Templater plugin integration for agent-driven file creation.
 *
 * Templater's built-in folder-template hook calls
 * `append_template_to_active_file`, which fails when there is no active editor
 * — exactly the situation when MCP tools create files programmatically. This
 * module sidesteps that path by calling Templater's editor-free
 * `write_template_to_file` directly, and by suppressing the create hook around
 * writes so its "no active editor" notice doesn't fire.
 *
 * Talks to a third-party plugin via untyped fields, so the depended-on shape
 * lives here as a single contract.
 */

import type { App, TFile } from "obsidian";
import { logger } from "./logger";
import { getInstalledPlugin } from "./obsidian-internals";
import { isPathWithinDir } from "./validation";

interface TemplaterPlugin {
	settings?: {
		enable_folder_templates?: boolean;
		trigger_on_file_creation?: boolean;
		folder_templates?: Array<{ folder?: string; template?: string }>;
	};
	templater?: {
		write_template_to_file: (templateFile: TFile, file: TFile) => Promise<void>;
		// `parse_template` renders a template string against a running config.
		// Pre-resolves the rendered body so review modals show what will
		// actually be written.
		parse_template?: (
			config: { target_file: TFile; run_mode: number; active_file?: TFile | null },
			template_content: string,
		) => Promise<string>;
	};
}

/**
 * Resolve which folder template would apply to a freshly-created file at
 * `targetPath`. Returns the template TFile or null. Decoupled from
 * applyTemplaterFolderTemplate so callers can render a preview without
 * actually creating the file.
 */
function findTemplaterFolderTemplate(app: App, targetPath: string): TFile | null {
	const tp = getTemplaterPlugin(app);
	if (!tp?.settings?.enable_folder_templates) return null;
	const folderTemplates = tp.settings.folder_templates ?? [];
	const slash = targetPath.lastIndexOf("/");
	const dir = slash >= 0 ? targetPath.slice(0, slash) : "";
	let best: { template: string; len: number } | null = null;
	for (const ft of folderTemplates) {
		if (!ft.folder || !ft.template) continue;
		const folder = ft.folder === "/" ? "" : ft.folder.replace(/\/$/, "");
		const matches = folder === "" || isPathWithinDir(dir, folder);
		if (!matches) continue;
		const len = folder.length;
		if (!best || len > best.len) best = { template: ft.template, len };
	}
	if (!best) return null;
	return app.vault.getFileByPath(best.template);
}

/**
 * Read the raw body of the matching folder template, without rendering. The
 * review modal shows this verbatim — Templater placeholders like `<% tp.date.now() %>`
 * remain visible. Rendering before user approval would require creating the
 * target file, defeating the review gate.
 */
export async function previewTemplaterFolderTemplate(
	app: App,
	targetPath: string,
): Promise<string | null> {
	const tplFile = findTemplaterFolderTemplate(app, targetPath);
	if (!tplFile) return null;
	try {
		return await app.vault.cachedRead(tplFile);
	} catch {
		return null;
	}
}

function getTemplaterPlugin(app: App): TemplaterPlugin | null {
	return getInstalledPlugin<TemplaterPlugin>(app, "templater-obsidian");
}

/**
 * Apply the matching Templater folder template to a freshly created file.
 *
 * Returns `{ ok: true, template }` with the template's vault path on success,
 * `{ ok: false, reason: "none" }` when no template matches (silent skip), or
 * `{ ok: false, reason: "failed", error }` when the template existed but
 * Templater rejected the apply. The distinction matters because the caller
 * (vault_create) reviewed the template body and approved it — if the apply
 * fails, the on-disk file is empty and the user's approved content never
 * landed. Returning that as a generic "no template" is a silent failure;
 * surfacing the error lets the caller communicate that the file was created
 * empty instead of with the approved template body.
 */
export type TemplaterApplyResult =
	| { ok: true; template: string }
	| { ok: false; reason: "none" }
	| { ok: false; reason: "failed"; error: string };

export async function applyTemplaterFolderTemplate(
	app: App,
	file: TFile,
): Promise<TemplaterApplyResult> {
	const tp = getTemplaterPlugin(app);
	if (!tp?.templater || !tp.settings?.enable_folder_templates)
		return { ok: false, reason: "none" };
	const folderTemplates = tp.settings.folder_templates ?? [];
	const dir = file.parent?.path ?? "";
	// Longest-prefix wins, matching Templater's own resolution.
	let best: { folder: string; template: string; len: number } | null = null;
	for (const ft of folderTemplates) {
		if (!ft.folder || !ft.template) continue;
		const folder = ft.folder === "/" ? "" : ft.folder.replace(/\/$/, "");
		const matches = folder === "" || isPathWithinDir(dir, folder);
		if (!matches) continue;
		const len = folder.length;
		if (!best || len > best.len) best = { folder: ft.folder, template: ft.template, len };
	}
	if (!best) return { ok: false, reason: "none" };
	const tplFile = app.vault.getFileByPath(best.template);
	if (!tplFile) return { ok: false, reason: "none" };
	try {
		await tp.templater.write_template_to_file(tplFile, file);
		return { ok: true, template: tplFile.path };
	} catch (e) {
		logger.error("templater", "folder-template application failed", e);
		return { ok: false, reason: "failed", error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Run `fn` with Templater's create-hook setting flipped off, restoring the
 * prior value afterwards. Otherwise `vault.create` triggers Templater's "no
 * active editor" notice; templates are applied directly via
 * `applyTemplaterFolderTemplate`, so the hook is pure noise.
 *
 * Refcounted so concurrent `vault_create` calls compose safely: capture the
 * original on first entry, force-disable for the critical section, restore
 * only when the last in-flight call exits. A naive save/restore pair lets
 * the second concurrent call snapshot the already-disabled `false` and
 * "restore" that on exit, permanently disabling the hook.
 */
let templaterSuppressDepth = 0;
let templaterSuppressPrev: boolean | undefined;

/**
 * Reset the suppression counter on plugin load. The depth/prev state lives at
 * module scope and survives Obsidian's plugin enable/disable cycles (modules
 * are cached). Without this, a plugin unload racing a mid-flight
 * vault_create_with_template leaves `trigger_on_file_creation = false` on
 * Templater's settings until next Obsidian restart, permanently disabling
 * the user's hook.
 */
export function resetTemplaterSuppression(): void {
	templaterSuppressDepth = 0;
	templaterSuppressPrev = undefined;
}

export async function withTemplaterHookSuppressed<T>(app: App, fn: () => Promise<T>): Promise<T> {
	const tp = getTemplaterPlugin(app);
	if (!tp?.settings) return fn();
	if (templaterSuppressDepth === 0) {
		templaterSuppressPrev = tp.settings.trigger_on_file_creation;
	}
	templaterSuppressDepth++;
	tp.settings.trigger_on_file_creation = false;
	try {
		return await fn();
	} finally {
		templaterSuppressDepth--;
		if (templaterSuppressDepth === 0) {
			tp.settings.trigger_on_file_creation = templaterSuppressPrev;
			templaterSuppressPrev = undefined;
		}
	}
}
