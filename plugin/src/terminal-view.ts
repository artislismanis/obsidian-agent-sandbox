import type { Menu, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { ItemView, Notice, Scope } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalSettings, TerminalThemeMode } from "./settings";
import { logger, errMsg } from "./logger";
import { refreshLeafHeader } from "./obsidian-internals";
import {
	pollUntilReady,
	buildWsUrl,
	exponentialBackoff,
	encodeInputFrames,
	reconnectDelayMs,
	RECONNECT_BACKOFF_MS,
} from "./ttyd-client";
import { isValidSessionName, tabKey } from "./validation";
import {
	composeFontFamily,
	composeTabTitle,
	decodeOsc52,
	isAllMouseModes,
	shouldAutoCopy,
	type ActivityPrefix,
} from "./terminal-format";
export {
	composeFontFamily,
	composeTabTitle,
	decodeOsc52,
	isAllMouseModes,
	shouldAutoCopy,
	type ActivityPrefix,
};

import { VIEW_TYPE_TERMINAL } from "./view-types";
export { VIEW_TYPE_TERMINAL };

const MAX_RETRIES = 15;

// ttyd wire protocol - single-byte command prefix. Each direction reuses the
// same ASCII codes with different meanings; only OUTPUT is consumed inbound.
const SERVER_MSG = { OUTPUT: 0x30 } as const;
const CLIENT_MSG = { INPUT: "0", RESIZE: "1" } as const;

const textEncoder = new TextEncoder();

let nextInstanceId = 1;

// WebSocket close-code → human label. Helps interpret container-side drops.
const CLOSE_CODE_NAMES: Record<number, string> = {
	1000: "normal",
	1001: "going-away",
	1002: "protocol-error",
	1003: "unsupported-data",
	1005: "no-status",
	1006: "abnormal-no-close-frame",
	1007: "invalid-payload",
	1008: "policy-violation",
	1009: "message-too-big",
	1011: "internal-error",
	1012: "service-restart",
	1013: "try-again-later",
	1015: "tls-handshake",
};

export interface TerminalConnectionEvent {
	at: number;
	instanceId: number;
	gen: number;
	kind: "open" | "close" | "error" | "reconnect";
	code?: number;
	codeName?: string;
	reason?: string;
	durationMs?: number;
	rxBytes?: number;
	txBytes?: number;
	rxMsgs?: number;
	idleMsBeforeClose?: number;
	attempt?: number;
}

// Process-wide ring buffer of recent connection events. Surfaced via the
// "Sandbox: Copy terminal connection log" command for postmortem of drops.
const CONNECTION_LOG_MAX = 200;
const connectionLog: TerminalConnectionEvent[] = [];

function pushConnectionEvent(ev: TerminalConnectionEvent): void {
	connectionLog.push(ev);
	if (connectionLog.length > CONNECTION_LOG_MAX) {
		connectionLog.splice(0, connectionLog.length - CONNECTION_LOG_MAX);
	}
}

/**
 * Send one or more ttyd INPUT frames over the socket, returning total bytes
 * written or 0 if the socket isn't open. Large inputs are split into ≤16 KiB
 * chunks to avoid `message-too-big` (1009) disconnects on large pastes.
 */
function sendInputText(ws: WebSocket | null, text: string): number {
	if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
	const frames = encodeInputFrames(text);
	let total = 0;
	for (const frame of frames) {
		ws.send(frame);
		total += frame.length;
	}
	return total;
}

export function getTerminalConnectionLog(): TerminalConnectionEvent[] {
	return connectionLog.slice();
}

/**
 * Reset the process-wide connection-log ring and instance counter. Call from
 * plugin onload so events from a previous plugin lifecycle (Obsidian caches
 * the module across disable+enable) don't bleed into postmortems for the
 * current session.
 */
export function resetTerminalConnectionLog(): void {
	connectionLog.length = 0;
	nextInstanceId = 1;
}

