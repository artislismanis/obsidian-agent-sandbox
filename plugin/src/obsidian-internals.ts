/**
 * Typed accessors for Obsidian APIs that aren't part of the public typings.
 * Centralising the `as unknown as` casts keeps the risk surface in one file —
 * if Obsidian changes one of these shapes, only this module needs an update.
 *
 * Each helper returns `undefined` (or null) when the underlying field is
 * missing, so callers must always handle the absent case rather than assuming
 * the shape is present.
 */

import type { App, Menu, MenuItem, WorkspaceLeaf } from "obsidian";
import { FileSystemAdapter } from "obsidian";
import { isRealPathWithinBase } from "./validation";
import { logger } from "./logger";

/** Vault filesystem base path on desktop, or null on mobile/test adapters. */
export function getVaultBasePath(app: App): string | null {
	const adapter = app.vault.adapter;
	return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
}

/** Resolve a vault-relative path to its absolute filesystem path on desktop, or null elsewhere. */
export function getVaultFullPath(app: App, vaultPath: string): string | null {
	const adapter = app.vault.adapter;
	return adapter instanceof FileSystemAdapter ? adapter.getFullPath(vaultPath) : null;
}

/** Module-level latch so the fail-open warning fires once per plugin load
 *  rather than once per tool call. Resetting on plugin reload is fine because
 *  the module is re-imported then. */
let nonFileSystemAdapterWarned = false;

/**
 * True when `vaultPath` resolves to a real filesystem path inside the vault
 * base. Returns `true` when the vault adapter isn't a `FileSystemAdapter`
 * (mobile, in-memory test adapters, or any future Obsidian adapter that
 * doesn't expose `getBasePath`/`getFullPath`) — so the symlink-traversal
 * guard becomes a no-op there. The first such call also logs a warning so
 * the dormant guard is at least observable in the dev console.
 *
 * Caller responsibility: this is defense-in-depth. The primary write-time
 * checks (`pathHasParentSegment`, drive-letter rejection, etc.) still
 * apply. Path components reaching here are expected to be already shape-
 * validated.
 */
export function isVaultPathSafe(app: App, vaultPath: string): boolean {
	const base = getVaultBasePath(app);
	const full = getVaultFullPath(app, vaultPath);
	if (base === null || full === null) {
		if (!nonFileSystemAdapterWarned) {
			nonFileSystemAdapterWarned = true;
			logger.warn(
				"Vault",
				"isVaultPathSafe: vault adapter is not FileSystemAdapter; symlink-traversal guard is a no-op for this session.",
			);
		}
		return true;
	}
	return isRealPathWithinBase(base, full);
}

/** The plugin host exposed on `app.plugins` (Obsidian doesn't type this). */
interface PluginsHost {
	plugins?: Record<string, unknown>;
	getPlugin?: (id: string) => unknown;
	enabledPlugins?: Set<string>;
}

/** Get the plugin-host object on `app`, or undefined if Obsidian hasn't wired one. */
export function getPluginsHost(app: App): PluginsHost | undefined {
	return (app as unknown as { plugins?: PluginsHost }).plugins;
}

/**
 * Look up an installed + enabled plugin by id. Returns null when the plugin
 * isn't installed, isn't enabled, or the host shape isn't what we expect.
 * Centralises the runtime shape check every integration would otherwise
 * duplicate.
 */
export function getInstalledPlugin<T = unknown>(app: App, pluginId: string): T | null {
	const host = getPluginsHost(app);
	if (!host) return null;
	// Require the enabledPlugins set to be present AND contain the id.
	// Earlier code made the `has` check conditional on the set existing, which
	// meant a missing set fell through to `host.plugins?.[id]` — but Obsidian
	// keeps the plugin instance object in `plugins` after disable, so a
	// disabled Templater/Dataview/Tasks would still register tools that fail
	// at runtime. Be strict.
	if (!host.enabledPlugins || !host.enabledPlugins.has(pluginId)) return null;
	const plugin = host.getPlugin?.(pluginId) ?? host.plugins?.[pluginId] ?? null;
	return plugin as T | null;
}

/** Trigger Obsidian's leaf-header refresh if the leaf supports it. */
export function refreshLeafHeader(leaf: WorkspaceLeaf): void {
	(leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
}

/** Open a submenu on a context-menu item if the host build supports it; otherwise return null. */
export function tryOpenSubmenu(item: MenuItem): Menu | null {
	const fn = (item as unknown as { setSubmenu?: () => Menu }).setSubmenu;
	return fn ? (fn.call(item) ?? null) : null;
}
