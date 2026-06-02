/**
 * Typed accessors for Obsidian APIs that aren't part of the public typings.
 * Centralising the `as unknown as` casts keeps the risk surface in one file -
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
 * (mobile, in-memory test adapters, or any future adapter without
 * `getBasePath`/`getFullPath`) - the symlink-traversal guard becomes a
 * no-op there, and the first such call logs a warning so the dormant guard
 * is observable.
 *
 * Defense-in-depth: shape checks (`pathHasParentSegment`, drive-letter
 * rejection, etc.) still apply at the call site.
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
function getPluginsHost(app: App): PluginsHost | undefined {
	return (app as unknown as { plugins?: PluginsHost }).plugins;
}

/**
 * Look up an installed + enabled plugin by id. Returns null when the plugin
 * isn't installed, isn't enabled, or the host shape is unexpected.
 */
export function getInstalledPlugin<T = unknown>(app: App, pluginId: string): T | null {
	const host = getPluginsHost(app);
	if (!host) return null;
	// Obsidian keeps the plugin instance in `plugins` after disable, so
	// checking only `plugins[id]` would treat a disabled Templater/Dataview/
	// Tasks as enabled. Require enabledPlugins membership explicitly.
	if (!host.enabledPlugins || !host.enabledPlugins.has(pluginId)) return null;
	const plugin = host.getPlugin?.(pluginId) ?? host.plugins?.[pluginId] ?? null;
	return plugin as T | null;
}

/** Internal shape used for tab-header access. */
interface LeafInternals {
	updateHeader?: () => void;
	tabHeaderInnerTitleEl?: { setText: (s: string) => void };
}

/** One-time latch so the fallback warning fires once per plugin load. */
let updateHeaderMissingWarned = false;

/**
 * Trigger Obsidian's leaf-header refresh.
 *
 * Tries `updateHeader()` first, an internal that re-reads `getDisplayText()`
 * from the view and updates the DOM. Falls back to writing `leaf.getDisplayText()`
 * directly to `tabHeaderInnerTitleEl` if the method is absent (renamed/removed
 * in a newer Obsidian build). Logs once so the fallback is observable.
 */
export function refreshLeafHeader(leaf: WorkspaceLeaf): void {
	const l = leaf as unknown as LeafInternals;
	if (typeof l.updateHeader === "function") {
		l.updateHeader();
		return;
	}
	if (!updateHeaderMissingWarned) {
		updateHeaderMissingWarned = true;
		logger.warn(
			"ActivityUi",
			"`updateHeader` missing on WorkspaceLeaf; falling back to direct title write. Check for an Obsidian API change.",
		);
	}
	l.tabHeaderInnerTitleEl?.setText(leaf.getDisplayText());
}

/**
 * Write a title string directly to a leaf's tab-header title element.
 *
 * Used for deferred/placeholder leaves where the view's `getDisplayText()` is
 * not trustworthy (the view hasn't loaded yet). If `tabHeaderInnerTitleEl` is
 * absent the call is a safe no-op.
 */
export function setLeafTabTitle(leaf: WorkspaceLeaf, title: string): void {
	(leaf as unknown as LeafInternals).tabHeaderInnerTitleEl?.setText(title);
}

/** Open a submenu on a context-menu item if the host build supports it; otherwise return null. */
export function tryOpenSubmenu(item: MenuItem): Menu | null {
	const fn = (item as unknown as { setSubmenu?: () => Menu }).setSubmenu;
	return fn ? (fn.call(item) ?? null) : null;
}