/** Format a connection event ring buffer for the "Copy connection log" command. */
export function formatConnectionLog(events: TerminalConnectionEvent[]): string {
	return events
		.map((e) => {
			const ts = new Date(e.at).toISOString();
			const head = `${ts}  inst=${e.instanceId} gen=${e.gen} ${e.kind}`;
			const parts: string[] = [];
			if (e.code != null) parts.push(`code=${e.code}(${e.codeName})`);
			if (e.reason) parts.push(`reason="${e.reason}"`);
			if (e.durationMs != null) parts.push(`duration=${e.durationMs}ms`);
			if (e.idleMsBeforeClose != null) parts.push(`idleBeforeClose=${e.idleMsBeforeClose}ms`);
			if (e.rxBytes != null) parts.push(`rx=${e.rxBytes}b/${e.rxMsgs}msgs`);
			if (e.txBytes != null) parts.push(`tx=${e.txBytes}b`);
			if (e.attempt) parts.push(`attempt=${e.attempt}`);
			return parts.length ? `${head}  ${parts.join(" ")}` : head;
		})
		.join("\n");
}

export class TerminalView extends ItemView {
	private getSettings: () => TerminalSettings;
	private instanceId: number;
	private generation = 0;
	private connecting = false;
	private sessionName: string | null = null;
	private activityPrefix: ActivityPrefix = null;
	private term: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ws: WebSocket | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeRafId: number | null = null;
	private termDisposables: { dispose(): void }[] = [];
	private wsDispose: (() => void) | null = null;

	// Lifecycle stats - reset per WS attach. Used for close diagnostics.
	private wsConnectStartedAt = 0;
	private wsOpenedAt = 0;
	private wsLastRxAt = 0;
	private wsRxBytes = 0;
	private wsTxBytes = 0;
	private wsRxMsgs = 0;
	private reconnectAttempt = 0;
	private reconnectTimer: number | null = null;
	private statusBanner: HTMLDivElement | null = null;
	// Tracked timers for the post-WS-open input-injection sequence (session
	// attach + initial prompt). Cleared in dispose() so a rapid view-close
	// can't fire them after the underlying ws/term refs are gone.
	private injectionTimers: number[] = [];

	// Promise-returning so the "Rename Session" menu item can attach a
	// `.catch` - a typed `() => void` would silently drop a setViewState
	// rejection that follows a successful tmux rename.
	onRenameSession: (() => Promise<void>) | null = null;
	private initialPrompt: string | null = null;

	constructor(leaf: WorkspaceLeaf, getSettings: () => TerminalSettings) {
		super(leaf);
		this.getSettings = getSettings;
		this.instanceId = nextInstanceId++;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return composeTabTitle(this.sessionName, this.instanceId, this.activityPrefix);
	}

	getSessionName(): string | null {
		return this.sessionName;
	}

	/**
	 * Routing key for activity-prefix updates. Named tabs use their session
	 * name so that multiple clients attached to the same tmux session all
	 * light up together (documented behaviour). Unnamed tabs use a per-tab
	 * key derived from the instance id so each "Sandbox Terminal" tab only
	 * reflects its own Claude process.
	 */
	getRoutingKey(): string {
		return this.sessionName ?? tabKey(this.instanceId);
	}

	/**
	 * Queue an initial prompt to run once the terminal connects. Passed to
	 * `claude` as a command-line argument so it works whether or not Claude
	 * Code is already auto-started by session.sh. Single-use: cleared after
	 * injection so reconnects don't replay it.
	 */
	queueInitialPrompt(prompt: string): void {
		this.initialPrompt = prompt;
	}

	/**
	 * Call when this view becomes the active leaf (tab-switch back to terminal).
	 * Triggers xterm's scroll-area height recompute via `_onScroll`, correcting
	 * the stale zero height cached while the pane was `display:none`.
	 */
	onBecomeVisible(): void {
		const term = this.term;
		if (!term) return;
		const buf = term.buffer.active;
		if (buf.baseY === 0) return; // no scrollback - no stale height possible
		// scrollLines fires _onScroll → viewport.syncScrollArea() detects the
		// stale _lastRecordedViewportHeight and queues a corrective RAF.
		// Both calls happen before any RAF, so net ydisp change is zero.
		if (buf.viewportY > 0) {
			term.scrollLines(-1);
			term.scrollLines(1);
		} else {
			term.scrollLines(1);
			term.scrollLines(-1);
		}
	}

