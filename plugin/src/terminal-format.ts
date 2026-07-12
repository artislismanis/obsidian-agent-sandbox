/**
 * Pure terminal-formatting helpers with no Obsidian or xterm.js dependency.
 *
 * Split out of terminal-view.ts so modules that only need tab-title/formatting
 * logic (activity.ts, for deferred-leaf titles) don't pull xterm.js into their
 * import graph - terminal-view.ts's own tests otherwise have to `vi.mock`
 * "@xterm/xterm" and "@xterm/addon-fit" just to reach these pure functions.
 */

export type ActivityPrefix = "working" | "awaiting_input" | "idle" | null;

const PREFIX_SYMBOL: Record<Exclude<ActivityPrefix, null>, string> = {
	working: "⚙ ", // ⚙
	awaiting_input: "❓ ", // ❓
	idle: "✓ ", // ✓
};

/**
 * Compose a terminal tab title from session name, instance id, and activity
 * prefix. `instanceId` is omitted for deferred leaves, which don't have a
 * live TerminalView instance to read it from - those fall back to the bare
 * "Sandbox Terminal" label instead of a numbered one.
 */
export function composeTabTitle(
	sessionName: string | null,
	instanceId: number | undefined,
	prefix: ActivityPrefix,
): string {
	const base = sessionName
		? `Session: ${sessionName}`
		: instanceId !== undefined
			? `Sandbox Terminal ${instanceId}`
			: "Sandbox Terminal";
	return (prefix ? PREFIX_SYMBOL[prefix] : "") + base;
}

/**
 * Build xterm's `fontFamily` string: the user's chosen font first (if set),
 * then Obsidian's monospace var, then a portable mono fallback chain. Pure -
 * the caller resolves `obsidianFont` from `getComputedStyle` - so the
 * precedence and de-duplication are unit-testable (QA 2.7).
 */
export function composeFontFamily(userFont: string | undefined, obsidianFont: string): string {
	return [
		userFont?.trim(),
		obsidianFont.trim(),
		"Cascadia Code",
		"Cascadia Mono",
		"Consolas",
		"Menlo",
		"DejaVu Sans Mono",
		"monospace",
	]
		.filter(Boolean)
		.join(", ");
}

/**
 * Decide whether an `onSelectionChange` should copy to the clipboard. The
 * write is skipped when auto-copy is off, the selection is empty, or the
 * document lost focus (clipboard.writeText throws "Document is not focused"
 * otherwise). Pure so the gating is unit-testable (QA 2.7).
 */
export function shouldAutoCopy(opts: {
	enabled: boolean;
	selection: string;
	documentFocused: boolean;
}): boolean {
	return opts.enabled && opts.selection.length > 0 && opts.documentFocused;
}

/**
 * Decode an OSC 52 payload (`<selection>;<data>`, e.g. "c;<base64>") into the text
 * to place on the clipboard. Returns null for a read request ("?"), an empty/absent
 * data field, or invalid base64 - the caller then swallows the sequence without
 * touching the clipboard. Pure so the parsing is unit-testable (mirrors shouldAutoCopy).
 */
export function decodeOsc52(data: string): string | null {
	const sep = data.indexOf(";");
	if (sep === -1) return null;
	const payload = data.slice(sep + 1);
	if (payload === "" || payload === "?") return null; // "?" = clipboard READ request
	try {
		const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return null; // malformed base64
	}
}

// Mouse-tracking DECSET modes (CSI ? Pm h/l). Claude Code's fullscreen TUI
// enables these; once on, xterm.js forwards mouse events to the application and
// stops doing native text selection - breaking drag-to-select and the
// auto-copy-on-selection above. terminal-view.ts swallows these modes at the
// parser so the Obsidian terminal always keeps native selection/copy. Rendering
// modes (alt-screen 1049, synchronized output 2026, bracketed paste 2004, focus
// events 1004) are deliberately absent so flicker-free rendering is unaffected.
const MOUSE_TRACKING_MODES: ReadonlySet<number> = new Set([
	9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016,
]);

/**
 * True iff `params` is non-empty and every parameter is a mouse-tracking DECSET
 * mode. Used to decide whether to swallow a `CSI ? Pm h/l` sequence: swallow
 * only when the whole sequence is mouse-tracking, so a combined sequence that
 * also carries a needed mode (e.g. alt-screen) still falls through to xterm's
 * default handler. Pure, so the gating is unit-testable (mirrors shouldAutoCopy).
 */
export function isAllMouseModes(params: (number | number[])[]): boolean {
	if (params.length === 0) return false;
	return params.every((p) => typeof p === "number" && MOUSE_TRACKING_MODES.has(p));
}
