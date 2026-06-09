import { requestUrl } from "obsidian";

const FETCH_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
	});
	// Swallow the loser's late rejection so it doesn't surface as an
	// unhandled-rejection warning when the timeout wins the race.
	promise.catch(() => undefined);
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolve the host part of a ttyd URL.
 *
 * `ttydBindAddress` controls where ttyd listens inside the container; the
 * plugin needs a reachable address to connect back to it.
 *
 * - `127.0.0.1` (default) and `0.0.0.0` both map to literal `127.0.0.1` -
 *   prefer the literal over `localhost` to avoid IPv6 resolution surprises
 *   (`::1` vs `127.0.0.1`) on IPv4-only hosts.
 * - Any other address (e.g. a LAN IP) is used verbatim.
 */
function resolveHost(bindAddress: string | undefined): string {
	const v = (bindAddress ?? "").trim();
	if (!v || v === "127.0.0.1" || v === "0.0.0.0") return "127.0.0.1";
	return v;
}

export async function pollUntilReady(
	port: number,
	maxRetries: number,
	backoff: number | ((attemptIdx: number) => number),
	isAborted: () => boolean,
	onAttempt?: (attemptIdx: number, waitMs: number) => void,
	bindAddress?: string,
): Promise<boolean> {
	const host = resolveHost(bindAddress);
	const url = `http://${host}:${port}`;
	for (let i = 0; i < maxRetries; i++) {
		if (isAborted()) return false;

		try {
			const resp = await withTimeout(
				requestUrl({ url, throw: false }),
				FETCH_TIMEOUT_MS,
				url,
			);
			if (resp.status === 200) {
				return true;
			}
		} catch {
			// Not ready yet
		}

		if (isAborted()) return false;

		// Skip the wait after the final attempt - no next iteration would see it.
		if (i === maxRetries - 1) break;
		const waitMs = typeof backoff === "number" ? backoff : backoff(i);
		onAttempt?.(i, waitMs);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
	return false;
}

/** Exponential backoff: 500 ms × 1.5^n, capped at 5 s. */
export function exponentialBackoff(attemptIdx: number): number {
	return Math.min(5000, Math.round(500 * Math.pow(1.5, attemptIdx)));
}

// Auto-reconnect schedule for abnormal WebSocket closes. The container is
// almost always still running; the WebSocket dropped from Obsidian sleep or
// a network hiccup. More patient than the initial-connect exponentialBackoff
// because reconnects happen during active use - a mid-session "could not
// reconnect" error is much more disruptive than a slow first connect.
export const RECONNECT_BACKOFF_MS: readonly number[] = [
	500, 1000, 2000, 4000, 8000, 8000, 8000, 8000,
];

/**
 * Delay before the next reconnect, given the number of attempts already
 * made. Returns null when the schedule is exhausted and the caller should
 * surface a terminal error instead of retrying.
 */
export function reconnectDelayMs(attemptsMade: number): number | null {
	return attemptsMade >= RECONNECT_BACKOFF_MS.length ? null : RECONNECT_BACKOFF_MS[attemptsMade];
}

export function buildWsUrl(port: number, bindAddress?: string): string {
	return `ws://${resolveHost(bindAddress)}:${port}/ws`;
}

/**
 * Build the browser-facing ttyd URL for "Open in Browser" / status-bar menu.
 *
 * Uses `localhost` (not `127.0.0.1`) for loopback/unset addresses so the URL
 * is valid in browsers that may not resolve bare IP literals as localhost.
 * LAN IPs are used verbatim (same logic as `resolveHost`, different loopback
 * representation).
 */
export function resolveTtydBrowserUrl(port: number, bindAddress: string | undefined): string {
	const v = (bindAddress ?? "").trim();
	const host = !v || v === "127.0.0.1" || v === "0.0.0.0" || v === "::1" ? "localhost" : v;
	return `http://${host}:${port}`;
}

// '0' in ASCII - prefixed to every client→PTY INPUT frame.
const INPUT_CMD = 0x30;

/**
 * Encode `text` as one or more ttyd INPUT frames, each at most `chunkBytes`
 * payload bytes (default 16 KiB). Chunking prevents `message-too-big` (1009)
 * disconnects on large pastes.
 *
 * Always returns at least one frame. Frames preserve byte order.
 */
export function encodeInputFrames(text: string, chunkBytes = 16 * 1024): Uint8Array<ArrayBuffer>[] {
	const bytes = new TextEncoder().encode(text);
	const frames: Uint8Array<ArrayBuffer>[] = [];
	let off = 0;
	do {
		const slice = bytes.subarray(off, off + chunkBytes);
		const frame = new Uint8Array(slice.length + 1);
		frame[0] = INPUT_CMD;
		frame.set(slice, 1);
		frames.push(frame);
		off += chunkBytes;
	} while (off < bytes.length);
	return frames;
}