	/** Append a connection event with `at`/`instanceId` filled in. */
	private logEvent(
		gen: number,
		kind: TerminalConnectionEvent["kind"],
		extra: Partial<TerminalConnectionEvent> = {},
	): void {
		pushConnectionEvent({
			at: extra.at ?? Date.now(),
			instanceId: this.instanceId,
			gen,
			kind,
			...extra,
		});
	}

	setActivityPrefix(prefix: ActivityPrefix): void {
		if (this.activityPrefix === prefix) return;
		this.activityPrefix = prefix;
		refreshLeafHeader(this.leaf);
	}

	getIcon(): string {
		return "terminal";
	}

	getState(): Record<string, unknown> {
		return { sessionName: this.sessionName };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (state && typeof state === "object" && "sessionName" in state) {
			const name = (state as { sessionName?: string }).sessionName;
			this.sessionName = typeof name === "string" ? name : null;
		}
		await super.setState(state, result);
	}

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		if (source === "tab-header" && this.sessionName) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Rename Session")
					.setIcon("pencil")
					.onClick(() => {
						const fn = this.onRenameSession;
						if (!fn) return;
						// Surface any error escaping the handler (e.g. the
						// post-tmux `setViewState` rejecting on a workspace
						// state race) instead of letting the rejection vanish.
						void fn().catch((err: unknown) => {
							new Notice(`Rename session failed: ${errMsg(err)}`);
						});
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle("Detach Session")
					.setIcon("log-out")
					.onClick(() => {
						this.leaf.detach();
					}),
			);
		}
	}

	private scopeInstalled = false;

	async onOpen(): Promise<void> {
		this.generation++;

		// Obsidian's Scope system intercepts Escape for "navigate back" before
		// the DOM event reaches xterm.js. Register a Scope handler that blocks
		// the navigation and routes ESC through xterm's input pipeline so
		// wsTxBytes accounting and any onData chain stay consistent.
		// Idempotency guard: Obsidian invokes onOpen again after restoring a
		// persisted leaf without popping the prior Scope, so without this flag
		// each restore leaks a Scope (only the most-recent Escape binding works).
		if (!this.scopeInstalled) {
			this.scope = new Scope(this.app.scope);
			this.scope.register([], "Escape", () => {
				this.term?.input("\x1b");
				return false;
			});
			this.scopeInstalled = true;
		}

		void this.connect();
	}

	async onClose(): Promise<void> {
		this.generation++;
		this.dispose();
		this.scopeInstalled = false;
	}

	onResize(): void {
		this.scheduleFit();
		// No focus call here - stealing focus on every resize (which fires when
		// other panes change layout, not just user interaction) is disruptive.
		// xterm focuses naturally on click/hotkey.
	}

	private scheduleFit(): void {
		if (this.resizeRafId != null) {
			cancelAnimationFrame(this.resizeRafId);
		}
		// Delay fit to let Obsidian finish layout transitions
		this.resizeRafId = requestAnimationFrame(() => {
			this.resizeRafId = null;
			if (!this.fitAddon || !this.term) return;
			const el = this.contentEl.querySelector(".sandbox-terminal-container");
			if (!el || el.clientWidth < 10 || el.clientHeight < 10) return;
			try {
				this.fitAddon.fit();
			} catch {
				/* pane not visible */
			}
		});
	}

	private async connect(): Promise<void> {
		if (this.connecting) return;
		this.connecting = true;
		const gen = this.generation;
		logger.info("Terminal", `Connecting (gen ${gen})`);

		try {
			const container = this.contentEl;
			container.empty();

			const loading = container.createDiv({ cls: "sandbox-terminal-loading" });
			loading.setText("Connecting to terminal...");

			const settings = this.getSettings();
			const connected = await pollUntilReady(
				settings.ttydPort,
				MAX_RETRIES,
				exponentialBackoff,
				() => gen !== this.generation,
				(attempt, waitMs) => {
					if (gen !== this.generation) return;
					loading.setText(
						`Connecting to terminal… (attempt ${attempt + 2}/${MAX_RETRIES}, retry in ${Math.round(waitMs / 100) / 10}s)`,
					);
				},
				settings.ttydBindAddress,
			);

			if (gen !== this.generation) return;

			container.empty();

			if (connected) {
				await this.initTerminal(container, gen);
			} else {
				this.showError(
					container,
					"Could not connect to ttyd. Make sure the container is running.",
				);
			}
		} catch (e) {
			// xterm init can throw on malformed settings (a custom font that
			// crashes the Terminal constructor, etc.). Catching here keeps the
			// rejection from floating up to `void this.connect()` in onOpen
			// and leaving the user with an empty pane and no retry button.
			logger.error("Terminal", "connect() failed", e);
			try {
				this.showError(this.contentEl, `Terminal initialization failed: ${errMsg(e)}`);
			} catch {
				/* showError itself can throw if contentEl was torn down */
			}
		} finally {
			this.connecting = false;
		}
	}

	private showError(container: HTMLElement, message: string): void {
		this.dispose();
		container.empty();
		const errorDiv = container.createDiv({ cls: "sandbox-terminal-error" });
		errorDiv.createEl("p").setText(message);
		const retryBtn = errorDiv.createEl("button");
		retryBtn.setText("Retry");
		// registerDomEvent is the Component-managed addEventListener: Obsidian
		// removes it automatically when this view is unloaded, so a rapid
		// view-close while the error UI is showing can't leak a closure
		// holding `this` (and the disposed term + ws) past the view's life.
		this.registerDomEvent(retryBtn, "click", () => {
			void this.connect();
		});
	}

	private buildTheme(
		mode: TerminalThemeMode,
		userFont?: string,
	): {
		fontFamily: string;
		theme: {
			background: string;
			foreground: string;
			cursor: string;
			selectionBackground: string;
		};
	} {
		const styles = getComputedStyle(document.body);
		const obsidianFont = styles.getPropertyValue("--font-monospace").trim();
		const fontFamily = composeFontFamily(userFont, obsidianFont);

		const cssVar = (name: string, fallback: string) =>
			styles.getPropertyValue(name).trim() || fallback;

		type ThemeColors = {
			background: string;
			foreground: string;
			cursor: string;
			selectionBackground: string;
		};

		const THEMES: Record<TerminalThemeMode, () => ThemeColors> = {
			dark: () => ({
				background: "#1e1e1e",
				foreground: "#d4d4d4",
				cursor: "#f0f0f0",
				selectionBackground: "#264f78",
			}),
			light: () => ({
				background: "#ffffff",
				foreground: "#383a42",
				cursor: "#526eff",
				selectionBackground: "#add6ff",
			}),
			obsidian: () => ({
				background: cssVar("--background-primary", "#1e1e1e"),
				foreground: cssVar("--text-normal", "#d4d4d4"),
				cursor: cssVar("--text-accent", "#f0f0f0"),
				selectionBackground: cssVar("--text-selection", "#264f78"),
			}),
		};

		return { fontFamily, theme: THEMES[mode]() };
	}

	private async initTerminal(container: HTMLElement, gen: number): Promise<void> {
		const wrapper = container.createDiv({ cls: "sandbox-terminal-container" });

		const settings = this.getSettings();
		const { fontFamily, theme } = this.buildTheme(
			settings.terminalTheme,
			settings.terminalFont,
		);

		const term = new Terminal({
			cursorBlink: true,
			fontSize: settings.terminalFontSize,
			fontFamily,
			theme,
			scrollback: settings.terminalScrollback,
			rightClickSelectsWord: true,
		});

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(wrapper);
		try {
			fitAddon.fit();
		} catch {
			/* container may not be visible yet */
		}

		// Strip application mouse-tracking (CSI ? Pm h/l for the mouse modes) so
		// native drag-selection + auto-copy keep working even when a full-screen
		// TUI like Claude Code enables mouse reporting. Custom parser handlers run
		// before xterm's built-in: returning true swallows the sequence (mouse
		// stays off), false falls through so non-mouse modes are handled normally.
		for (const final of ["h", "l"] as const) {
			this.termDisposables.push(
				term.parser.registerCsiHandler({ prefix: "?", final }, (params) =>
					isAllMouseModes(params),
				),
			);
		}

		// OSC 52: honour clipboard-WRITE requests from TUIs (e.g. Claude Code's "c to
		// copy"). xterm 5.5.0 has no built-in OSC 52 support, so the sequence is dropped
		// without this. Reads (payload "?") are ignored so a remote program can't
		// exfiltrate the host clipboard. Return true either way to swallow the sequence.
		this.termDisposables.push(
			term.parser.registerOscHandler(52, (data) => {
				const text = decodeOsc52(data);
				if (text !== null) {
					navigator.clipboard.writeText(text).catch(() => {});
				}
				return true;
			}),
		);

		// Clipboard: auto-copy on selection (opt-out via setting), Ctrl+V / Ctrl+Shift+V to paste
		this.termDisposables.push(
			term.onSelectionChange(() => {
				const selection = term.getSelection();
				// clipboard.writeText throws DOMException "Document is not
				// focused" when Obsidian's window lost focus mid-selection.
				// shouldAutoCopy gates on that (and the opt-out setting + empty
				// selection) so the write is skipped rather than emitting a
				// noisy console warning.
				const focused = typeof document === "undefined" || document.hasFocus();
				if (
					!shouldAutoCopy({
						enabled: this.getSettings().clipboardAutoCopy,
						selection,
						documentFocused: focused,
					})
				) {
					return;
				}
				navigator.clipboard.writeText(selection).catch(() => {});
			}),
		);

		term.attachCustomKeyEventHandler((event) => {
			// Ctrl+C with an active selection copies (like Terminal.app/iTerm2),
			// but only when auto-copy is off - if auto-copy is on the selection
			// is already in the clipboard, so Ctrl+C should keep its SIGINT meaning.
			if (
				event.type === "keydown" &&
				event.ctrlKey &&
				!event.shiftKey &&
				!event.altKey &&
				event.key.toLowerCase() === "c" &&
				term.hasSelection() &&
				!this.getSettings().clipboardAutoCopy
			) {
				const sel = term.getSelection();
				if (sel && typeof document !== "undefined" && document.hasFocus()) {
					navigator.clipboard.writeText(sel).catch(() => {});
				}
				term.clearSelection();
				return false;
			}
			// preventDefault() is required: returning false from
			// attachCustomKeyEventHandler exits xterm's _keyDown without
			// suppressing the event, letting the browser fire a native paste
			// alongside term.paste().
			if (
				event.type === "keydown" &&
				event.ctrlKey &&
				!event.altKey &&
				event.key.toLowerCase() === "v"
			) {
				event.preventDefault();
				navigator.clipboard.readText().then(
					(text) => term.paste(text),
					() => {},
				);
				return false;
			}
			return true;
		});

		this.term = term;
		this.fitAddon = fitAddon;

		// Forward xterm I/O via this.ws so a reconnect (which swaps this.ws)
		// keeps working without re-registering listeners.
		this.termDisposables.push(
			term.onData((input) => {
				this.wsTxBytes += sendInputText(this.ws, input);
			}),
		);

		this.termDisposables.push(
			term.onResize(({ cols, rows }) => {
				const ws = this.ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					const msg = CLIENT_MSG.RESIZE + JSON.stringify({ columns: cols, rows: rows });
					const bytes = textEncoder.encode(msg);
					this.wsTxBytes += bytes.length;
					ws.send(bytes);
				}
			}),
		);

		this.resizeObserver = new ResizeObserver(() => {
			this.scheduleFit();
		});
		this.resizeObserver.observe(wrapper);

		this.attachWebSocket(container, gen, /*isReconnect*/ false);
	}

	private attachWebSocket(container: HTMLElement, gen: number, isReconnect: boolean): void {
		const term = this.term;
		if (!term) return;

		// Tear down any prior socket listeners so close handlers don't fire twice.
		this.wsDispose?.();
		this.wsDispose = null;
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				/* already closing */
			}
		}

		const settings = this.getSettings();
		const wsUrl = buildWsUrl(settings.ttydPort, settings.ttydBindAddress);
		const ws = new WebSocket(wsUrl, ["tty"]);
		ws.binaryType = "arraybuffer";
		this.ws = ws;

		this.wsConnectStartedAt = Date.now();
		this.wsOpenedAt = 0;
		this.wsLastRxAt = 0;
		this.wsRxBytes = 0;
		this.wsTxBytes = 0;
		this.wsRxMsgs = 0;

		logger.info(
			"Terminal",
			`WebSocket connecting to ${wsUrl} (gen ${gen}, instance ${this.instanceId}${isReconnect ? `, reconnect attempt ${this.reconnectAttempt}` : ""})`,
		);

		const onOpen = () => {
			this.wsOpenedAt = Date.now();
			const connectMs = this.wsOpenedAt - this.wsConnectStartedAt;
			logger.info(
				"Terminal",
				`WebSocket open (gen ${gen}, instance ${this.instanceId}, connect ${connectMs}ms${isReconnect ? `, reconnect ${this.reconnectAttempt}` : ""})`,
			);
			this.logEvent(gen, "open", {
				at: this.wsOpenedAt,
				durationMs: connectMs,
				attempt: isReconnect ? this.reconnectAttempt : 0,
			});
			this.reconnectAttempt = 0;
			this.clearStatusBanner();

			const msg = JSON.stringify({ columns: term.cols, rows: term.rows });
			const handshake = textEncoder.encode(msg);
			this.wsTxBytes += handshake.length;
			ws.send(handshake);
			// Focus only on the initial attach, not on reconnect - reconnects
			// happen unattended and stealing focus interrupts whatever the user
			// has switched to.
			if (!isReconnect) term.focus();

			if (isReconnect) {
				// Tell user that the WS reconnected; tmux/bash already preserves
				// shell state on the container side so no command replay is needed.
				term.writeln("");
				term.writeln("\x1b[33m[agent-sandbox] terminal reconnected\x1b[0m");
				return;
			}

			// Inject the per-tab identity into the shell environment so
			// notify-status.sh can route status updates to this specific tab
			// rather than the shared DEFAULT_SESSION_KEY bucket. The value is
			// single-quoted (safe: tabKey only produces [A-Za-z0-9_-] chars).
			// Injected only on the initial attach; placing it above the
			// isReconnect return would risk typing `export ...` into a running
			// claude process inside a tmux reconnect.
			const tabExport = `export OAS_TAB_ID='${tabKey(this.instanceId)}'\n`;
			const tabExportId = window.setTimeout(() => {
				if (gen === this.generation) {
					this.wsTxBytes += sendInputText(ws, tabExport);
				}
			}, 300);
			this.injectionTimers.push(tabExportId);

			// Inject `session <name>` to attach to a tmux session. The 300ms
			// delay gives bash time to render the prompt.
			//
			// Defence-in-depth: validate the session name against the same
			// regex used for direct tmux exec (kill/rename) before sending
			// it down the wire. A hand-edited persisted view-state could
			// carry shell metacharacters that would otherwise execute in bash.
			if (this.sessionName && isValidSessionName(this.sessionName)) {
				const cmd = `session ${this.sessionName}\n`;
				const id = window.setTimeout(() => {
					if (gen === this.generation) {
						this.wsTxBytes += sendInputText(ws, cmd);
					}
				}, 300);
				this.injectionTimers.push(id);
			} else if (this.sessionName) {
				logger.warn(
					"Terminal",
					`Skipping session attach for invalid name '${this.sessionName}' - letters/digits/_/./-only.`,
				);
			}

			// Inject an initial Claude prompt (from "Analyse in Sandbox" / URI
			// handler). Runs after any session-attach command so it lands
			// inside the tmux session.
			//
			// Suppress terminal input during the wait window so a fast user
			// keystroke can't interleave with `claude '<escaped>'\n` and run
			// the injected command with extra bytes appended.
			if (this.initialPrompt) {
				// Collapse newlines before single-quoting. A literal `\n` inside
				// a single-quoted string sent over the pty is interpreted by
				// readline/cooked-mode as end-of-line, closing the line
				// without a closing quote and dropping bash into `>` (or
				// executing partial input). Prompt templates from
				// `.claude/prompts/*.md` can contain real newlines; flatten
				// to spaces so the injected command stays one line.
				const flat = this.initialPrompt.replace(/\r?\n/g, " ");
				const escaped = flat.replace(/'/g, `'\\''`);
				const cmd = `claude '${escaped}'\n`;
				const delay = this.sessionName ? 700 : 300;
				const wasStdinDisabled = term.options.disableStdin === true;
				term.options.disableStdin = true;
				const id = window.setTimeout(() => {
					try {
						if (gen !== this.generation) return;
						const sent = sendInputText(ws, cmd);
						if (sent > 0) {
							this.wsTxBytes += sent;
							this.initialPrompt = null;
						}
					} finally {
						// Re-enable input only on the still-current term - a fast
						// view close that swapped this.term must leave it alone.
						// Wrap the setter: dispose() races this timer and can
						// null `term.options` mid-call, throwing TypeError out
						// of the finally block.
						if (this.term === term) {
							try {
								term.options.disableStdin = wasStdinDisabled;
							} catch {
								/* term disposed before re-enable landed */
							}
						}
					}
				}, delay);
				this.injectionTimers.push(id);
			}
		};

		const onMessage = (event: MessageEvent) => {
			const rawData = event.data as ArrayBuffer;
			this.wsLastRxAt = Date.now();
			this.wsRxBytes += rawData.byteLength;
			this.wsRxMsgs++;
			// Guard against empty frames before peeking at byte 0 - some
			// proxies and ttyd debug builds emit zero-length data frames, and
			// `new Uint8Array(rawData, 0, 1)` throws RangeError on those.
			if (rawData.byteLength === 0) return;
			// Only OUTPUT carries terminal data; TITLE / PREFERENCES are ignored.
			if (new Uint8Array(rawData, 0, 1)[0] === SERVER_MSG.OUTPUT) {
				term.write(new Uint8Array(rawData, 1));
			}
		};

		const onClose = (event: CloseEvent) => {
			const now = Date.now();
			// Defence-in-depth guards first: a stale close fired after the
			// view closed (gen drift) or after attachWebSocket swapped
			// this.ws would log freshly-zeroed counters and confuse
			// observability. wsDispose normally prevents this.
			if (gen !== this.generation) return;
			if (this.ws !== ws) return;

			const opened = this.wsOpenedAt > 0;
			const sessionMs = opened ? now - this.wsOpenedAt : now - this.wsConnectStartedAt;
			const idleMs = this.wsLastRxAt > 0 ? now - this.wsLastRxAt : -1;
			const codeName = CLOSE_CODE_NAMES[event.code] ?? `code-${event.code}`;
			// ttyd close.reason can contain quotes/control chars - JSON-encode so
			// the surrounding log line isn't truncated by an embedded `"`.
			const reasonField = JSON.stringify(event.reason || "");
			const detail =
				`code=${event.code} (${codeName}) reason=${reasonField} wasClean=${event.wasClean} ` +
				`opened=${opened} sessionMs=${sessionMs} idleMsBeforeClose=${idleMs} ` +
				`rxBytes=${this.wsRxBytes} rxMsgs=${this.wsRxMsgs} txBytes=${this.wsTxBytes} ` +
				`gen=${gen} instance=${this.instanceId}`;
			// 1000 = normal closure, 1001 = going away. 1005 ("no status
			// received") is commonly emitted on abrupt drops (Wi-Fi switch,
			// container kill -9) and must reconnect - treating it as normal
			// would strand recoverable drops behind a "container may have
			// stopped" banner with no reconnect attempt.
			const normal = event.code === 1000 || event.code === 1001;
			if (normal) {
				logger.debug("Terminal", `WebSocket closed cleanly - ${detail}`);
			} else {
				logger.warn("Terminal", `WebSocket dropped - ${detail}`);
			}
			this.logEvent(gen, "close", {
				at: now,
				code: event.code,
				codeName,
				reason: event.reason || undefined,
				durationMs: sessionMs,
				rxBytes: this.wsRxBytes,
				txBytes: this.wsTxBytes,
				rxMsgs: this.wsRxMsgs,
				idleMsBeforeClose: idleMs >= 0 ? idleMs : undefined,
			});

			this.ws = null;

			if (normal) {
				// Server closed cleanly (e.g. container stop). Don't auto-reconnect.
				this.showError(container, "Connection closed. The container may have stopped.");
				return;
			}

			// Abnormal close - try to reconnect a few times before surfacing error.
			this.scheduleReconnect(container, gen);
		};

		const onError = () => {
			logger.error(
				"Terminal",
				`WebSocket error (gen ${gen}, instance ${this.instanceId}, url=${ws.url}, readyState=${ws.readyState})`,
			);
			this.logEvent(gen, "error");
		};

		ws.addEventListener("open", onOpen);
		ws.addEventListener("message", onMessage);
		ws.addEventListener("close", onClose);
		ws.addEventListener("error", onError);
		this.wsDispose = () => {
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("message", onMessage);
			ws.removeEventListener("close", onClose);
			ws.removeEventListener("error", onError);
		};
	}

	private scheduleReconnect(container: HTMLElement, gen: number): void {
		if (gen !== this.generation) return;
		const waitMs = reconnectDelayMs(this.reconnectAttempt);
		if (waitMs === null) {
			logger.warn(
				"Terminal",
				`Reconnect gave up after ${this.reconnectAttempt} attempts (instance ${this.instanceId})`,
			);
			this.showError(
				container,
				`Connection lost - could not reconnect after ${this.reconnectAttempt} attempts.`,
			);
			return;
		}
		this.reconnectAttempt++;
		this.showStatusBanner(
			`Connection dropped - reconnecting (attempt ${this.reconnectAttempt}/${RECONNECT_BACKOFF_MS.length}, in ${Math.round(waitMs / 100) / 10}s)…`,
		);
		this.logEvent(gen, "reconnect", { attempt: this.reconnectAttempt });
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (gen !== this.generation) return;
			this.attachWebSocket(container, gen, /*isReconnect*/ true);
		}, waitMs);
	}

	private showStatusBanner(text: string): void {
		const wrapper = this.contentEl.querySelector(".sandbox-terminal-container");
		if (!wrapper || !(wrapper instanceof HTMLElement)) return;
		if (!this.statusBanner) {
			this.statusBanner = wrapper.createDiv({
				cls: "sandbox-terminal-status",
			}) as HTMLDivElement;
		}
		this.statusBanner.setText(text);
	}

	private clearStatusBanner(): void {
		if (this.statusBanner) {
			this.statusBanner.remove();
			this.statusBanner = null;
		}
	}

	private dispose(): void {
		for (const d of this.termDisposables) d.dispose();
		this.termDisposables = [];
		this.wsDispose?.();
		this.wsDispose = null;
		if (this.reconnectTimer != null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		for (const id of this.injectionTimers) window.clearTimeout(id);
		this.injectionTimers = [];
		this.reconnectAttempt = 0;
		this.clearStatusBanner();
		if (this.resizeRafId != null) {
			cancelAnimationFrame(this.resizeRafId);
			this.resizeRafId = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.fitAddon) {
			this.fitAddon.dispose();
			this.fitAddon = null;
		}
		if (this.term) {
			// Deferred, not synchronous: xterm's Viewport schedules an internal
			// `setTimeout(() => this.syncScrollArea())` from term.open() (see
			// @xterm/xterm's browser/Viewport.ts) to run once ICharSizeService
			// is ready. If a leaf is closed within that same tick (e.g. another
			// plugin's startup leaf-launch racing our own), disposing here
			// synchronously clears RenderService's renderer before that
			// callback fires, and it throws reading `.dimensions` off the
			// cleared renderer - an uncaught TypeError outside any try/catch.
			// Queuing our dispose via setTimeout(0) always lands after xterm's
			// same-delay timeout (registered earlier, in term.open()), so the
			// scroll-area sync runs against a still-live terminal first.
			const term = this.term;
			window.setTimeout(() => term.dispose(), 0);
			this.term = null;
		}
		this.contentEl.empty();
	}
}
